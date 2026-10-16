import * as vscode from "vscode";
import { Tool } from "../agent/tools/types";
import { McpClient, McpToolInfo } from "./client";
import { McpServerConfig, configKey, describeCommand } from "./config";
import { createMcpTool } from "./tools";

/** First start may download a package (`npx -y ...`), so the handshake gets longer than a call. */
const START_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 30_000;
/** Keeps a misconfigured server from flooding the prompt with tool schemas. */
const MAX_TOOLS_PER_SERVER = 64;

export interface McpServerStatus {
  name: string;
  origin: string;
  command: string;
  state: "starting" | "ready" | "failed" | "closed";
  error?: string;
  tools: string[];
  server?: string;
}

interface Entry {
  key: string;
  client: McpClient;
  starting?: Promise<void>;
  tools: McpToolInfo[];
  /** A server that failed is not retried on every request; a config change or reload retries it. */
  failureReported: boolean;
}

export interface McpToolsResult {
  tools: Tool[];
  /** Servers that failed since the last call, with the reason, so the UI can say so once. */
  newlyFailed: Array<{ name: string; error: string }>;
  /** Server-provided usage notes, keyed by server name. */
  instructions: Map<string, string>;
}

/** Owns the MCP server processes for a window: starts them on demand, keeps them across requests. */
export class McpManager implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly log: (message: string) => void) {}

  /**
   * Brings the running servers in line with `servers` (starting new or changed ones, stopping
   * removed ones) and returns their tools. One server failing never blocks the others.
   */
  async tools(servers: McpServerConfig[], callTimeoutMs: number): Promise<McpToolsResult> {
    const wanted = new Map(servers.map((s) => [s.name, s]));
    for (const [name, entry] of this.entries) {
      const config = wanted.get(name);
      if (!config || configKey(config) !== entry.key) {
        entry.client.dispose();
        this.entries.delete(name);
      }
    }

    for (const config of servers) {
      let entry = this.entries.get(config.name);
      // A server that was running and then exited is restarted once per request.
      if (entry && entry.client.state === "closed") {
        this.entries.delete(config.name);
        entry = undefined;
      }
      if (entry && entry.client.state === "failed" && entry.failureReported && !entry.starting) {
        continue;
      }
      if (!entry) {
        const client = new McpClient(config, this.log);
        entry = { key: configKey(config), client, tools: [], failureReported: false };
        entry.starting = client.start(START_TIMEOUT_MS).catch(() => undefined);
        this.entries.set(config.name, entry);
      }
    }

    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        await entry.starting;
        entry.starting = undefined;
        if (entry.client.state === "ready" && entry.client.toolsStale) {
          try {
            entry.tools = (await entry.client.listTools(LIST_TIMEOUT_MS)).slice(0, MAX_TOOLS_PER_SERVER);
            this.log(`[mcp:${entry.client.config.name}] ${entry.tools.length} tool(s): ${entry.tools.map((t) => t.name).join(", ")}`);
          } catch (err) {
            this.log(`[mcp:${entry.client.config.name}] tools/list failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }),
    );

    const tools: Tool[] = [];
    const newlyFailed: McpToolsResult["newlyFailed"] = [];
    const instructions = new Map<string, string>();
    const seen = new Set<string>();
    for (const entry of this.entries.values()) {
      const { client } = entry;
      if (client.state === "failed") {
        if (!entry.failureReported) {
          entry.failureReported = true;
          newlyFailed.push({ name: client.config.name, error: client.error ?? "failed to start" });
        }
        continue;
      }
      if (client.state !== "ready") {
        continue;
      }
      if (client.instructions?.trim()) {
        instructions.set(client.config.name, client.instructions.trim());
      }
      for (const info of entry.tools) {
        const tool = createMcpTool(client, info, callTimeoutMs);
        if (seen.has(tool.name)) {
          this.log(`[mcp:${client.config.name}] skipping "${info.name}": its name collides with another tool`);
          continue;
        }
        seen.add(tool.name);
        tools.push(tool);
      }
    }
    return { tools, newlyFailed, instructions };
  }

  status(servers: McpServerConfig[]): McpServerStatus[] {
    return servers.map((config) => {
      const entry = this.entries.get(config.name);
      return {
        name: config.name,
        origin: config.origin,
        command: describeCommand(config),
        state: entry?.client.state ?? "closed",
        error: entry?.client.error,
        tools: entry?.tools.map((t) => t.name) ?? [],
        server: entry?.client.serverName
          ? `${entry.client.serverName}${entry.client.serverVersion ? ` ${entry.client.serverVersion}` : ""}`
          : undefined,
      };
    });
  }

  /** Stops every server; the next request starts them again. */
  stopAll(): void {
    for (const entry of this.entries.values()) {
      entry.client.dispose();
    }
    this.entries.clear();
  }

  dispose(): void {
    this.stopAll();
  }
}
