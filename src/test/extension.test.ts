import * as assert from "assert";
import * as http from "http";
import * as vscode from "vscode";
import { collectDiagnostics } from "../agent/diagnostics";
import { SnapshotStore } from "../agent/snapshots";
import { toolSets } from "../agent/tools";
import { editFileTool } from "../agent/tools/editFile";
import { readFileTool } from "../agent/tools/readFile";
import { globTool, grepTool, listDirTool } from "../agent/tools/search";
import { ToolContext } from "../agent/tools/types";
import { writeFileTool } from "../agent/tools/writeFile";
import { TranscriptItem } from "../agent/transcript";
import { resolvePath } from "../agent/workspace";
import { SessionController } from "../session/controller";
import { SessionStore } from "../session/store";

const root = () => vscode.workspace.workspaceFolders![0].uri;

function toolContext(changed: vscode.Uri[] = []): ToolContext {
  return {
    signal: new AbortController().signal,
    state: { readVersions: new Map() },
    itemId: "test",
    fileChanged: (uri) => changed.push(uri),
    host: {
      config: { commandTimeoutSeconds: 30, shell: "", maxToolOutputChars: 20000 } as never,
      setTodos: () => undefined,
      runSubagent: async () => "",
      recordFileChange: () => "snap",
      updateItem: () => undefined,
      createProvider: () => {
        throw new Error("not used");
      },
    },
  };
}

async function readDisk(rel: string): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root(), rel)));
}

suite("Tools (real VS Code APIs)", () => {
  test("extension activates and registers commands", async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "gbs-software-agent");
    assert.ok(ext, "extension not found");
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ["gbsAgent.newChat", "gbsAgent.stop", "gbsAgent.setApiKey", "gbsAgent.showLogs"]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  test("write → read → edit round trip with read-before-edit guard", async () => {
    const ctx = toolContext();
    const created = await writeFileTool.execute({ path: "src/greet.ts", content: "export const greet = () => 'hi';\n" }, ctx);
    assert.ok(created.content.startsWith("Created src/greet.ts"), created.content);

    const fresh = toolContext();
    const blocked = await editFileTool.execute({ path: "src/greet.ts", old_string: "'hi'", new_string: "'hello'" }, fresh);
    assert.ok(blocked.isError && blocked.content.includes("must read"), blocked.content);

    const read = await readFileTool.execute({ path: "src/greet.ts" }, fresh);
    assert.strictEqual(read.content, "1\texport const greet = () => 'hi';\n2\t");

    const edited = await editFileTool.execute({ path: "src/greet.ts", old_string: "'hi'", new_string: "'hello'" }, fresh);
    assert.ok(!edited.isError, edited.content);
    assert.deepStrictEqual(edited.ui?.stats, { added: 1, removed: 1 });
    assert.strictEqual(await readDisk("src/greet.ts"), "export const greet = () => 'hello';\n");

    // A second edit works without re-reading (the tool refreshes its own version token).
    const again = await editFileTool.execute({ path: "src/greet.ts", old_string: "'hello'", new_string: "'hey'" }, fresh);
    assert.ok(!again.isError, again.content);
  });

  test("edits are rejected when the file changed after the last read", async () => {
    const ctx = toolContext();
    await readFileTool.execute({ path: "src/math.ts" }, ctx);
    await new Promise((r) => setTimeout(r, 20));
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(root(), "src/math.ts"),
      new TextEncoder().encode("export function add(a: number, b: number): number {\n  return b + a;\n}\n"),
    );
    const result = await editFileTool.execute({ path: "src/math.ts", old_string: "b + a", new_string: "a + b" }, ctx);
    assert.ok(result.isError && result.content.includes("changed since you last read"), result.content);
  });

  test("edits go through the editor buffer when the file is open", async () => {
    const uri = vscode.Uri.joinPath(root(), "README.md");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const ctx = toolContext();
    await readFileTool.execute({ path: "README.md" }, ctx);
    const result = await editFileTool.execute({ path: "README.md", old_string: "# Fixture", new_string: "# Fixture project" }, ctx);
    assert.ok(!result.isError, result.content);
    assert.strictEqual(doc.getText(), "# Fixture project\n");
    assert.strictEqual(doc.isDirty, false);
    assert.strictEqual(await readDisk("README.md"), "# Fixture project\n");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("paths outside the workspace are refused", async () => {
    assert.throws(() => resolvePath("../outside.txt"), /outside the workspace/);
    await assert.rejects(writeFileTool.execute({ path: "../../evil.txt", content: "x" }, toolContext()), /outside the workspace/);
  });

  test("glob, list_dir and grep", async () => {
    const ctx = toolContext();
    const glob = await globTool.execute({ pattern: "**/*.ts" }, ctx);
    assert.ok(glob.content.includes("src/math.ts"), glob.content);
    const list = await listDirTool.execute({}, ctx);
    assert.ok(list.content.includes("src/") && list.content.includes("README.md"), list.content);
    const grep = await grepTool.execute({ pattern: "function add", output_mode: "content" }, ctx);
    assert.match(grep.content, /src\/math\.ts:1:export function add/);
  });

  test("diagnostics are collected for edited files", async function () {
    this.timeout(90000);
    const changed: vscode.Uri[] = [];
    const ctx = toolContext(changed);
    await writeFileTool.execute({ path: "src/broken.ts", content: "const n: number = 'not a number';\nexport default n;\n" }, ctx);
    const uri = changed[0];
    await vscode.window.showTextDocument(uri);

    // The TypeScript server can take a while to start in a fresh test instance; skip if it never reports.
    const start = Date.now();
    while (vscode.languages.getDiagnostics(uri).length === 0 && Date.now() - start < 60000) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (vscode.languages.getDiagnostics(uri).length === 0) {
      this.skip();
    }
    const report = await collectDiagnostics(changed, new AbortController().signal);
    assert.ok(report.includes("src/broken.ts:1") && report.includes("<diagnostics>"), `expected a type error, got: ${report || "(none)"}`);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
});

// ─── End-to-end: controller + agent + Ollama provider + tools ────────────────

type Responder = (body: any) => object[];

function ndjson(res: http.ServerResponse, chunks: object[]) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  for (const c of chunks) {
    res.write(JSON.stringify(c) + "\n");
  }
  res.end();
}

const say = (text: string) => [{ message: { role: "assistant", content: text } }, { done: true, prompt_eval_count: 500, eval_count: 20 }];
const call = (name: string, args: object) => [
  { message: { role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] } },
  { done: true, prompt_eval_count: 400, eval_count: 15 },
];

async function withMockOllama(responder: Responder, run: (requests: any[]) => Promise<void>) {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      const body = JSON.parse(data);
      requests.push(body);
      ndjson(res, responder(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const config = vscode.workspace.getConfiguration("gbsAgent");
  await config.update("provider", "ollama", vscode.ConfigurationTarget.Workspace);
  await config.update("ollama.baseUrl", `http://127.0.0.1:${port}`, vscode.ConfigurationTarget.Workspace);
  await config.update("model", "mock-model", vscode.ConfigurationTarget.Workspace);
  try {
    await run(requests);
  } finally {
    server.close();
  }
}

function createController() {
  const memento = new Map<string, unknown>();
  const workspaceState = {
    get: (key: string, fallback?: unknown) => (memento.has(key) ? memento.get(key) : fallback),
    update: async (key: string, value: unknown) => void memento.set(key, value),
    keys: () => [...memento.keys()],
  } as unknown as vscode.Memento;
  const context = { secrets: { get: async () => undefined, store: async () => undefined } } as unknown as vscode.ExtensionContext;
  const output = vscode.window.createOutputChannel("GBS Agent Test");
  const controller = new SessionController(context, new SessionStore(workspaceState), new SnapshotStore(), output);
  const posts: any[] = [];
  controller.attachView({ post: (m) => posts.push(m), isVisible: () => true, reveal: () => undefined });
  return { controller, posts };
}

async function waitForIdle(posts: any[], timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const last = [...posts].reverse().find((p) => p.type === "running");
    if (last && last.running === false) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("agent did not finish in time");
}

function transcript(posts: any[]): Map<string, TranscriptItem> {
  const items = new Map<string, TranscriptItem>();
  for (const p of posts) {
    if (p.type === "init") {
      items.clear();
      p.items.forEach((i: TranscriptItem) => items.set(i.id, i));
    }
    if (p.type === "patch") {
      p.items.forEach((i: TranscriptItem) => items.set(i.id, JSON.parse(JSON.stringify(i))));
      p.removed.forEach((id: string) => items.delete(id));
    }
  }
  return items;
}

suite("Agent end-to-end (mock Ollama)", () => {
  test("creates a file via native tool calls and reports a turn summary", async () => {
    await withMockOllama(
      (body) => {
        const toolResults = body.messages.filter((m: any) => m.role === "tool");
        return toolResults.length === 0 ? call("write_file", { path: "hello.txt", content: "hello world\n" }) : say("Created `hello.txt`.");
      },
      async (requests) => {
        const { controller, posts } = createController();
        await controller.handleMessage({ type: "ready" });
        await controller.handleMessage({ type: "send", text: "create hello.txt", includeEditor: false });
        await waitForIdle(posts);

        assert.strictEqual(await readDisk("hello.txt"), "hello world\n");
        assert.strictEqual(requests.length, 2);
        assert.strictEqual(requests[0].tools.length, toolSets.main.length);
        assert.strictEqual(requests[1].messages.at(-1).role, "tool");
        // The system prompt is identical across steps (prefix-cache friendly).
        assert.strictEqual(requests[0].messages[0].content, requests[1].messages[0].content);

        const items = [...transcript(posts).values()];
        const tool = items.find((i) => i.kind === "tool");
        assert.ok(tool && tool.kind === "tool" && tool.status === "done" && tool.path === "hello.txt");
        const answer = items.find((i) => i.kind === "assistant");
        assert.ok(answer && answer.kind === "assistant" && answer.text.includes("Created"));
        const summary = items.find((i) => i.kind === "summary");
        assert.ok(summary && summary.kind === "summary" && summary.files[0]?.path === "hello.txt" && summary.files[0].created);
        controller.dispose();
      },
    );
  });

  test("runs explore subagents in parallel and nests their tool calls", async () => {
    await withMockOllama(
      (body) => {
        const system: string = body.messages[0].content;
        const toolResults = body.messages.filter((m: any) => m.role === "tool");
        if (system.includes("read-only code exploration subagent")) {
          assert.ok(!body.tools.some((t: any) => ["edit_file", "write_file", "run_command", "task"].includes(t.function.name)));
          return toolResults.length === 0 ? call("grep", { pattern: "function add" }) : say("`add` is defined in src/math.ts:1");
        }
        if (toolResults.length === 0) {
          return [
            {
              message: {
                role: "assistant",
                content: "Investigating.",
                tool_calls: [
                  { function: { name: "task", arguments: { description: "Find add", prompt: "Where is add defined?" } } },
                  { function: { name: "task", arguments: { description: "Find add again", prompt: "Where is add defined? (2)" } } },
                ],
              },
            },
            { done: true, prompt_eval_count: 300, eval_count: 30 },
          ];
        }
        assert.ok(toolResults.every((t: any) => t.content.includes("src/math.ts:1")));
        return say("`add` lives in `src/math.ts:1`.");
      },
      async () => {
        const { controller, posts } = createController();
        await controller.handleMessage({ type: "ready" });
        await controller.handleMessage({ type: "send", text: "where is add?", includeEditor: false });
        await waitForIdle(posts);

        const items = [...transcript(posts).values()];
        const agents = items.filter((i) => i.kind === "tool" && i.name === "task");
        assert.strictEqual(agents.length, 2);
        for (const agent of agents) {
          assert.ok(agent.kind === "tool" && agent.status === "done" && agent.subagent?.toolUses === 1, JSON.stringify(agent));
          const children = items.filter((i) => i.kind === "tool" && i.parentId === agent.id);
          assert.strictEqual(children.length, 1);
        }
        controller.dispose();
      },
    );
  });

  test("stop cancels a run that is waiting for command approval", async () => {
    await withMockOllama(
      (body) =>
        body.messages.some((m: any) => m.role === "tool") ? say("ok") : call("run_command", { command: "npm publish" }),
      async () => {
        const { controller, posts } = createController();
        await controller.handleMessage({ type: "ready" });
        await controller.handleMessage({ type: "send", text: "publish", includeEditor: false });
        const start = Date.now();
        while (![...transcript(posts).values()].some((i) => i.kind === "tool" && i.status === "awaiting")) {
          assert.ok(Date.now() - start < 10000, "never asked for approval");
          await new Promise((r) => setTimeout(r, 50));
        }
        await controller.handleMessage({ type: "stop" });
        await waitForIdle(posts);
        const items = [...transcript(posts).values()];
        assert.ok(items.some((i) => i.kind === "tool" && i.status === "cancelled"));
        assert.ok(items.some((i) => i.kind === "notice" && i.text === "Stopped."));
        controller.dispose();
      },
    );
  });
});
