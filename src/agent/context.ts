import { Message, AgentState } from "./types";
import { PromptBudgetManager } from "./budget";

export class ContextManager {
  private history: Message[] = [];
  private systemPrompt = "";
  private repositorySummary = "";
  private currentRequest = "";
  private agentState: AgentState;

  constructor(systemPrompt: string, repoSummary: string, currentRequest: string, agentState: AgentState) {
    this.systemPrompt = systemPrompt;
    this.repositorySummary = repoSummary;
    this.currentRequest = currentRequest;
    this.agentState = agentState;
  }

  public addInteraction(assistantMsg: string, toolObservation: string) {
    this.history.push({ role: "assistant", content: assistantMsg });
    this.history.push({ role: "user", content: toolObservation });
  }

  public getMessages(): Message[] {
    // Keep only last 3 interactions in history (3 assistant messages + 3 tool response messages)
    const MAX_HISTORY = 3;
    const historyMessagesToKeep = MAX_HISTORY * 2;

    const startIdx = Math.max(0, this.history.length - historyMessagesToKeep);
    const slicedHistory = this.history.slice(startIdx);

    // Deep copy and summarize older observations
    const historyCopies = slicedHistory.map((m, idx) => {
      const copy = { ...m };
      // Summarize older observations only (role is user, and not the last message in history)
      if (copy.role === "user" && idx < slicedHistory.length - 1) {
        if (copy.content.includes("SUCCESS")) {
          const lines = copy.content.split("\n").filter(Boolean);
          const toolLine = lines.find(l => l.startsWith("Tool:"));
          const fileLine = lines.find(l => l.startsWith("File:"));
          const opLine = lines.find(l => l.startsWith("Operation:"));
          if (toolLine && fileLine) {
            copy.content = `SUCCESS: ${toolLine.split(":")[1]?.trim()} on ${fileLine.split(":")[1]?.trim()} (${opLine?.split(":")[1]?.trim() || "Executed"})`;
          } else {
            copy.content = `SUCCESS: Tool execution succeeded. [summarized for history]`;
          }
        } else if (copy.content.startsWith("Error:") || copy.content.startsWith("[Validation Failure]")) {
          copy.content = `FAILURE: ${copy.content.split("\n")[0]} [summarized for history]`;
        } else {
          // Truncate generic/other observations
          copy.content = `Observation: Success (size: ${copy.content.length} chars). [summarized for history]`;
        }
      }
      return copy;
    });

    // Enforce prompt budget
    return PromptBudgetManager.enforce(
      this.systemPrompt,
      this.repositorySummary,
      this.currentRequest,
      this.agentState,
      historyCopies
    );
  }
}
