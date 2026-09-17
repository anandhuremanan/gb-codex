import { LlmMessage, ToolCall, ToolSpec, newId } from "./types";

const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";

/** Parses a JSON argument string, tolerating surrounding junk. Returns undefined when unparseable. */
export function parseArguments(raw: string): Record<string, unknown> | undefined {
  const text = raw.trim();
  if (!text) {
    return {};
  }
  const attempt = (s: string) => {
    try {
      const value = JSON.parse(s);
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  return attempt(text) ?? attempt(extractBalancedObject(text) ?? "");
}

/** Returns the first balanced {...} substring, respecting JSON strings. */
export function extractBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

function toCall(obj: Record<string, unknown>, allowed: Set<string>): ToolCall | undefined {
  const name = obj.name ?? obj.tool ?? (obj.function as { name?: unknown } | undefined)?.name;
  if (typeof name !== "string" || !allowed.has(name)) {
    return undefined;
  }
  let args = obj.arguments ?? obj.args ?? obj.parameters ?? (obj.function as { arguments?: unknown } | undefined)?.arguments ?? {};
  if (typeof args === "string") {
    args = parseArguments(args) ?? {};
  }
  return { id: newId("call"), name, arguments: (args ?? {}) as Record<string, unknown> };
}

/**
 * Extracts tool calls written as text: `<tool_call>{...}</tool_call>` blocks
 * (Qwen/Hermes style) or fenced JSON blocks naming a known tool.
 */
export function parseTextToolCalls(text: string, allowedNames: Iterable<string>): { calls: ToolCall[]; text: string } {
  const allowed = new Set(allowedNames);
  const calls: ToolCall[] = [];
  let cleaned = text;

  const tagRegex = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
  if (text.includes(OPEN_TAG)) {
    for (const match of text.matchAll(tagRegex)) {
      const parsed = parseArguments(match[1]);
      const call = parsed && toCall(parsed, allowed);
      if (call) {
        calls.push(call);
      }
    }
    cleaned = text.replace(tagRegex, "");
  }

  if (calls.length === 0) {
    const fenceRegex = /```(?:json|tool_call|tool)?\s*\n([\s\S]*?)```/g;
    for (const match of text.matchAll(fenceRegex)) {
      const body = match[1].trim();
      let values: unknown[] = [];
      try {
        const parsed = JSON.parse(body);
        values = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        const obj = parseArguments(body);
        values = obj ? [obj] : [];
      }
      const found = values
        .map((v) => (v && typeof v === "object" ? toCall(v as Record<string, unknown>, allowed) : undefined))
        .filter((c): c is ToolCall => !!c);
      if (found.length) {
        calls.push(...found);
        cleaned = cleaned.replace(match[0], "");
      }
    }
  }

  return { calls, text: calls.length ? cleaned.trim() : text };
}

/**
 * Hides tool-call markup from the live text stream so the UI only shows prose.
 * Holds back any suffix that could be the beginning of `<tool_call>`.
 */
export class ToolMarkupFilter {
  private full = "";
  private emitted = 0;
  private blocked = false;

  constructor(private readonly emit: (delta: string) => void) {}

  push(delta: string): void {
    if (this.blocked) {
      return;
    }
    this.full += delta;
    const tagIndex = this.full.indexOf(OPEN_TAG);
    let safeEnd: number;
    if (tagIndex >= 0) {
      safeEnd = tagIndex;
      this.blocked = true;
    } else {
      safeEnd = this.full.length;
      for (let k = Math.min(OPEN_TAG.length - 1, this.full.length); k > 0; k--) {
        if (OPEN_TAG.startsWith(this.full.slice(-k))) {
          safeEnd = this.full.length - k;
          break;
        }
      }
    }
    if (safeEnd > this.emitted) {
      this.emit(this.full.slice(this.emitted, safeEnd));
      this.emitted = safeEnd;
    }
  }

  flush(): void {
    if (!this.blocked && this.emitted < this.full.length) {
      this.emit(this.full.slice(this.emitted));
      this.emitted = this.full.length;
    }
  }
}

export function textModeToolPrompt(tools: ToolSpec[]): string {
  const list = tools
    .map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`)
    .join("\n");
  return `# Tool use
You can call these tools:
${list}

To call a tool, write a block exactly like this (one block per call; several blocks allowed):
${OPEN_TAG}
{"name": "tool_name", "arguments": {"param": "value"}}
${CLOSE_TAG}
After your tool calls, stop and wait: results arrive in <tool_result> blocks. When no tool is needed, reply normally with no ${OPEN_TAG} block.`;
}

/** Rewrites native tool-call history into plain text messages for models without tool support. */
export function toTextModeMessages(messages: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks = m.toolCalls
        .map((tc) => `${OPEN_TAG}\n${JSON.stringify({ name: tc.name, arguments: tc.arguments })}\n${CLOSE_TAG}`)
        .join("\n");
      out.push({ role: "assistant", content: [m.content, blocks].filter(Boolean).join("\n") });
    } else if (m.role === "tool") {
      const block = `<tool_result name="${m.toolName ?? "tool"}">\n${m.content}\n</tool_result>`;
      const last = out[out.length - 1];
      if (last && last.role === "user" && last.content.startsWith("<tool_result")) {
        last.content += `\n${block}`;
      } else {
        out.push({ role: "user", content: block });
      }
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}
