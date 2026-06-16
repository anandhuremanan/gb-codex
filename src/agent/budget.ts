import { Message, AgentState } from "./types";
import { AgentSessionManager } from "./sessionManager";
import { RepositoryCache } from "./cache";
import { ContextRetrievalService } from "./contextRetrieval";

export class PromptBudgetManager {
  private static MAX_CONTEXT_TOKENS = 3000;
  private static MAX_CHARS = PromptBudgetManager.MAX_CONTEXT_TOKENS * 4;

  public static async enforce(
    systemPrompt: string,
    repoProfile: string,
    currentRequest: string,
    state: AgentState,
    history: Message[]
  ): Promise<Message[]> {
    const getLength = (msgs: Message[]) => msgs.reduce((sum, m) => sum + m.content.length, 0);

    // Initial copies
    let currentHistory = history.map(h => ({ ...h }));

    while (true) {
      const session = AgentSessionManager.getInstance().getSession();
      const taskMemory = session.taskMemory;
      const profile = RepositoryCache.getInstance().getProfile();

      // Retrieve working context and snapshot
      const workingContext = await ContextRetrievalService.buildWorkingContext(currentRequest);
      const snapshotStr = RepositoryCache.getInstance().getCompactWorkspaceSnapshot();

      const repoStr = `Repository:

Language:
${profile.language}

Framework:
${profile.framework || "None"}`;

      const workingContextStr = `Working Context:
Relevant Files:
${workingContext.relevantFiles.map(f => `- ${f}`).join("\n") || "None"}

Related Files:
${workingContext.relatedFiles.map(f => `- ${f}`).join("\n") || "None"}

Relevant Symbols:
${workingContext.relevantSymbols.map(s => `- ${s}`).join("\n") || "None"}`;

      let planStr = "";
      if (taskMemory.plan) {
        planStr = `Task Plan:
Goal: ${taskMemory.plan.goal}
${taskMemory.plan.subtasks.map(s => s.completed ? `[x] ${s.description}` : `[ ] ${s.description}`).join("\n")}`;
      }

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

      // Inject only relevant historical tasks (Session Learning relevance filtered)
      const recentWorkStr = `Recent Work:
${workingContext.recentModifications.map(t => `✓ Goal: ${t.goal}\n  Summary: ${t.summary}`).join("\n\n") || "None"}`;

      const requestStr = `User Request:
${currentRequest}`;

      // Build Preserved Base Message in the new structured format
      const preservedUserContent = `${repoStr}

${snapshotStr}

${workingContextStr}

${planStr ? planStr + "\n\n" : ""}${goalStr}

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
