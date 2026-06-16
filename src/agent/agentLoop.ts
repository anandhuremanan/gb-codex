import * as vscode from "vscode";
import { Message, ToolCall, AgentState } from "./types";
import { globalRegistry } from "./registry";
import { validateBuild } from "./validator";
import { RepositoryCache } from "./cache";
import { ContextManager } from "./context";
import { extractBuildErrors } from "./errorExtractor";
import { AgentSessionManager } from "./sessionManager";
import { ContextRetrievalService } from "./contextRetrieval";

export interface AgentProgress {
  notify(text: string): void;
  token(text: string): void;
}

export const agentOutputChannel =
  vscode.window.createOutputChannel("GBS Agent Debug");

function generateToolsDescription(): string {
  const tools = globalRegistry.getTools();
  return tools.map((t) => {
    return `${t.name}\nDescription: ${t.description}\nArguments Schema:\n${JSON.stringify(t.schema, null, 2)}`;
  }).join("\n\n");
}

function extractCompletedObjectives(response: string): string[] {
  try {
    const jsonBlockRegex = /```(?:json)?\n([\s\S]*?)```/i;
    const match = response.match(jsonBlockRegex);
    const textToParse = match ? match[1].trim() : response.trim();

    const firstCurly = textToParse.indexOf("{");
    const firstBracket = textToParse.indexOf("[");

    let startIdx = -1;
    let endIdx = -1;

    if (firstBracket !== -1 && (firstCurly === -1 || firstBracket < firstCurly)) {
      startIdx = firstBracket;
      endIdx = textToParse.lastIndexOf("]");
    } else {
      startIdx = firstCurly;
      endIdx = textToParse.lastIndexOf("}");
    }

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const jsonCandidate = textToParse.slice(startIdx, endIdx + 1);
      const parsed = JSON.parse(jsonCandidate);
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.completedObjectives)) {
          return parsed.completedObjectives.map((o: any) => String(o));
        }
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.completedObjectives && Array.isArray(item.completedObjectives)) {
              return item.completedObjectives.map((o: any) => String(o));
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return [];
}

// Helper to compute a simple hash
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return hash.toString(36);
}

interface EditRecord {
  file: string;
  tool: string;
  searchHash?: string;
  replaceHash?: string;
}

function detectLoopPattern(fileEdits: EditRecord[]): boolean {
  // Only keep edits that have searchHash and replaceHash
  const sigs = fileEdits.filter(e => e.searchHash !== undefined && e.replaceHash !== undefined);
  if (sigs.length < 2) {
    return false;
  }

  // Check for repeated signatures: same searchHash and same replaceHash
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) {
      if (sigs[i].searchHash === sigs[j].searchHash && sigs[i].replaceHash === sigs[j].replaceHash) {
        return true;
      }
    }
  }

  // Check for reversed/toggling signatures: A -> B and B -> A
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) {
      if (sigs[i].searchHash === sigs[j].replaceHash && sigs[i].replaceHash === sigs[j].searchHash) {
        return true;
      }
    }
  }

  return false;
}

function extractRejectedFiles(response: string): string[] {
  try {
    const jsonBlockRegex = /```(?:json)?\n([\s\S]*?)```/i;
    const match = response.match(jsonBlockRegex);
    const textToParse = match ? match[1].trim() : response.trim();

    const firstCurly = textToParse.indexOf("{");
    const firstBracket = textToParse.indexOf("[");

    let startIdx = -1;
    let endIdx = -1;

    if (firstBracket !== -1 && (firstCurly === -1 || firstBracket < firstCurly)) {
      startIdx = firstBracket;
      endIdx = textToParse.lastIndexOf("]");
    } else {
      startIdx = firstCurly;
      endIdx = textToParse.lastIndexOf("}");
    }

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const jsonCandidate = textToParse.slice(startIdx, endIdx + 1);
      const parsed = JSON.parse(jsonCandidate);
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.rejectedFiles)) {
          return parsed.rejectedFiles.map((f: any) => String(f));
        }
      }
    }
  } catch {
    // ignore
  }
  return [];
}

function checkAlternatingPattern(history: string[]): boolean {
  if (history.length < 6) {
    return false;
  }
  const last6 = history.slice(-6);
  const p1 = last6[0] === "list_workspace_files" && last6[1] === "read_file" &&
    last6[2] === "list_workspace_files" && last6[3] === "read_file" &&
    last6[4] === "list_workspace_files" && last6[5] === "read_file";

  const p2 = last6[0] === "read_file" && last6[1] === "list_workspace_files" &&
    last6[2] === "read_file" && last6[3] === "list_workspace_files" &&
    last6[4] === "read_file" && last6[5] === "list_workspace_files";

  return p1 || p2;
}

function updatePlanProgress(taskMemory: any, state: AgentState) {
  if (!taskMemory.plan) {
    return;
  }

  const buildSuccess = state.buildErrors.length === 0;

  for (const subtask of taskMemory.plan.subtasks) {
    if (subtask.completed) {
      continue;
    }

    const desc = subtask.description.toLowerCase();

    // Direct match with completedObjectives or completedActions
    const matchObjective = state.completedObjectives.some((obj: string) => 
      obj.toLowerCase().includes(desc) || desc.includes(obj.toLowerCase())
    ) || taskMemory.completedActions.some((act: string) => 
      act.toLowerCase().includes(desc) || desc.includes(act.toLowerCase())
    );

    if (matchObjective) {
      subtask.completed = true;
      continue;
    }

    // Keyword checks matching generic template
    if (desc.includes("locate") || desc.includes("find")) {
      if (taskMemory.visitedFiles.length > 0 || taskMemory.activeFiles.length > 0) {
        subtask.completed = true;
        continue;
      }
    }

    if (desc.includes("inspect") || desc.includes("read") || desc.includes("analyze")) {
      if (taskMemory.visitedFiles.length > 0) {
        subtask.completed = true;
        continue;
      }
    }

    if (desc.includes("modify") || desc.includes("edit") || desc.includes("update") || desc.includes("apply")) {
      if (taskMemory.modifiedFiles.length > 0 || taskMemory.createdFiles.length > 0) {
        subtask.completed = true;
        continue;
      }
    }

    if (desc.includes("validate") || desc.includes("compile") || desc.includes("verify") || desc.includes("test")) {
      if (buildSuccess && (taskMemory.modifiedFiles.length > 0 || taskMemory.createdFiles.length > 0)) {
        subtask.completed = true;
        continue;
      }
    }

    if (desc.includes("finish") || desc.includes("complete")) {
      const otherCompleted = taskMemory.plan.subtasks
        .filter((s: any) => s !== subtask)
        .every((s: any) => s.completed);
      if (otherCompleted && buildSuccess && (taskMemory.modifiedFiles.length > 0 || taskMemory.createdFiles.length > 0)) {
        subtask.completed = true;
      }
    }
  }
}

export async function runAgent(
  userRequest: string,
  progress: AgentProgress,
  token?: vscode.CancellationToken,
): Promise<string> {
  const tools = globalRegistry.getTools();

  // Reset TaskMemory for this execution run (RequestGoal is per execution)
  const session = AgentSessionManager.getInstance().getSession();
  session.taskMemory = {
    currentGoal: userRequest,
    activeFiles: [],
    relatedFiles: [],
    visitedFiles: [],
    visitedQueries: [],
    discoveredFacts: [],
    completedActions: [],
    createdFiles: [],
    modifiedFiles: [],
    rejectedFiles: [],
    plan: {
      goal: userRequest,
      subtasks: [
        { description: "Locate relevant files", completed: false },
        { description: "Inspect implementation", completed: false },
        { description: "Apply modifications", completed: false },
        { description: "Validate changes", completed: false },
        { description: "Finish", completed: false }
      ]
    }
  };

  const taskMemory = session.taskMemory;

  // Initialize AgentState (scoped to this session run only)
  const agentState: AgentState = {
    modifiedFiles: [],
    completedObjectives: [],
    discoveredFiles: [],
    buildErrors: [],
    recentlyModifiedFiles: [],
    searchResults: [],
    openedFiles: [],
    discoveredSymbols: [],
    finishHints: 0,
  };

  const modifiedFiles: string[] = [];
  const lastReadContent = new Map<string, string>();
  const editRecords: EditRecord[] = [];
  let discoveryStepsCount = 0;

  // Set of requested files/searches in this run for repeated discovery detection
  const requestedFilesInThisRun = new Set<string>();
  const requestedQueriesInThisRun = new Set<string>();

  const fileReadCounts = new Map<string, number>();
  const toolCallHistory: string[] = [];

  // Discovery tool tracking variables
  const discoveryAttempts = new Map<string, number>();
  const lastDiscoveryParams = new Map<string, string>();
  let lastDiscoveredFilesCount = 0;
  let lastDiscoveredSymbolsCount = 0;

  // Show and clear debug output channel
  agentOutputChannel.show(true);
  agentOutputChannel.clear();
  agentOutputChannel.appendLine("[GBS Agent Loop Started]");
  agentOutputChannel.appendLine(`User Request: ${userRequest}\n`);

  // Initialize Cache once
  progress.notify("Initializing repository cache...");
  const cache = RepositoryCache.getInstance();
  await cache.initialize();

  // Generate lightweight Repository Summary
  const repoSummary = getRepositorySummary();
  agentOutputChannel.appendLine("[Repository Summary]");
  agentOutputChannel.appendLine(repoSummary);
  agentOutputChannel.appendLine("");

  const systemPrompt = `You are a tool-driven autonomous coding agent similar to Cursor or Claude Code.
You execute tasks in the workspace by planning, invoking tools, and analyzing results.

Available Tools:
${generateToolsDescription()}

You MUST use only the tools above.
Never invent tool names.

Rules:
1. You MUST respond in a single valid JSON block containing either a tool call, a list of tool calls, or the final answer.
2. In your JSON response, you can optionally include:
   - a 'completedObjectives' array of strings listing the objectives/tasks you have completed in this turn.
   - a 'rejectedFiles' array of strings containing relative paths of files you investigated and determined are NOT relevant to the task.
Example format:
{
  "tool": "replace_in_file",
  "args": { ... },
  "completedObjectives": ["Applied yellow/black theme"],
  "rejectedFiles": ["src/auth.ts"]
}
3. Do not output any conversational chat, explanation, or markdown outside the JSON block.
4. Every turn you can call ONE or MULTIPLE tools in parallel. To call multiple tools, output a JSON array of tool call objects.
5. Heuristic for File Changes:
   * Small change -> replace_in_file (where changes represent less than 70% of the original file).
   * Large rewrite -> write_file (where changes represent more than 70% of the original file).
   Do not repeatedly rewrite full files.
6. If you need to create a new file that does not exist in the workspace, you MUST call the create_file tool. Do NOT just output the file contents in the final answer or conversational chat. You must execute the changes using tools!
7. When the user request has been completed, you MUST call the finish tool:
{
  "tool": "finish",
  "args": {
    "summary": "Write the final explanation of the changes made and results."
  }
}
Once the requested change has been successfully applied,
finish immediately.

Do not continue making aesthetic or optional improvements
unless explicitly requested by the user.

Finish should be preferred over further refinement.
8. Always think step-by-step. Discover workspace structure or search symbols first.`;

  // Initialize ContextManager
  const contextManager = new ContextManager(
    systemPrompt,
    repoSummary,
    userRequest,
    agentState,
  );

  let loopCount = 0;
  const maxLoopCount = 20;
  let validationRetries = 0;
  const maxValidationRetries = 3;
  let filesModified = false;

  while (loopCount < maxLoopCount) {
    if (token?.isCancellationRequested) {
      agentOutputChannel.appendLine(
        "\n[Cancelled] Agent execution stopped by user request.",
      );
      return "Agent execution was cancelled by the user.";
    }
    loopCount++;
    progress.notify(`Thinking (step ${loopCount})...`);
    agentOutputChannel.appendLine(`--- Step ${loopCount} ---`);
    agentOutputChannel.append("Model response: ");

    let responseText = "";
    try {
      const messages = await contextManager.getMessages();
      await streamOllamaResponse(
        messages,
        (tokenStr) => {
          responseText += tokenStr;
          progress.token(tokenStr);
          agentOutputChannel.append(tokenStr);
        },
        token,
      );
      agentOutputChannel.appendLine("");
    } catch (err) {
      progress.notify(`Error calling Ollama: ${err}`);
      agentOutputChannel.appendLine(`\n[Model Connection Error] ${err}`);
      return `Failed to generate response due to model error: ${err}`;
    }

    // Extract completed objectives from this turn
    const objectives = extractCompletedObjectives(responseText);
    for (const obj of objectives) {
      if (!agentState.completedObjectives.includes(obj)) {
        agentState.completedObjectives.push(obj);
      }
      if (!taskMemory.completedActions.includes(obj)) {
        taskMemory.completedActions.push(obj);
      }
    }

    const rejected = extractRejectedFiles(responseText);
    for (const file of rejected) {
      if (!taskMemory.rejectedFiles.includes(file)) {
        taskMemory.rejectedFiles.push(file);
      }
    }

    const extracted = extractToolCalls(responseText);

    // Loop Exit Heuristics: Nudge model if it output no tool call but there are build errors
    if (!extracted) {
      if (agentState.buildErrors.length > 0) {
        progress.notify("Build errors found. Nudging model...");
        const errorMsg = `The build is currently failing. Please call the appropriate tools (like replace_in_file or run_terminal_command) to fix these errors:\n${agentState.buildErrors.join("\n")}`;
        contextManager.addInteraction(responseText, errorMsg);
        continue;
      }
      progress.notify("Complete.");
      agentOutputChannel.appendLine(
        "\n[Warning] Response was not valid JSON tool call. Treating as final answer.",
      );
      return responseText;
    }

    const toolCalls = Array.isArray(extracted) ? extracted : [extracted];

    for (const tc of toolCalls) {
      if (tc.tool === "list_workspace_files" || tc.tool === "read_file") {
        toolCallHistory.push(tc.tool);
      }
    }

    // Finish Tool termination
    const finishCall = toolCalls.find((tc) => tc.tool === "finish");
    if (finishCall) {
      const summaryMsg = finishCall.args.summary || JSON.stringify(finishCall.args);

      // Auto-summarize and save to SessionMemory
      const completedList = taskMemory.completedActions.map(a => `✓ ${a}`).join("\n");
      const modifiedList = taskMemory.modifiedFiles.map(f => `- ${f}`).join("\n");
      const createdList = taskMemory.createdFiles.map(f => `- ${f}`).join("\n");

      const taskSummaryText = `Goal:
${taskMemory.currentGoal}

Completed:
${completedList || "None"}

Modified:
${modifiedList || "None"}

Created:
${createdList || "None"}`;

      const sessionMemory = session.sessionMemory;
      const symbolsTouched: string[] = [];
      const symbolIndex = RepositoryCache.getInstance().getSymbolIndex();
      const allTouchedFiles = [...taskMemory.modifiedFiles, ...taskMemory.createdFiles];
      for (const file of allTouchedFiles) {
        symbolsTouched.push(...symbolIndex.getSymbolsForFile(file));
      }

      sessionMemory.recentTasks.unshift({
        goal: taskMemory.currentGoal,
        summary: taskSummaryText,
        modifiedFiles: [...taskMemory.modifiedFiles],
        createdFiles: [...taskMemory.createdFiles],
        symbolsTouched: Array.from(new Set(symbolsTouched)),
        timestamp: Date.now(),
      });
      if (sessionMemory.recentTasks.length > 20) {
        sessionMemory.recentTasks = sessionMemory.recentTasks.slice(0, 20);
      }
      await AgentSessionManager.getInstance().saveSessionMemory();

      progress.notify("Complete.");
      agentOutputChannel.appendLine(
        `\n[Finished] Completed request with finish tool: ${summaryMsg}`,
      );
      return `SUCCESS: ${summaryMsg}`;
    }

    // Execute standard tools in parallel
    progress.notify(`Executing ${toolCalls.length} tools in parallel...`);
    agentOutputChannel.appendLine(
      `\n[Tools Parallel Execution] Count: ${toolCalls.length}`,
    );

    const executionPromises = toolCalls.map(async (tc, index) => {
      // Strict Tool Validation
      if (!globalRegistry.hasTool(tc.tool)) {
        const available = globalRegistry.getTools().map(t => `- ${t.name}`).join("\n");
        const errMsg = `Error: Tool "${tc.tool}" does not exist. Available Tools:\n${available}`;
        agentOutputChannel.appendLine(`[Error] Invalid tool call: ${tc.tool}`);
        return { tool: tc.tool, success: false, content: errMsg };
      }

      const tool = globalRegistry.getTool(tc.tool)!;

      // Track discovery tool calls and apply adaptive blocking
      if (tc.tool === "list_workspace_files" || tc.tool === "search_symbols") {
        const count = (discoveryAttempts.get(tc.tool) || 0) + 1;
        discoveryAttempts.set(tc.tool, count);

        const workingContext = await ContextRetrievalService.buildWorkingContext(userRequest);

        if (tc.tool === "list_workspace_files") {
          const hasRetrieval = workingContext.relevantFiles.length > 0;
          const noNewFiles = agentState.discoveredFiles.length <= (lastDiscoveredFilesCount || 0);
          
          if (count > 3 && hasRetrieval && noNewFiles) {
            agentOutputChannel.appendLine(`[Discovery Blocked] list_workspace_files count: ${count}`);
            return {
              tool: tc.tool,
              success: true,
              content: `Retrieval results and Workspace Snapshot are already available in your working context. Discovery tool execution has been deprioritized as no new files were discovered. Use the retrieved context or inspect target files directly.`
            };
          }
        }

        if (tc.tool === "search_symbols" && tc.args && typeof tc.args.query === "string") {
          const query = tc.args.query.toLowerCase();
          const hasRetrieval = workingContext.relevantSymbols.length > 0;
          const isSameQuery = lastDiscoveryParams.get("search_symbols") === query;
          const noNewSymbols = agentState.discoveredSymbols.length <= (lastDiscoveredSymbolsCount || 0);

          lastDiscoveryParams.set("search_symbols", query);

          if (count > 3 && hasRetrieval && (isSameQuery || noNewSymbols)) {
            agentOutputChannel.appendLine(`[Discovery Blocked] search_symbols count: ${count}`);
            return {
              tool: tc.tool,
              success: true,
              content: `Retrieval results for symbols are already available in your working context. Discovery tool execution has been deprioritized as no new symbols were found. Use the retrieved context or inspect target files directly.`
            };
          }
        }
      }

      // Check Discovery Budget (list_workspace_files, search_symbols)
      const isDiscovery = (tc.tool === "list_workspace_files" || tc.tool === "search_symbols");
      if (isDiscovery) {
        if (discoveryStepsCount >= 30) {
          agentOutputChannel.appendLine(`[Discovery Budget Exceeded] Blocking execution of: ${tc.tool}`);
          return {
            tool: tc.tool,
            success: true,
            content: `You have exceeded the discovery budget.\n\nChoose one:\n1. Modify files\n2. Create files\n3. Finish\n\nDo not continue discovery.`
          };
        }
        discoveryStepsCount++;
        agentOutputChannel.appendLine(`[Discovery Budget] Count: ${discoveryStepsCount}`);
      }

      // Check Repeated Discovery
      let isRepeated = false;
      if (tc.tool === "read_file" && tc.args && typeof tc.args.path === "string") {
        const path = tc.args.path;
        if (taskMemory.visitedFiles.includes(path) || requestedFilesInThisRun.has(path)) {
          isRepeated = true;
        } else {
          requestedFilesInThisRun.add(path);
        }
      } else if (tc.tool === "search_symbols" && tc.args && typeof tc.args.query === "string") {
        const query = tc.args.query;
        if (taskMemory.visitedQueries.includes(query) || requestedQueriesInThisRun.has(query)) {
          isRepeated = true;
        } else {
          requestedQueriesInThisRun.add(query);
        }
      }
      if (isRepeated) {
        agentState.finishHints++;
        agentOutputChannel.appendLine(`[Repeated Discovery Detected] finishHints = ${agentState.finishHints}`);
      }

      // Scoped Cache Hit & Sibling Suggestions & Repeated Reads Protection
      if (tc.tool === "read_file") {
        if (tc.args && typeof tc.args.path === "string") {
          const path = tc.args.path;
          const normalizedPath = path.replace(/\\/g, "/");
          const cachedContent = RepositoryCache.getInstance().getCachedFileContents().get(normalizedPath);
          const currentContent = cachedContent !== undefined ? cachedContent : 
                                 await RepositoryCache.getInstance().getFileContent(normalizedPath);

          // Proactively retrieve related files (siblings, child routes, nearby components)
          const relatedInfo = await ContextRetrievalService.getRelatedFiles(normalizedPath);
          const sameDirFiles = relatedInfo.siblingFiles;
          const childRoutes = relatedInfo.childRoutes;
          const nearbyComponents = relatedInfo.nearbyComponents;
          
          const relatedFilesText = `\n\nRELATED FILES:\n` +
            `Same Directory Files:\n${sameDirFiles.map(f => `- ${f}`).join("\n") || "None"}\n` +
            `Child Routes:\n${childRoutes.map(f => `- ${f}`).join("\n") || "None"}\n` +
            `Nearby Components:\n${nearbyComponents.map(f => `- ${f}`).join("\n") || "None"}`;

          // Track Repeated Reads (without modification)
          const readCount = (fileReadCounts.get(normalizedPath) || 0) + 1;
          fileReadCounts.set(normalizedPath, readCount);

          if (readCount > 3) {
            agentOutputChannel.appendLine(`[Repeated Read Warning] ${normalizedPath} read count: ${readCount}`);
            return {
              tool: tc.tool,
              success: true,
              content: `You have already reviewed this file. Do not read it again. Either modify it, inspect a related file, or finish.`
            };
          }

          // Duplicate Read Protection
          if (lastReadContent.has(normalizedPath) && lastReadContent.get(normalizedPath) === currentContent) {
            agentOutputChannel.appendLine(`[Duplicate Read Protection] File already reviewed: ${normalizedPath}`);
            agentState.finishHints++;
            return {
              tool: tc.tool,
              success: true,
              content: `${currentContent}\n\nThis file has not changed since your previous read.\n\nConsider whether additional edits are necessary.${relatedFilesText}`
            };
          }

          // Cache Hit for recently modified files
          if (agentState.recentlyModifiedFiles.includes(normalizedPath) && cachedContent !== undefined) {
            agentOutputChannel.appendLine(`[Cache Hit] Returning cached content for recently modified file: ${normalizedPath}`);
            lastReadContent.set(normalizedPath, currentContent);
            return {
              tool: tc.tool,
              success: true,
              content: cachedContent + relatedFilesText
            };
          }
          
          lastReadContent.set(normalizedPath, currentContent);

          return {
            tool: tc.tool,
            success: true,
            content: currentContent + relatedFilesText
          };
        }
      }

      agentOutputChannel.appendLine(
        `[Tool #${index + 1} Invoked] Name: "${tc.tool}"`,
      );
      agentOutputChannel.appendLine(
        `Arguments:\n${JSON.stringify(tc.args, null, 2)}`,
      );

      try {
        const result = await tool.execute(tc.args);
        const resultStr =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);

        // Detect No-Op replacement
        let isNoOp = false;
        if (tc.tool === "replace_in_file" && resultStr.includes("NO_CHANGES_REQUIRED")) {
          isNoOp = true;
        }

        if ((tc.tool === "write_file" || tc.tool === "create_file" || tc.tool === "replace_in_file") && !isNoOp) {
          filesModified = true;
          const file = (tc.args?.path || "").replace(/\\/g, "/");
          fileReadCounts.set(file, 0); // Reset read count on modification
          toolCallHistory.length = 0; // Reset alternating pattern history on modification
          if (tc.tool === "replace_in_file" && tc.args && typeof tc.args.search === "string" && typeof tc.args.replace === "string") {
            editRecords.push({
              file,
              tool: tc.tool,
              searchHash: hashString(tc.args.search),
              replaceHash: hashString(tc.args.replace),
            });
          } else {
            editRecords.push({
              file,
              tool: tc.tool,
            });
          }
        }

        return { tool: tc.tool, success: true, content: resultStr };
      } catch (err: any) {
        return {
          tool: tc.tool,
          success: false,
          content: `Error: ${err.message || err}`,
        };
      }
    });

    const results = await Promise.all(executionPromises);

    // Track steps modified file for repeated edits detection
    let stepModifiedFile: string | null = null;
    let stepModifiedFiles = false;

    // Update AgentState and TaskMemory based on tool call results
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const res = results[i];
      if (!res.success) {
        continue;
      }

      if (tc.tool === "list_workspace_files") {
        try {
          const parsed = JSON.parse(res.content);
          if (Array.isArray(parsed)) {
            agentState.discoveredFiles = Array.from(new Set([...agentState.discoveredFiles, ...parsed]));
          }
        } catch {
          // ignore
        }
      } else if (tc.tool === "read_file" || tc.tool === "write_file" || tc.tool === "create_file" || tc.tool === "replace_in_file") {
        if (tc.args && typeof tc.args.path === "string") {
          const path = tc.args.path.replace(/\\/g, "/");
          if (!agentState.openedFiles.includes(path)) {
            agentState.openedFiles.push(path);
          }

          // Update TaskMemory
          if (tc.tool === "read_file") {
            if (!taskMemory.visitedFiles.includes(path)) {
              taskMemory.visitedFiles.push(path);
            }
            if (!taskMemory.activeFiles.includes(path)) {
              taskMemory.activeFiles.push(path);
            }
          } else if (tc.tool === "create_file") {
            if (!taskMemory.createdFiles.includes(path)) {
              taskMemory.createdFiles.push(path);
            }
          }

          if (tc.tool === "write_file" || tc.tool === "create_file" || tc.tool === "replace_in_file") {
            const isNoOp = res.content.includes("NO_CHANGES_REQUIRED");
            if (!isNoOp) {
              stepModifiedFile = path;
              stepModifiedFiles = true;
              if (!modifiedFiles.includes(path)) {
                modifiedFiles.push(path);
              }
              if (!agentState.recentlyModifiedFiles.includes(path)) {
                agentState.recentlyModifiedFiles.push(path);
              }
              if (!agentState.modifiedFiles.includes(path)) {
                agentState.modifiedFiles.push(path);
              }

              // Update TaskMemory modifiedFiles
              if (!taskMemory.modifiedFiles.includes(path)) {
                taskMemory.modifiedFiles.push(path);
              }
            }
          }
        }
      } else if (tc.tool === "search_symbols") {
        if (tc.args && typeof tc.args.query === "string") {
          const query = tc.args.query;
          if (!agentState.searchResults.includes(query)) {
            agentState.searchResults.push(query);
          }
          if (!taskMemory.visitedQueries.includes(query)) {
            taskMemory.visitedQueries.push(query);
          }
        }
        try {
          const parsed = JSON.parse(res.content);
          if (Array.isArray(parsed)) {
            const symbols = parsed.map((item: any) => item.symbol).filter(Boolean);
            agentState.discoveredSymbols = Array.from(new Set([...agentState.discoveredSymbols, ...symbols]));

            // Update TaskMemory relatedFiles
            for (const item of parsed) {
              if (item.file && !taskMemory.relatedFiles.includes(item.file)) {
                taskMemory.relatedFiles.push(item.file);
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }

    lastDiscoveredFilesCount = agentState.discoveredFiles.length;
    lastDiscoveredSymbolsCount = agentState.discoveredSymbols.length;

    let combinedResponses = results
      .map((r, i) => {
        agentOutputChannel.appendLine(
          `[Tool #${i + 1} Response] ${r.success ? "Finished" : "Failed"}`,
        );
        return `Response from Tool #${i + 1} (${r.tool}):\n${r.content}`;
      })
      .join("\n\n");

    // Run build check if files were modified to keep errors updated in AgentState
    if (stepModifiedFiles && validationRetries < maxValidationRetries) {
      const buildResult = await validateBuild(modifiedFiles);
      if (!buildResult.success) {
        validationRetries++;
        const compressedErrors = extractBuildErrors(
          (buildResult.stdout || "") + "\n" + (buildResult.stderr || ""),
        );
        agentState.buildErrors = [compressedErrors];
      } else {
        agentState.buildErrors = [];
        // build passes after successful modifications -> increment finishHints
        agentState.finishHints++;
        agentOutputChannel.appendLine(`[Heuristic] Build passed after modifications. finishHints = ${agentState.finishHints}`);
      }
    }

    // Update task plan progress
    updatePlanProgress(taskMemory, agentState);

    // Heuristics and Warnings
    const warnings: string[] = [];

    // 1. Discovery Budget Warning (at 15)
    if (discoveryStepsCount >= 15 && discoveryStepsCount < 30) {
      warnings.push(`\nYou have already reviewed sufficient repository context.\n\nProceed with implementation unless new information is required.`);
    }

    // Alternating Pattern Warning (3 pairs of list_workspace_files and read_file)
    if (checkAlternatingPattern(toolCallHistory)) {
      warnings.push(`\nYou appear to be stuck in discovery. Use existing context or inspect a related file.`);
    }

    // 2. Repeated Discovery Warning
    let stepHasRepeated = false;
    for (const tc of toolCalls) {
      if (tc.tool === "read_file" && tc.args && typeof tc.args.path === "string") {
        const path = tc.args.path.replace(/\\/g, "/");
        if (taskMemory.visitedFiles.includes(path)) {
          stepHasRepeated = true;
        }
      } else if (tc.tool === "search_symbols" && tc.args && typeof tc.args.query === "string") {
        const query = tc.args.query;
        if (taskMemory.visitedQueries.includes(query)) {
          stepHasRepeated = true;
        }
      }
    }
    if (stepHasRepeated) {
      warnings.push(`\nYou have already reviewed these files and searches.\n\nChoose one:\n\n1. Modify files\n2. Create files\n3. Finish\n\nDo not continue discovery.`);
    }

    if (stepModifiedFiles && agentState.buildErrors.length === 0) {
      // 3. Loop pattern detection (at count >= 3)
      for (const path of agentState.modifiedFiles) {
        const fileEdits = editRecords.filter(r => r.file === path);
        if (fileEdits.length >= 3 && detectLoopPattern(fileEdits)) {
          agentState.finishHints++;
          warnings.push(`\nThe file has already been modified multiple times.\n\nIf the request is satisfied, call finish.`);
          agentOutputChannel.appendLine(`[Loop Detection] Loop pattern detected on ${path}. finishHints = ${agentState.finishHints}`);
          break; // show warning once
        }
      }

      // 4. Per-file modification budget (at count >= 5)
      for (const path of agentState.modifiedFiles) {
        const fileEdits = editRecords.filter(r => r.file === path);
        if (fileEdits.length >= 5) {
          agentState.finishHints++;
          warnings.push(`\nThis file has already been modified multiple times.\n\nIf the request has been completed,\ncall finish.\n\nIf additional changes are required,\nexplain why.`);
          agentOutputChannel.appendLine(`[Budget Warning] Per-file budget met/exceeded on ${path} (${fileEdits.length} edits). finishHints = ${agentState.finishHints}`);
          break; // show warning once
        }
      }

      // 5. Global modification budget (at total edits >= 15)
      if (editRecords.length >= 15) {
        agentState.finishHints++;
        warnings.push(`\nThe maximum total modification budget of 15 has been reached.\n\nIf the request has been completed,\ncall finish.\n\nIf additional changes are required,\nexplain why.`);
        agentOutputChannel.appendLine(`[Budget Warning] Global budget met/exceeded (${editRecords.length} edits). finishHints = ${agentState.finishHints}`);
      }
    }

    // 6. Completion Reminder Heuristic
    if (
      agentState.buildErrors.length === 0 &&
      agentState.modifiedFiles.length > 0 &&
      agentState.completedObjectives.length > 0
    ) {
      warnings.push(`\nThe request may be completed.\n\nIf all requested objectives have been addressed,\ncall finish.`);
    }

    // 7. Multiple signals / finishHints warning
    if (agentState.finishHints >= 3) {
      warnings.push(`\nMultiple signals indicate the task may already be complete.\n\nPrefer calling finish unless additional changes are strictly required.`);
    }

    if (warnings.length > 0) {
      combinedResponses += "\n" + warnings.join("\n");
    }

    // Add interaction to context manager
    contextManager.addInteraction(responseText, combinedResponses);

    progress.notify(`Finished executing tools.`);
    agentOutputChannel.appendLine("");
  }

  return "Agent stopped: Exceeded maximum iterations without reaching a final answer.";
}

function getRepositorySummary(): string {
  const cache = RepositoryCache.getInstance();
  const profile = cache.getProfile();
  const tree = cache.getWorkspaceTree();

  const topLevelDirs = new Set<string>();
  const importantFiles: string[] = [];

  for (const filePath of tree) {
    const parts = filePath.split(/[/\\]/);
    if (parts.length > 1) {
      topLevelDirs.add(parts[0] + "/");
    } else {
      importantFiles.push(filePath);
    }

    const lower = filePath.toLowerCase();
    if (
      (lower.includes("main") ||
        lower.includes("app.tsx") ||
        lower.includes("app.ts") ||
        lower.includes("router") ||
        lower.includes("routes") ||
        lower.includes("index")) &&
      !importantFiles.includes(filePath)
    ) {
      importantFiles.push(filePath);
    }
  }

  return `Language: ${profile.language}
Framework: ${profile.framework || "None"}
Build: ${profile.buildCommand || "None"}

Top Level:
${Array.from(topLevelDirs)
      .slice(0, 10)
      .map((d) => `  ${d}`)
      .join("\n")}

Important Files:
${importantFiles
      .slice(0, 15)
      .map((f) => `  ${f}`)
      .join("\n")}`;
}

function extractToolCalls(response: string): ToolCall[] | ToolCall | null {
  const jsonBlockRegex = /```(?:json)?\n([\s\S]*?)```/i;
  const match = response.match(jsonBlockRegex);
  const textToParse = match ? match[1].trim() : response.trim();

  const firstCurly = textToParse.indexOf("{");
  const firstBracket = textToParse.indexOf("[");

  let startIdx = -1;
  let endIdx = -1;

  if (firstBracket !== -1 && (firstCurly === -1 || firstBracket < firstCurly)) {
    startIdx = firstBracket;
    endIdx = textToParse.lastIndexOf("]");
  } else {
    startIdx = firstCurly;
    endIdx = textToParse.lastIndexOf("}");
  }

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const jsonCandidate = textToParse.slice(startIdx, endIdx + 1);
    try {
      const parsed = JSON.parse(jsonCandidate);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item) => item && typeof item.tool === "string",
        ) as ToolCall[];
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.tool === "string"
      ) {
        return parsed as ToolCall;
      }
    } catch {
      // ignore
    }
  }

  try {
    const parsed = JSON.parse(textToParse);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item) => item && typeof item.tool === "string",
      ) as ToolCall[];
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.tool === "string"
    ) {
      return parsed as ToolCall;
    }
  } catch {
    // ignore
  }

  return null;
}

async function streamOllamaResponse(
  messages: Message[],
  onToken: (token: string) => void,
  token?: vscode.CancellationToken,
) {
  const abortController = new AbortController();
  let disposable: vscode.Disposable | undefined;
  if (token) {
    disposable = token.onCancellationRequested(() => {
      abortController.abort();
    });
  }

  let response: Response;
  try {
    response = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3-coder:480b-cloud",
        messages,
        stream: true,
        options: {
          temperature: 0.1,
          num_predict: 4096,
          num_ctx: 32768,
        },
      }),
      signal: abortController.signal,
    });
  } catch (err: any) {
    if (err.name === "AbortError" || token?.isCancellationRequested) {
      throw new Error("Request cancelled by user.");
    }
    throw new Error(
      "Could not reach Ollama at localhost:11434. Is it running?",
    );
  } finally {
    if (disposable) {
      disposable.dispose();
    }
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `Ollama returned an error (${response.status}): ${errText}`,
    );
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    if (token?.isCancellationRequested) {
      reader.cancel();
      break;
    }
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const lines = decoder.decode(value).split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const json = JSON.parse(line);
        if (json.message && typeof json.message.content === "string") {
          onToken(json.message.content);
        }
      } catch {
        // incomplete chunk — skip
      }
    }
  }
}
