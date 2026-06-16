import { Message, AgentState } from "./types";

export class PromptBudgetManager {
  private static MAX_CONTEXT_TOKENS = 3000;
  private static MAX_CHARS = PromptBudgetManager.MAX_CONTEXT_TOKENS * 4;

  public static enforce(
    systemPrompt: string,
    repoProfile: string,
    currentRequest: string,
    state: AgentState,
    history: Message[]
  ): Message[] {
    const getLength = (msgs: Message[]) => msgs.reduce((sum, m) => sum + m.content.length, 0);

    // Initial copies
    let currentHistory = history.map(h => ({ ...h }));
    let currentSearchResults = [...state.searchResults];

    while (true) {
      // Build Agent State Summary (excluding build errors as they are appended separately if present)
      const searchResultsStr = currentSearchResults.length > 0
        ? `Search Results: ${currentSearchResults.join("; ")}`
        : "";

      const stateSummaryParts = [
        `Discovered Files: ${state.discoveredFiles.slice(0, 10).join(", ")}${state.discoveredFiles.length > 10 ? `... (+${state.discoveredFiles.length - 10} more)` : ""}`,
        `Opened Files: ${state.openedFiles.join(", ")}`,
        `Modified Files: ${state.modifiedFiles.join(", ")}`,
        `Completed Objectives:\n${state.completedObjectives.map(o => `✓ ${o}`).join("\n")}`,
        `Discovered Symbols: ${state.discoveredSymbols.slice(0, 15).join(", ")}${state.discoveredSymbols.length > 15 ? `... (+${state.discoveredSymbols.length - 15} more)` : ""}`,
        searchResultsStr
      ].filter(Boolean);

      const agentStateSummary = `### Agent State Summary\n${stateSummaryParts.join("\n")}`;

      // Build Preserved Base Message
      const preservedUserContent = `Repository Profile:\n${repoProfile}\n\nUser Request: ${currentRequest}\n\n${agentStateSummary}${
        state.buildErrors.length > 0 ? `\n\nBuild Errors:\n${state.buildErrors.join("\n")}` : ""
      }`;

      const baseMessages: Message[] = [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: preservedUserContent }
      ];

      const messages = [...baseMessages, ...currentHistory];
      const totalLen = getLength(messages);
      
      // If we fit under the budget, return the messages
      if (totalLen <= PromptBudgetManager.MAX_CHARS) {
        return messages;
      }

      // --- Trimming Protocol in Priority Order ---

      // Step 1: Trim Older Interactions
      // Drop older assistant+user pairs, keeping only the very latest interaction (history.length <= 2)
      if (currentHistory.length > 2) {
        currentHistory.splice(0, 2);
        continue;
      }

      // Step 2: Trim Search Results
      if (currentSearchResults.length > 0) {
        currentSearchResults = [];
        continue;
      }

      // Step 3: Stop Truncating Active Context
      // The only history messages left are the latest interaction (at most 2 messages).
      // The very last message in currentHistory represents the current tool response / active file.
      // According to the requirements, we should NOT truncate this current tool response/file content.
      // So we return the messages as is, even if they slightly exceed MAX_CHARS,
      // because we must never truncate active files, build errors, or current responses.
      return messages;
    }
  }
}
