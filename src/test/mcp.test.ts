import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isAbortError } from "../llm/http";
import { PermissionPolicy } from "../agent/permissions";
import { toolsFor, toolSets } from "../agent/tools";
import { McpClient } from "../mcp/client";
import { McpServerConfig, expandVars, fingerprint, parseServers } from "../mcp/config";
import { McpManager } from "../mcp/manager";
import { createMcpTool, mcpToolName, normalizeSchema, renderResult } from "../mcp/tools";

/** A stdio MCP server with just enough behaviour to exercise the client. */
const FIXTURE_SERVER = String.raw`
const tools = [
  { name: "echo", description: "Echoes text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
  { name: "hang", description: "Never answers.", inputSchema: { type: "object", properties: {} } },
  { name: "crash", description: "Exits the process.", inputSchema: { type: "object", properties: {} } },
  { name: "state", description: "Reports what the server has seen.", inputSchema: { type: "object", properties: {} } },
];
const cancels = [];
let pingReplied = false;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const text = (t, extra) => ({ content: [{ type: "text", text: t }], ...extra });

process.stdout.write("this line is not JSON\n");
process.stderr.write("fixture ready\n");

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(m) {
  if (m.id === "s1" && m.result) { pingReplied = true; return; }
  switch (m.method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" }, instructions: "Use echo for testing." } });
    case "notifications/initialized":
      return send({ jsonrpc: "2.0", id: "s1", method: "ping" });
    case "notifications/cancelled":
      cancels.push(m.params.requestId);
      return;
    case "tools/list":
      return m.params && m.params.cursor === "p2"
        ? send({ jsonrpc: "2.0", id: m.id, result: { tools: tools.slice(2) } })
        : send({ jsonrpc: "2.0", id: m.id, result: { tools: tools.slice(0, 2), nextCursor: "p2" } });
    case "tools/call": {
      const { name, arguments: args } = m.params;
      if (name === "echo") return send({ jsonrpc: "2.0", id: m.id, result: text("echo: " + args.text) });
      if (name === "fail") return send({ jsonrpc: "2.0", id: m.id, result: text("it broke", { isError: true }) });
      if (name === "hang") return;
      if (name === "crash") { process.stderr.write("about to crash\n"); process.exit(3); }
      if (name === "state") return send({ jsonrpc: "2.0", id: m.id, result: { content: [], structuredContent: { cancels, pingReplied, cwd: process.cwd(), env: process.env.FIXTURE_VAR || null, argv: process.argv.slice(2) } } });
      return send({ jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "Unknown tool: " + name } });
    }
    default:
      if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
  }
}
`;

let fixtureDir: string;
let serverScript: string;
const clients: McpClient[] = [];
const noLog = () => undefined;

/** The test host runs inside Code.exe, so find the real node binary for the fixture. */
const nodeExe = (() => {
  if (/node(\.exe)?$/i.test(process.execPath)) {
    return process.execPath;
  }
  const found = execFileSync(process.platform === "win32" ? "where" : "which", ["node"], { encoding: "utf8" });
  return found.split(/\r?\n/)[0].trim();
})();

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "fixture",
    command: nodeExe,
    args: [serverScript],
    env: { FIXTURE_VAR: "from-config" },
    cwd: fixtureDir,
    source: "user",
    origin: "test",
    ...overrides,
  };
}

async function started(config = server()): Promise<McpClient> {
  const client = new McpClient(config, noLog);
  clients.push(client);
  await client.start(20_000);
  return client;
}

async function state(client: McpClient): Promise<{ cancels: number[]; pingReplied: boolean; cwd: string; env: string | null; argv: string[] }> {
  const result = await client.callTool("state", {}, new AbortController().signal, 5000);
  return result.structuredContent as never;
}

suite("MCP: client", () => {
  suiteSetup(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "gbs-mcp-"));
    serverScript = path.join(fixtureDir, "server.js");
    fs.writeFileSync(serverScript, FIXTURE_SERVER);
  });

  suiteTeardown(() => {
    for (const client of clients) {
      client.dispose();
    }
  });

  test("handshake, paginated tool list, calls and tool errors", async () => {
    const client = await started();
    assert.strictEqual(client.state, "ready");
    assert.strictEqual(client.serverName, "fixture");
    assert.strictEqual(client.instructions, "Use echo for testing.");

    const tools = await client.listTools(5000);
    assert.deepStrictEqual(
      tools.map((t) => t.name),
      ["echo", "fail", "hang", "crash", "state"],
    );

    const echo = await client.callTool("echo", { text: "hi" }, new AbortController().signal, 5000);
    assert.strictEqual(renderResult(echo), "echo: hi");
    const fail = await client.callTool("fail", {}, new AbortController().signal, 5000);
    assert.strictEqual(fail.isError, true);
    await assert.rejects(client.callTool("nope", {}, new AbortController().signal, 5000), /Unknown tool: nope/);

    const seen = await state(client);
    assert.strictEqual(seen.pingReplied, true, "answers the server's ping");
    assert.strictEqual(seen.env, "from-config", "passes the configured environment");
    assert.strictEqual(fs.realpathSync(seen.cwd).toLowerCase(), fs.realpathSync(fixtureDir).toLowerCase());
  });

  test("stopping the agent cancels the request and tells the server", async () => {
    const client = await started();
    const abort = new AbortController();
    const call = client.callTool("hang", {}, abort.signal, 20_000);
    setTimeout(() => abort.abort(), 100);
    await assert.rejects(call, (err) => isAbortError(err));
    const seen = await state(client);
    assert.strictEqual(seen.cancels.length, 1);
  });

  test("a call that never answers times out", async () => {
    const client = await started();
    await assert.rejects(client.callTool("hang", {}, new AbortController().signal, 300), /did not answer tools\/call/);
  });

  test("a crash fails pending calls and marks the server failed", async () => {
    const client = await started();
    await assert.rejects(client.callTool("crash", {}, new AbortController().signal, 5000), /exited with code 3/);
    assert.strictEqual(client.state, "failed");
    assert.match(client.error ?? "", /about to crash/);
    await assert.rejects(client.callTool("echo", { text: "x" }, new AbortController().signal, 5000), /exited with code 3/);
  });

  test("a missing command is reported clearly", async () => {
    const client = new McpClient(server({ command: "definitely-not-a-real-mcp-server" }), noLog);
    clients.push(client);
    await assert.rejects(client.start(5000), /Command not found: definitely-not-a-real-mcp-server/);
    assert.strictEqual(client.state, "failed");
  });

  test("Windows: .cmd shims start through cmd.exe, with spaces in paths and arguments", async function () {
    if (process.platform !== "win32") {
      this.skip();
    }
    const dir = path.join(fixtureDir, "with space");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(serverScript, path.join(dir, "server.js"));
    const shim = path.join(dir, "fixture-mcp.cmd");
    fs.writeFileSync(shim, `@echo off\r\n"${nodeExe}" "%~dp0server.js" %*\r\n`);

    const client = await started(server({ command: shim, args: ["--flag", "a b", 'say "hi"'] }));
    const seen = await state(client);
    assert.deepStrictEqual(seen.argv, ["--flag", "a b", 'say "hi"']);
  });
});

suite("MCP: tools, config and permissions", () => {
  test("tool names are valid function names and stay within 64 characters", () => {
    assert.strictEqual(mcpToolName("grampro", "get_component"), "mcp__grampro__get_component");
    assert.strictEqual(mcpToolName("my server", "do.thing"), "mcp__my_server__do_thing");
    const long = mcpToolName("server", "x".repeat(100));
    assert.ok(long.length <= 64);
    assert.match(long, /^[A-Za-z0-9_-]+$/);
    assert.notStrictEqual(long, mcpToolName("server", "x".repeat(101)), "different long names do not collide");
  });

  test("schemas are made object schemas without $schema", () => {
    assert.deepStrictEqual(normalizeSchema(undefined), { type: "object", properties: {} });
    const schema = normalizeSchema({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string" } }, anyOf: [] });
    assert.strictEqual((schema as unknown as Record<string, unknown>).$schema, undefined);
    assert.deepStrictEqual((schema as unknown as Record<string, unknown>).anyOf, [], "other keywords pass through");
  });

  test("results flatten to text", () => {
    assert.strictEqual(renderResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\n\nb");
    assert.strictEqual(renderResult({ content: [{ type: "image", mimeType: "image/png" }] }), "[image content (image/png) omitted]");
    assert.strictEqual(renderResult({ content: [], structuredContent: { ok: true } }), '{\n  "ok": true\n}');
    assert.strictEqual(renderResult(undefined), "(no output)");
  });

  test("config: stdio entries parse, others are skipped, variables expand", () => {
    process.env.GBS_MCP_TEST = "expanded";
    const { servers, warnings } = parseServers(
      {
        mcpServers: {
          grampro: { command: "npx", args: ["-y", "@grampro/kit", "mcp"], env: { TOKEN: "${GBS_MCP_TEST}", OTHER: "${GBS_MCP_MISSING:-fallback}" } },
          remote: { type: "http", url: "https://example.com/mcp" },
          off: { command: "node", disabled: true },
          broken: { args: [] },
        },
      },
      "project",
      ".mcp.json",
      "/work",
    );
    assert.deepStrictEqual(
      servers.map((s) => s.name),
      ["grampro"],
    );
    assert.deepStrictEqual(servers[0].env, { TOKEN: "expanded", OTHER: "fallback" });
    assert.strictEqual(servers[0].cwd, "/work");
    assert.strictEqual(warnings.length, 2, warnings.join("\n"));
    assert.strictEqual(expandVars("${GBS_MCP_MISSING}"), "");
  });

  test("consent fingerprint changes when what would run changes", () => {
    const a = server();
    assert.strictEqual(fingerprint([a]), fingerprint([{ ...a, origin: "elsewhere" }]));
    assert.notStrictEqual(fingerprint([a]), fingerprint([{ ...a, args: [...a.args, "--extra"] }]));
    assert.notStrictEqual(fingerprint([a]), fingerprint([{ ...a, env: { FIXTURE_VAR: "other" } }]));
  });

  test("permissions: MCP calls ask unless auto, and always-allow covers one tool", () => {
    const policy = new PermissionPolicy();
    const echo = { kind: "mcp" as const, detail: "fixture · echo" };
    const fail = { kind: "mcp" as const, detail: "fixture · fail" };
    assert.strictEqual(policy.needsApproval(echo, "acceptEdits"), true);
    assert.strictEqual(policy.needsApproval(echo, "ask"), true);
    assert.strictEqual(policy.needsApproval(echo, "auto"), false);
    assert.strictEqual(policy.describeAlways(echo), "Always allow fixture · echo this session");
    policy.allowAlways(echo);
    assert.strictEqual(policy.needsApproval(echo, "acceptEdits"), false);
    assert.strictEqual(policy.needsApproval(fail, "acceptEdits"), true);
    policy.reset();
    assert.strictEqual(policy.needsApproval(echo, "acceptEdits"), true);

    for (const file of [".mcp.json", ".gbs/mcp.json"]) {
      assert.strictEqual(policy.needsApproval({ kind: "edit", detail: `Write ${file}`, path: file }, "acceptEdits"), true, file);
    }
  });

  test("toolsFor: MCP tools are added, explore gets only read-only ones", () => {
    const client = new McpClient(server(), noLog);
    const readOnly = createMcpTool(client, { name: "echo", annotations: { readOnlyHint: true } }, 1000);
    const writes = createMcpTool(client, { name: "install" }, 1000);
    assert.strictEqual(toolsFor("main").length, toolSets.main.length, "unchanged without MCP tools");
    assert.deepStrictEqual(
      toolsFor("main", undefined, [readOnly, writes]).slice(-2).map((t) => t.name),
      ["mcp__fixture__echo", "mcp__fixture__install"],
    );
    const explore = toolsFor("explore", undefined, [readOnly, writes]).map((t) => t.name);
    assert.ok(explore.includes("mcp__fixture__echo"));
    assert.ok(!explore.includes("mcp__fixture__install"));
    assert.deepStrictEqual(writes.permission?.({ package: "x" }), {
      kind: "mcp",
      detail: "fixture · install",
      preview: '{\n  "package": "x"\n}',
    });
  });
});

suite("MCP: manager", () => {
  test("starts servers, reports a failure once, restarts on config change", async () => {
    const manager = new McpManager(noLog);
    try {
      const good = server({ name: "good" });
      const bad = server({ name: "bad", command: "definitely-not-a-real-mcp-server" });

      const first = await manager.tools([good, bad], 5000);
      assert.deepStrictEqual(
        first.tools.map((t) => t.name),
        ["mcp__good__echo", "mcp__good__fail", "mcp__good__hang", "mcp__good__crash", "mcp__good__state"],
      );
      assert.deepStrictEqual(
        first.newlyFailed.map((f) => f.name),
        ["bad"],
      );
      assert.strictEqual(first.instructions.get("good"), "Use echo for testing.");

      const second = await manager.tools([good, bad], 5000);
      assert.strictEqual(second.newlyFailed.length, 0, "a known failure is not reported again");
      assert.strictEqual(second.tools.length, 5);

      const status = manager.status([good, bad]);
      assert.deepStrictEqual(
        status.map((s) => s.state),
        ["ready", "failed"],
      );

      const changed = await manager.tools([{ ...good, env: { FIXTURE_VAR: "changed" } }], 5000);
      const echoed = await changed.tools.find((t) => t.name === "mcp__good__state")!.execute({}, {
        signal: new AbortController().signal,
      } as never);
      assert.match(echoed.content, /"env": "changed"/, "a changed config restarts the server");
      assert.strictEqual(manager.status([bad])[0].state, "closed", "a removed server is stopped");
    } finally {
      manager.dispose();
    }
  });
});
