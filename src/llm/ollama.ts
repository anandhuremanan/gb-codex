import { postJson, readLines } from "./http";
import { ChatRequest, ChatResult, LlmMessage, LlmProvider, StreamCallbacks, ToolCall, newId } from "./types";
import { parseArguments } from "./textToolCalls";

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
}

/** Native Ollama /api/chat client with tool calling and NDJSON streaming. */
export class OllamaProvider implements LlmProvider {
  readonly id = "ollama";
  readonly model: string;

  constructor(private readonly options: OllamaOptions) {
    this.model = options.model;
  }

  async chat(request: ChatRequest, callbacks: StreamCallbacks): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map(toOllamaMessage),
      stream: true,
      keep_alive: "30m",
      options: {
        temperature: this.options.temperature,
        num_ctx: this.options.contextWindow,
        num_predict: request.maxTokens ?? this.options.maxOutputTokens,
      },
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({ type: "function", function: t }));
    }

    const response = await postJson(
      `${this.options.baseUrl.replace(/\/+$/, "")}/api/chat`,
      body,
      {},
      request.signal,
      "Ollama",
    );

    const result: ChatResult = { text: "", thinking: "", toolCalls: [], stopReason: "stop" };
    for await (const line of readLines(response.body!, request.signal)) {
      if (!line.trim()) {
        continue;
      }
      let chunk: any;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      if (chunk.error) {
        throw new Error(`Ollama: ${chunk.error}`);
      }
      const message = chunk.message;
      if (message) {
        if (typeof message.thinking === "string" && message.thinking) {
          result.thinking += message.thinking;
          callbacks.onThinking?.(message.thinking);
        }
        if (typeof message.content === "string" && message.content) {
          result.text += message.content;
          callbacks.onText?.(message.content);
        }
        if (Array.isArray(message.tool_calls)) {
          for (const tc of message.tool_calls) {
            result.toolCalls.push(toToolCall(tc));
          }
        }
      }
      if (chunk.done) {
        result.usage = {
          inputTokens: chunk.prompt_eval_count ?? 0,
          outputTokens: chunk.eval_count ?? 0,
        };
        if (chunk.done_reason === "length") {
          result.stopReason = "length";
        }
      }
    }
    return result;
  }
}

function toToolCall(raw: any): ToolCall {
  const fn = raw?.function ?? {};
  const call: ToolCall = { id: raw?.id || newId("call"), name: String(fn.name ?? ""), arguments: {} };
  if (typeof fn.arguments === "string") {
    const parsed = parseArguments(fn.arguments);
    if (parsed) {
      call.arguments = parsed;
    } else {
      call.invalidArguments = fn.arguments;
    }
  } else if (fn.arguments && typeof fn.arguments === "object") {
    call.arguments = fn.arguments;
  }
  return call;
}

function toOllamaMessage(m: LlmMessage): Record<string, unknown> {
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.arguments } })),
    };
  }
  if (m.role === "tool") {
    return { role: "tool", content: m.content, tool_name: m.toolName };
  }
  return { role: m.role, content: m.content };
}
