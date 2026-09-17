/** Provider-neutral message and tool types used by the agent loop. */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Raw argument text when the model produced invalid JSON. */
  invalidArguments?: string;
}

export interface LlmMessage {
  role: Role;
  content: string;
  /** Assistant messages: tool calls requested by the model. */
  toolCalls?: ToolCall[];
  /** Tool messages: the call this result answers. */
  toolCallId?: string;
  toolName?: string;
  /** Set once compaction has replaced the content with a stub. */
  elided?: boolean;
}

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: string[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatRequest {
  messages: LlmMessage[];
  tools?: ToolSpec[];
  signal: AbortSignal;
  maxTokens?: number;
}

export interface StreamCallbacks {
  onText?(delta: string): void;
  onThinking?(delta: string): void;
}

export interface ChatResult {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  stopReason: "stop" | "length";
}

export interface LlmProvider {
  /** e.g. "ollama" or "openai" */
  readonly id: string;
  readonly model: string;
  chat(request: ChatRequest, callbacks: StreamCallbacks): Promise<ChatResult>;
}

let idCounter = 0;
export function newId(prefix = "id"): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
