import { HttpError } from "./http";
import { ToolMarkupFilter, parseTextToolCalls, textModeToolPrompt, toTextModeMessages } from "./textToolCalls";
import { ChatRequest, ChatResult, LlmProvider, StreamCallbacks } from "./types";

/** Models (provider:model) that rejected native tool calling in this VS Code session. */
const textModeModels = new Set<string>();

function isToolsUnsupported(err: unknown): boolean {
  const text = err instanceof HttpError ? err.body : err instanceof Error ? err.message : String(err);
  return /does not support tools|tools? (?:is|are) not supported|not support(?:ed)? .*tool|tool[_ ]choice.*not supported|"tools".*unsupported/i.test(
    text,
  );
}

/**
 * Uses native tool calling when the model supports it and falls back to a
 * text protocol otherwise. Also recovers tool calls that "native" models
 * emit as text (a common quirk of small local models).
 */
export class AdaptiveProvider implements LlmProvider {
  constructor(
    private readonly inner: LlmProvider,
    private readonly log: (msg: string) => void,
  ) {}

  get id() {
    return this.inner.id;
  }

  get model() {
    return this.inner.model;
  }

  async chat(request: ChatRequest, callbacks: StreamCallbacks): Promise<ChatResult> {
    const tools = request.tools ?? [];
    if (tools.length === 0) {
      return this.inner.chat(request, callbacks);
    }
    const key = `${this.inner.id}:${this.inner.model}`;
    const names = tools.map((t) => t.name);

    if (!textModeModels.has(key)) {
      const filter = new ToolMarkupFilter((d) => callbacks.onText?.(d));
      try {
        const result = await this.inner.chat(request, { ...callbacks, onText: (d) => filter.push(d) });
        filter.flush();
        if (result.toolCalls.length === 0) {
          // Only a trailing <tool_call> block is recovered; tool syntax inside prose is never executed.
          const recovered = parseTextToolCalls(result.text, names, "native");
          if (recovered.calls.length) {
            return { ...result, text: recovered.text, toolCalls: recovered.calls };
          }
          filter.release();
        }
        return result;
      } catch (err) {
        if (!isToolsUnsupported(err)) {
          throw err;
        }
        textModeModels.add(key);
        this.log(`[provider] ${key} does not support native tools; switching to text tool protocol.`);
      }
    }

    const [system, ...rest] = request.messages;
    const toolPrompt = textModeToolPrompt(tools);
    const messages =
      system?.role === "system"
        ? [{ role: "system" as const, content: `${system.content}\n\n${toolPrompt}` }, ...toTextModeMessages(rest)]
        : [{ role: "system" as const, content: toolPrompt }, ...toTextModeMessages(request.messages)];

    const filter = new ToolMarkupFilter((d) => callbacks.onText?.(d));
    const result = await this.inner.chat(
      { ...request, messages, tools: undefined },
      { ...callbacks, onText: (d) => filter.push(d) },
    );
    filter.flush();
    const parsed = parseTextToolCalls(result.text, names, "text");
    if (!parsed.calls.length) {
      filter.release();
    }
    return { ...result, text: parsed.text, toolCalls: parsed.calls };
  }
}
