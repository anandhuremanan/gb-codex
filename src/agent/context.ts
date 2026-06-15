import { Message } from "./types";

export class ContextManager {
  private history: Message[] = [];
  private systemPrompt = "";
  private repositorySummary = "";
  private currentRequest = "";

  constructor(systemPrompt: string, repoSummary: string, currentRequest: string) {
    this.systemPrompt = systemPrompt;
    this.repositorySummary = repoSummary;
    this.currentRequest = currentRequest;
  }

  public addInteraction(assistantMsg: string, toolObservation: string) {
    this.history.push({ role: "assistant", content: assistantMsg });
    this.history.push({ role: "user", content: toolObservation });
  }

  public getMessages(): Message[] {
    const messages: Message[] = [];

    // 1. Add System Prompt
    messages.push({ role: "system", content: this.systemPrompt });

    // 2. Add Initial User Request with Repository Summary
    const initialContent = `Repository Summary:\n${this.repositorySummary}\n\nUser Request: ${this.currentRequest}`;
    messages.push({ role: "user", content: initialContent });

    // 3. Keep only last 3 interactions (3 assistant messages + 3 user/tool messages)
    const MAX_HISTORY = 3;
    const historyMessagesToKeep = MAX_HISTORY * 2;

    const startIdx = Math.max(0, this.history.length - historyMessagesToKeep);
    const slicedHistory = this.history.slice(startIdx);

    // Deep copy sliced history to avoid modifying the original logs
    const historyCopies = slicedHistory.map(m => ({ ...m }));
    messages.push(...historyCopies);

    // 4. Token limit checks (4000 tokens ≈ 16000 characters)
    return truncateMessages(messages, 4000);
  }
}

function truncateMessages(messages: Message[], maxTokens: number): Message[] {
  const maxChars = maxTokens * 4;
  let totalLength = messages.reduce((sum, m) => sum + m.content.length, 0);

  if (totalLength <= maxChars) {
    return messages;
  }

  // Truncate older tool response outputs if total characters exceed threshold
  // We skip index 0 (system prompt), index 1 (initial request), and the last 2 messages (current step)
  for (let i = 2; i < messages.length - 2; i++) {
    const msg = messages[i];
    if (msg.role === "user" && msg.content.length > 500) {
      msg.content = msg.content.slice(0, 500) + "\n... [truncated for context limit] ...";
    }
  }

  // Recalculate length
  totalLength = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalLength <= maxChars) {
    return messages;
  }

  // If still too long, aggressively truncate all except system prompt and last 2 messages
  for (let i = 1; i < messages.length - 2; i++) {
    const msg = messages[i];
    if (msg.content.length > 200) {
      msg.content = msg.content.slice(0, 200) + "\n... [truncated] ...";
    }
  }

  return messages;
}
