import { createHash } from "crypto";
import { JsonSchema } from "../llm/types";
import { Tool } from "../agent/tools/types";
import { McpCallResult, McpClient, McpToolInfo } from "./client";

const MAX_NAME = 64;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_PREVIEW_CHARS = 2000;
export const MCP_PREFIX = "mcp__";

/** OpenAI-compatible endpoints accept only `^[a-zA-Z0-9_-]{1,64}$` as a function name. */
function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** `mcp__<server>__<tool>`, shortened with a stable hash when it would exceed 64 characters. */
export function mcpToolName(server: string, tool: string): string {
  const name = `${MCP_PREFIX}${sanitize(server)}__${sanitize(tool)}`;
  if (name.length <= MAX_NAME) {
    return name;
  }
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_NAME - hash.length - 1)}_${hash}`;
}

/**
 * MCP input schemas are full JSON Schema. Providers accept them as-is, so this only makes sure
 * the top level is an object schema and drops `$schema`, which some endpoints reject.
 */
export function normalizeSchema(schema: unknown): JsonSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const copy = { ...(schema as Record<string, unknown>) };
  delete copy.$schema;
  if (copy.type !== "object") {
    copy.type = "object";
  }
  if (!copy.properties || typeof copy.properties !== "object") {
    copy.properties = {};
  }
  if (copy.required !== undefined && !Array.isArray(copy.required)) {
    delete copy.required;
  }
  return copy as unknown as JsonSchema;
}

/** Flattens a tool result into the text the model sees. */
export function renderResult(result: McpCallResult | undefined): string {
  const parts: string[] = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    switch (item?.type) {
      case "text":
        if (typeof item.text === "string") {
          parts.push(item.text);
        }
        break;
      case "resource":
        parts.push(
          typeof item.resource?.text === "string" ? item.resource.text : `[resource ${item.resource?.uri ?? ""} (${item.resource?.mimeType ?? "binary"}) omitted]`,
        );
        break;
      case "resource_link":
        parts.push(`[resource link: ${item.name ? `${item.name} ` : ""}${item.uri ?? ""}]`);
        break;
      default:
        parts.push(`[${item?.type ?? "unknown"} content${item?.mimeType ? ` (${item.mimeType})` : ""} omitted]`);
    }
  }
  if (!parts.length && result?.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return parts.join("\n\n").trim() || "(no output)";
}

function preview(args: Record<string, unknown>): string | undefined {
  const keys = Object.keys(args ?? {});
  if (!keys.length) {
    return undefined;
  }
  const text = JSON.stringify(args, null, 2);
  return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}\n…` : text;
}

/** A short hint for the transcript row: the first string argument, if there is one. */
function firstStringArg(args: Record<string, unknown>): string | undefined {
  for (const value of Object.values(args ?? {})) {
    if (typeof value === "string" && value.trim()) {
      return value.replace(/\s+/g, " ").slice(0, 60);
    }
  }
  return undefined;
}

/**
 * Wraps one MCP tool as an agent tool. Every call needs approval (or "always allow" for that
 * tool this session) unless the permission mode is auto: the server is an outside program, so
 * its `readOnlyHint` only decides whether calls may run in parallel, never whether to ask.
 */
export function createMcpTool(client: McpClient, info: McpToolInfo, timeoutMs: number): Tool<Record<string, unknown>> {
  const server = client.config.name;
  const label = `${server} · ${info.name}`;
  const summary = (info.description || info.title || info.annotations?.title || info.name).trim();
  return {
    name: mcpToolName(server, info.name),
    description: `[MCP server "${server}"] ${summary.length > MAX_DESCRIPTION_CHARS ? `${summary.slice(0, MAX_DESCRIPTION_CHARS)}…` : summary}`,
    parameters: normalizeSchema(info.inputSchema),
    readOnly: info.annotations?.readOnlyHint === true,
    permission: (args) => ({ kind: "mcp", detail: label, preview: preview(args) }),
    title: (args) => {
      const hint = firstStringArg(args);
      return hint ? `${label} · ${hint}` : label;
    },
    async execute(args, ctx) {
      if (client.state !== "ready") {
        return { content: `MCP server "${server}" is not running${client.error ? `: ${client.error}` : "."}`, isError: true };
      }
      const result = await client.callTool(info.name, args ?? {}, ctx.signal, timeoutMs);
      return { content: renderResult(result), isError: result?.isError === true, ui: { title: label } };
    },
  };
}
