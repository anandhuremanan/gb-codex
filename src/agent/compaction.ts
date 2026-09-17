import { LlmMessage, LlmProvider, ToolSpec } from "../llm/types";

export const SUMMARY_PROMPT = `You compress a coding-agent conversation so work can continue in a smaller context. Write a dense summary with these sections:
1. User requests: every request and constraint, verbatim where short.
2. Work done: files read/created/modified (paths) and key decisions.
3. Important facts: code locations (path:line), APIs, error messages, and command results still relevant.
4. Current state: what was in progress and the exact next steps.
Omit pleasantries and anything no longer relevant. Output only the summary.`;

const CHARS_PER_TOKEN = 3.5;
const KEEP_RECENT_TOOL_RESULTS = 6;
const ELIDE_MIN_CHARS = 600;

export function estimateTokens(messages: LlmMessage[], systemPrompt = "", tools: ToolSpec[] = []): number {
  let chars = systemPrompt.length + (tools.length ? JSON.stringify(tools).length : 0);
  for (const m of messages) {
    chars += m.content.length + 16;
    if (m.toolCalls) {
      chars += JSON.stringify(m.toolCalls).length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function elisionStub(m: LlmMessage): string {
  return `[Output of ${m.toolName ?? "tool"} elided to save context (${m.content.length} chars). Re-run the tool if you need it again.]`;
}

/** Replaces large, older tool results with stubs. Once stubbed they stay stubbed, keeping the prefix stable. */
export function elideOldToolResults(messages: LlmMessage[], keepRecent: number, minChars = ELIDE_MIN_CHARS): number {
  let seen = 0;
  let elided = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool") {
      continue;
    }
    seen++;
    if (seen <= keepRecent || m.elided || m.content.length < minChars) {
      continue;
    }
    m.content = elisionStub(m);
    m.elided = true;
    elided++;
  }
  return elided;
}

/**
 * Called when a new user turn starts: large tool outputs from earlier turns are
 * rarely needed again, and re-sending them on every step is the biggest source of token burn.
 */
export function elidePreviousTurns(messages: LlmMessage[]): number {
  let elided = 0;
  for (const m of messages) {
    if (m.role === "tool" && !m.elided && m.content.length > 1500) {
      m.content = elisionStub(m);
      m.elided = true;
      elided++;
    }
  }
  return elided;
}

/** Makes sure every assistant tool call has a result (e.g. after cancellation), which OpenAI-style APIs require. */
export function repairToolResults(messages: LlmMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.toolCalls?.length) {
      continue;
    }
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      answered.add(messages[j].toolCallId ?? "");
      j++;
    }
    const missing = m.toolCalls.filter((tc) => !answered.has(tc.id));
    if (missing.length) {
      messages.splice(
        j,
        0,
        ...missing.map((tc) => ({
          role: "tool" as const,
          content: "Not executed: the run was interrupted.",
          toolCallId: tc.id,
          toolName: tc.name,
        })),
      );
    }
  }
}

function renderForSummary(messages: LlmMessage[], maxChars: number): string {
  const parts = messages.map((m) => {
    const cap = m.role === "tool" ? 1200 : 4000;
    const body = m.content.length > cap ? `${m.content.slice(0, cap)} …[truncated]` : m.content;
    const calls = m.toolCalls?.map((tc) => `→ ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 300)})`).join("\n") ?? "";
    const label = m.role === "tool" ? `TOOL RESULT (${m.toolName})` : m.role.toUpperCase();
    return `### ${label}\n${body}${calls ? `\n${calls}` : ""}`;
  });
  const text = parts.join("\n\n");
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

export interface CompactionOptions {
  messages: LlmMessage[];
  systemPrompt: string;
  tools: ToolSpec[];
  contextWindow: number;
  maxOutputTokens: number;
  provider: LlmProvider;
  signal: AbortSignal;
  force?: boolean;
  onSummarizing?(): void;
  log(message: string): void;
}

/** Keeps the prompt within the context window: first elide old tool output, then summarize older history. */
export async function compactIfNeeded(options: CompactionOptions): Promise<boolean> {
  const { messages, systemPrompt, tools, contextWindow, maxOutputTokens, log } = options;
  const budget = Math.floor((contextWindow - Math.min(maxOutputTokens, contextWindow / 4)) * 0.85);
  const tokens = () => estimateTokens(messages, systemPrompt, tools);

  if (!options.force && tokens() <= budget) {
    return false;
  }
  const elided = elideOldToolResults(messages, KEEP_RECENT_TOOL_RESULTS);
  if (elided) {
    log(`[compaction] elided ${elided} old tool result(s); ~${tokens()} tokens now (budget ${budget}).`);
  }
  if (!options.force && tokens() <= budget) {
    return elided > 0;
  }

  // Summarize everything before a safe cut point (never split an assistant message from its tool results).
  let cut = -1;
  for (let i = messages.length - 4; i >= 2; i--) {
    if (messages[i].role !== "tool") {
      cut = i;
      break;
    }
  }
  if (cut < 2) {
    elideOldToolResults(messages, 2, 300);
    return true;
  }

  options.onSummarizing?.();
  const transcript = renderForSummary(messages.slice(0, cut), Math.floor(contextWindow * 0.6 * CHARS_PER_TOKEN));
  const result = await options.provider.chat(
    {
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: transcript },
      ],
      signal: options.signal,
      maxTokens: Math.min(2048, maxOutputTokens),
    },
    {},
  );
  const summary = result.text.trim();
  if (!summary) {
    return elided > 0;
  }
  const replacement: LlmMessage[] = [
    { role: "user", content: `[Summary of the earlier conversation, compacted to save context]\n${summary}` },
  ];
  if (messages[cut].role === "user") {
    replacement.push({ role: "assistant", content: "Understood — continuing from the summary." });
  }
  messages.splice(0, cut, ...replacement);
  log(`[compaction] summarized ${cut} message(s); ~${tokens()} tokens now.`);
  return true;
}
