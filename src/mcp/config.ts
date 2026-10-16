import { createHash } from "crypto";
import * as vscode from "vscode";

/** One stdio MCP server the agent may start. */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  /** Only the variables the configuration sets; the server also inherits the extension's environment. */
  env: Record<string, string>;
  cwd: string;
  source: "user" | "project";
  /** Where it was defined, for the UI and logs, e.g. ".mcp.json" or "user settings". */
  origin: string;
}

export interface McpConfigResult {
  servers: McpServerConfig[];
  /** Entries that were skipped, with the reason. */
  warnings: string[];
}

/**
 * Project files that may define servers, later ones overriding earlier ones by name.
 * `.mcp.json` is what Claude Code (and installers such as `@grampro/kit mcp install`) write,
 * so servers set up for that agent work here without a second step.
 */
const PROJECT_FILES = [".mcp.json", ".gbs/mcp.json"];

const decoder = new TextDecoder("utf-8");

/** Expands `${VAR}` and `${VAR:-default}` from the environment, the way `.mcp.json` files expect. */
export function expandVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
    const found = env[name] ?? findCaseInsensitive(env, name);
    return found !== undefined && found !== "" ? found : (fallback ?? "");
  });
}

/** Windows environment names are case-insensitive (`Path` vs `PATH`). */
function findCaseInsensitive(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Turns an `mcpServers` (or VS Code style `servers`) object into server configs.
 * Only stdio servers are supported; HTTP and SSE entries are reported and skipped.
 */
export function parseServers(
  raw: unknown,
  source: McpServerConfig["source"],
  origin: string,
  defaultCwd: string,
): McpConfigResult {
  const servers: McpServerConfig[] = [];
  const warnings: string[] = [];
  const container = isRecord(raw) ? (raw.mcpServers ?? raw.servers) : undefined;
  if (container === undefined) {
    return { servers, warnings };
  }
  if (!isRecord(container)) {
    return { servers, warnings: [`${origin}: "mcpServers" must be an object.`] };
  }

  for (const [name, entry] of Object.entries(container)) {
    if (!isRecord(entry)) {
      warnings.push(`${origin}: server "${name}" is not an object; skipped.`);
      continue;
    }
    if (entry.disabled === true || entry.enabled === false) {
      continue;
    }
    const type = typeof entry.type === "string" ? entry.type : "stdio";
    if (type !== "stdio" || typeof entry.url === "string") {
      warnings.push(`${origin}: server "${name}" uses ${type === "stdio" ? "a URL" : type}; only stdio servers are supported so far. Skipped.`);
      continue;
    }
    if (typeof entry.command !== "string" || !entry.command.trim()) {
      warnings.push(`${origin}: server "${name}" has no "command"; skipped.`);
      continue;
    }
    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
    const env: Record<string, string> = {};
    if (isRecord(entry.env)) {
      for (const [key, value] of Object.entries(entry.env)) {
        if (typeof value === "string") {
          env[key] = expandVars(value);
        }
      }
    }
    const cwd = typeof entry.cwd === "string" && entry.cwd.trim() ? resolveCwd(expandVars(entry.cwd), defaultCwd) : defaultCwd;
    servers.push({
      name,
      command: expandVars(entry.command.trim()),
      args: args.map((a) => expandVars(a)),
      env,
      cwd,
      source,
      origin,
    });
  }
  return { servers, warnings };
}

function resolveCwd(cwd: string, base: string): string {
  const home = process.env.USERPROFILE || process.env.HOME || "~";
  const expanded = cwd.replace(/^~(?=[\\/]|$)/, home);
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(expanded) ? expanded : vscode.Uri.joinPath(vscode.Uri.file(base), expanded).fsPath;
}

/** Reads every configured server: user settings first, then project files, later definitions winning by name. */
export async function loadMcpConfigs(userServers: unknown): Promise<McpConfigResult> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const defaultCwd = folder?.uri.fsPath ?? process.cwd();
  const byName = new Map<string, McpServerConfig>();
  const warnings: string[] = [];

  const project: McpConfigResult[] = [];
  if (folder) {
    for (const file of PROJECT_FILES) {
      const uri = vscode.Uri.joinPath(folder.uri, file);
      let text: string;
      try {
        text = decoder.decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        continue;
      }
      try {
        project.push(parseServers(JSON.parse(text.replace(/^﻿/, "")), "project", file, defaultCwd));
      } catch (err) {
        warnings.push(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
      }
    }
  }
  // The user's own definitions are applied last, so a repository cannot replace a server the user set up.
  const user = parseServers({ mcpServers: userServers ?? {} }, "user", "user settings", defaultCwd);

  for (const result of [...project, user]) {
    warnings.push(...result.warnings);
    for (const server of result.servers) {
      byName.set(server.name, server);
    }
  }
  return { servers: [...byName.values()], warnings };
}

/** The command line as shown to the user. */
export function describeCommand(server: McpServerConfig): string {
  return [server.command, ...server.args].map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

/** Identifies exactly what would run, so consent given for one set of commands does not carry over to another. */
export function fingerprint(servers: McpServerConfig[]): string {
  const canonical = servers
    .map((s) => ({ name: s.name, command: s.command, args: s.args, env: s.env, cwd: s.cwd }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** A key that changes whenever the server would have to be restarted to pick up a change. */
export function configKey(server: McpServerConfig): string {
  return JSON.stringify([server.command, server.args, server.env, server.cwd]);
}
