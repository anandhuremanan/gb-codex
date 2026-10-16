import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { CancelledError } from "../llm/http";
import { McpServerConfig } from "./config";

/**
 * A minimal MCP client over stdio: newline-delimited JSON-RPC 2.0 to a child process.
 * It covers what the agent needs (initialize, tools/list, tools/call, cancellation) and
 * answers the few requests a server may send back. No SDK, like the rest of the extension.
 */

const PROTOCOL_VERSION = "2025-06-18";
const KNOWN_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
/** A single message larger than this means the server is not speaking the protocol. */
const MAX_LINE_CHARS = 32 * 1024 * 1024;
const STDERR_TAIL_LINES = 20;
const MAX_TOOL_PAGES = 20;

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}

export interface McpContent {
  type: string;
  text?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
}

export interface McpCallResult {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type McpClientState = "starting" | "ready" | "failed" | "closed";

interface Pending {
  resolve(result: unknown): void;
  reject(err: Error): void;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export class McpClient {
  state: McpClientState = "starting";
  error?: string;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  instructions?: string;
  /** Set when the server says its tool list changed; the next `listTools` re-reads it. */
  toolsStale = true;

  private child?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private readonly stderrTail: string[] = [];
  private exited = false;

  constructor(
    readonly config: McpServerConfig,
    private readonly log: (message: string) => void,
  ) {}

  /** Starts the process and completes the initialize handshake. */
  async start(timeoutMs: number): Promise<void> {
    try {
      this.spawn();
      const result = (await this.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "gbs-software-agent", version: "1" },
        },
        { timeoutMs },
      )) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string }; instructions?: string };

      this.protocolVersion = result?.protocolVersion;
      this.serverName = result?.serverInfo?.name;
      this.serverVersion = result?.serverInfo?.version;
      this.instructions = typeof result?.instructions === "string" ? result.instructions : undefined;
      if (this.protocolVersion && !KNOWN_PROTOCOLS.has(this.protocolVersion)) {
        this.log(`[mcp:${this.config.name}] server answered with protocol ${this.protocolVersion}; continuing`);
      }
      this.notify("notifications/initialized");
      this.state = "ready";
    } catch (err) {
      if (this.state !== "failed") {
        this.fail(err instanceof Error ? err.message : String(err));
      }
      this.dispose(); // a server that never finished the handshake should not linger
      throw err;
    }
  }

  async listTools(timeoutMs: number): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {}, { timeoutMs })) as {
        tools?: unknown;
        nextCursor?: unknown;
      };
      if (Array.isArray(result?.tools)) {
        for (const tool of result.tools) {
          if (tool && typeof tool === "object" && typeof (tool as McpToolInfo).name === "string") {
            tools.push(tool as McpToolInfo);
          }
        }
      }
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) {
        break;
      }
    }
    this.toolsStale = false;
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<McpCallResult> {
    return (await this.request("tools/call", { name, arguments: args }, { signal, timeoutMs })) as McpCallResult;
  }

  /** Closes stdin (servers exit on EOF) and kills the process tree if it does not. */
  dispose(): void {
    if (this.state !== "failed") {
      this.state = "closed";
    }
    this.rejectAll(new McpError(`MCP server "${this.config.name}" was stopped.`));
    const child = this.child;
    if (!child || this.exited) {
      return;
    }
    try {
      child.stdin?.end();
    } catch {
      // already closed
    }
    const timer = setTimeout(() => {
      if (!this.exited) {
        killTree(child);
      }
    }, 2000);
    timer.unref?.();
  }

  get stderr(): string {
    return this.stderrTail.join("\n");
  }

  // ─── Process and wire ───────────────────────────────────────────────────────

  private spawn(): void {
    const env = { ...process.env, ...this.config.env };
    const { file, args, verbatim } = resolveCommand(this.config.command, this.config.args, env);
    this.log(`[mcp:${this.config.name}] starting: ${[file, ...args].join(" ")} (cwd ${this.config.cwd})`);
    const child = spawn(file, args, {
      cwd: this.config.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) {
          this.stderrTail.push(line.slice(0, 500));
          if (this.stderrTail.length > STDERR_TAIL_LINES) {
            this.stderrTail.shift();
          }
          this.log(`[mcp:${this.config.name}] ${line.slice(0, 500)}`);
        }
      }
    });
    child.stdin?.on("error", () => undefined); // EPIPE when the server has gone; the exit handler reports it
    child.on("error", (err: NodeJS.ErrnoException) => {
      const message =
        err.code === "ENOENT"
          ? `Command not found: ${this.config.command}. Check that it is installed and on PATH.`
          : `Could not start: ${err.message}`;
      this.onExit(message);
    });
    child.on("exit", (code, signal) => {
      const how = signal ? `was killed (${signal})` : `exited with code ${code}`;
      const tail = this.stderrTail.slice(-5).join("\n");
      this.onExit(`MCP server "${this.config.name}" ${how}.${tail ? `\n${tail}` : ""}`);
    });
  }

  private onExit(message: string): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    if (this.state !== "closed") {
      this.fail(message);
    }
    this.rejectAll(new McpError(message));
  }

  private fail(message: string): void {
    this.state = "failed";
    this.error = message;
    this.log(`[mcp:${this.config.name}] ${message}`);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.buffer = "";
      this.fail(`MCP server "${this.config.name}" sent a message over ${MAX_LINE_CHARS} characters; stopping it.`);
      this.dispose();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line);
      } catch {
        // Servers sometimes log to stdout by mistake; that is noise, not a protocol message.
        this.log(`[mcp:${this.config.name}] (stdout, not JSON) ${line.slice(0, 300)}`);
        continue;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: JsonRpcMessage): void {
    if (message.method) {
      if (message.id !== undefined && message.id !== null) {
        // A request from the server. Answer ping; decline the rest (we offer no client capabilities).
        if (message.method === "ping") {
          this.write({ jsonrpc: "2.0", id: message.id, result: {} });
        } else {
          this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not supported: ${message.method}` } });
        }
        return;
      }
      if (message.method === "notifications/tools/list_changed") {
        this.toolsStale = true;
      } else if (message.method === "notifications/message") {
        const data = message.params?.data;
        this.log(`[mcp:${this.config.name}] ${typeof data === "string" ? data : JSON.stringify(data)}`.slice(0, 600));
      }
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return; // a reply to a request we already gave up on
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new McpError(message.error.message || "MCP error", message.error.code));
    } else {
      pending.resolve(message.result);
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<unknown> {
    if (this.exited || !this.child) {
      return Promise.reject(new McpError(this.error ?? `MCP server "${this.config.name}" is not running.`));
    }
    const { signal, timeoutMs } = options;
    if (signal?.aborted) {
      return Promise.reject(new CancelledError());
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const cancel = (reason: string) => {
        if (this.pending.has(id)) {
          this.notify("notifications/cancelled", { requestId: id, reason });
        }
        cleanup();
      };
      const onAbort = () => {
        cancel("The user stopped the agent.");
        reject(new CancelledError());
      };
      const timer = setTimeout(() => {
        cancel("Timed out.");
        reject(new McpError(`MCP server "${this.config.name}" did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.write(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method });
  }

  private write(message: JsonRpcMessage): void {
    if (this.exited || !this.child?.stdin?.writable) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectAll(err: Error): void {
    for (const pending of [...this.pending.values()]) {
      pending.reject(err);
    }
    this.pending.clear();
  }
}

function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => undefined);
  } else {
    child.kill("SIGTERM");
  }
}

// ─── Command resolution ─────────────────────────────────────────────────────

interface ResolvedCommand {
  file: string;
  args: string[];
  verbatim: boolean;
}

/**
 * On Windows, `npx`, `pnpm` and most Node CLIs are `.cmd` shims, which Node will not spawn
 * directly. Those run through `cmd.exe /d /s /c` with each argument quoted; real executables
 * are spawned directly so no shell sits in between.
 */
export function resolveCommand(command: string, args: string[], env: NodeJS.ProcessEnv): ResolvedCommand {
  if (process.platform !== "win32") {
    return { file: command, args, verbatim: false };
  }
  const found = findOnPath(command, env);
  if (!found || !/\.(cmd|bat)$/i.test(found)) {
    return { file: found ?? command, args, verbatim: false };
  }
  const comspec = envValue(env, "ComSpec") || "cmd.exe";
  const line = [found, ...args].map(quoteForCmd).join(" ");
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const exts = (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const hasExt = /\.[^\\/.]+$/.test(command);
  const candidates = (base: string) => (hasExt ? [base] : exts.map((e) => base + e.toLowerCase()));
  const isFile = (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };

  if (/[\\/]/.test(command) || path.isAbsolute(command)) {
    return candidates(command).find(isFile) ?? (isFile(command) ? command : undefined);
  }
  const dirs = (envValue(env, "PATH") || "").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of candidates(path.join(dir.replace(/^"|"$/g, ""), command))) {
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Quotes one argument for a `cmd /s /c "..."` line: anything beyond plain characters goes in double quotes. */
export function quoteForCmd(arg: string): string {
  if (arg && /^[A-Za-z0-9_\-.\\/:=@,+]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}
