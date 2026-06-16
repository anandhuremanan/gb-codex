import { Message, AgentState } from "./types";
import { AgentSessionManager } from "./sessionManager";
import { RepositoryCache } from "./cache";

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

    while (true) {
      const session = AgentSessionManager.getInstance().getSession();
      const taskMemory = session.taskMemory;
      const sessionMemory = session.sessionMemory;
      const profile = RepositoryCache.getInstance().getProfile();

      const repoStr = `Repository:

Language:
${profile.language}

Framework:
${profile.framework || "None"}`;

      const goalStr = `Current Goal:
${taskMemory.currentGoal || currentRequest}`;

      const taskMemoryStr = `Active Files:
${taskMemory.activeFiles.map(f => `- ${f}`).join("\n") || "None"}

Related Files:
${taskMemory.relatedFiles.map(f => `- ${f}`).join("\n") || "None"}

Already Reviewed:
${taskMemory.visitedFiles.map(f => `- ${f}`).join("\n") || "None"}

Rejected Files:
${taskMemory.rejectedFiles.map(f => `- ${f}`).join("\n") || "None"}

Completed Actions:
${taskMemory.completedActions.map(a => `✓ ${a}`).join("\n") || "None"}`;

      // Inject at most MAX_SESSION_SUMMARIES_IN_PROMPT = 3
      const recentWorkStr = `Recent Work:
${sessionMemory.recentTasks.map(t => `✓ ${t.goal}`).slice(0, 3).join("\n") || "None"}`;

      const requestStr = `User Request:
${currentRequest}`;

      // Build Preserved Base Message in the new structured format
      const preservedUserContent = `${repoStr}

${goalStr}

${taskMemoryStr}

${recentWorkStr}

${requestStr}${
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

      // Step 1: Trim Older Interactions
      // Drop older assistant+user pairs, keeping only the very latest interaction (history.length <= 2)
      if (currentHistory.length > 2) {
        currentHistory.splice(0, 2);
        continue;
      }

      // Step 2: Stop Truncating Active Context
      return messages;
    }
  }
}
