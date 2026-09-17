import { HttpError, postJson, readLines } from "./http";
import { ChatRequest, ChatResult, LlmMessage, LlmProvider, StreamCallbacks, newId } from "./types";
import { parseArguments } from "./textToolCalls";

export interface OpenAIOptions {
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  getApiKey(): Promise<string | undefined>;
}

/**
 * OpenAI-compatible /chat/completions client (Hugging Face router, vLLM,
 * LM Studio, OpenRouter, llama.cpp server, ...).
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly id = "openai";
  readonly model: string;
  private supportsUsageOption = true;

  constructor(private readonly options: OpenAIOptions) {
    this.model = options.model;
  }

  async chat(request: ChatRequest, callbacks: StreamCallbacks): Promise<ChatResult> {
    const apiKey = await this.options.getApiKey();
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map(toOpenAIMessage),
      stream: true,
      temperature: this.options.temperature,
      max_tokens: request.maxTokens ?? this.options.maxOutputTokens,
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({ type: "function", function: t }));
    }

    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let response: Response;
    try {
      if (this.supportsUsageOption) {
        body.stream_options = { include_usage: true };
      }
      response = await postJson(url, body, headers, request.signal, "Model server");
    } catch (err) {
      // Some servers reject the stream_options field; retry once without it.
      if (err instanceof HttpError && err.status === 400 && /stream_options/i.test(err.body)) {
        this.supportsUsageOption = false;
        delete body.stream_options;
        response = await postJson(url, body, headers, request.signal, "Model server");
      } else {
        throw err;
      }
    }

    const result: ChatResult = { text: "", thinking: "", toolCalls: [], stopReason: "stop" };
    const partialCalls = new Map<number, { id: string; name: string; args: string }>();

    for await (const rawLine of readLines(response.body!, request.signal)) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        break;
      }
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) {
        throw new Error(`Model server: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
      }
      if (chunk.usage) {
        result.usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) {
        continue;
      }
      const delta = choice.delta ?? {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        result.thinking += reasoning;
        callbacks.onThinking?.(reasoning);
      }
      if (typeof delta.content === "string" && delta.content) {
        result.text += delta.content;
        callbacks.onText?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === "number" ? tc.index : partialCalls.size;
          let partial = partialCalls.get(index);
          if (!partial) {
            partial = { id: "", name: "", args: "" };
            partialCalls.set(index, partial);
          }
          if (tc.id) {
            partial.id = tc.id;
          }
          if (tc.function?.name && !partial.name) {
            partial.name = tc.function.name;
          }
          if (typeof tc.function?.arguments === "string") {
            partial.args += tc.function.arguments;
          } else if (tc.function?.arguments && typeof tc.function.arguments === "object") {
            partial.args = JSON.stringify(tc.function.arguments);
          }
        }
      }
      if (choice.finish_reason === "length") {
        result.stopReason = "length";
      }
    }

    for (const [, partial] of [...partialCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!partial.name) {
        continue;
      }
      const parsed = parseArguments(partial.args || "{}");
      result.toolCalls.push({
        id: partial.id || newId("call"),
        name: partial.name,
        arguments: parsed ?? {},
        invalidArguments: parsed ? undefined : partial.args,
      });
    }
    return result;
  }
}

function toOpenAIMessage(m: LlmMessage): Record<string, unknown> {
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  return { role: m.role, content: m.content };
}
