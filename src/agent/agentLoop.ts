import * as vscode from "vscode";
import { Message, ToolCall } from "./types";
import { globalRegistry } from "./registry";
import { validateBuild } from "./validator";
import { RepositoryCache } from "./cache";
import { ContextManager } from "./context";
import { extractBuildErrors } from "./errorExtractor";

export interface AgentProgress {
  notify(text: string): void;
  token(text: string): void;
}

// Create a debug output channel to show real-time agent execution
export const agentOutputChannel =
  vscode.window.createOutputChannel("GBS Agent Debug");

export async function runAgent(
  userRequest: string,
  progress: AgentProgress,
  token?: vscode.CancellationToken,
): Promise<string> {
  const tools = globalRegistry.getTools();

  // Show and clear debug output channel
  agentOutputChannel.show(true);
  agentOutputChannel.clear();
  agentOutputChannel.appendLine("[GBS Agent Loop Started]");
  agentOutputChannel.appendLine(`User Request: ${userRequest}\n`);

  // Initialize Cache once (subsequent calls are cheap/reused)
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

Available tools:
${tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")}

Rules:
1. You MUST respond in a single valid JSON block containing either a tool call, a list of tool calls, or the final answer.
2. Do not output any conversational chat, explanation, or markdown outside the JSON block.
3. Every turn you can call ONE or MULTIPLE tools in parallel. To call multiple tools, output a JSON array of tool call objects:
[
  { "tool": "tool_name_1", "args": { ... } },
  { "tool": "tool_name_2", "args": { ... } }
]
4. When writing or editing files, prefer write_file (which applies minimal edits) for existing files.
5. If you need to create a new file that does not exist in the workspace, you MUST call the create_file tool. Do NOT just output the file contents in the final answer or conversational chat. You must execute the changes using tools!
6. If you have completed the user's request, verified that all file changes exist in the workspace, and confirmed the build succeeds, output the final answer:
{
  "tool": "final_answer",
  "args": {
    "message": "Write the final explanation of the changes made and results."
  }
}
7. Always think step-by-step. Discover workspace structure or search symbols first.`;

  // Initialize ContextManager
  const contextManager = new ContextManager(
    systemPrompt,
    repoSummary,
    userRequest,
  );

  let loopCount = 0;
  const maxLoopCount = 20;
  let validationRetries = 0;
  const maxValidationRetries = 5;
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
      const messages = contextManager.getMessages();
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

    const extracted = extractToolCalls(responseText);
    if (!extracted) {
      progress.notify("Complete.");
      agentOutputChannel.appendLine(
        "\n[Warning] Response was not valid JSON tool call. Treating as final answer.",
      );
      return responseText;
    }

    const toolCalls = Array.isArray(extracted) ? extracted : [extracted];

    // Check if any is final_answer
    const finalAnswerCall = toolCalls.find((tc) => tc.tool === "final_answer");
    if (finalAnswerCall) {
      const finalMsg =
        finalAnswerCall.args.message || JSON.stringify(finalAnswerCall.args);
      if (filesModified) {
        if (validationRetries < maxValidationRetries) {
          progress.notify("Validating changes (running build/type-check)...");
          agentOutputChannel.appendLine(
            `\n[Validation] Checking build after file modifications...`,
          );
          const buildResult = await validateBuild();
          agentOutputChannel.appendLine(
            `[Validation Output] Command: "${buildResult.command}" (exit code ${buildResult.code})`,
          );

          if (buildResult.success) {
            progress.notify("Build succeeded!");
            agentOutputChannel.appendLine(
              `[Validation Success] Build succeeded! Ending loop.`,
            );
            return finalMsg;
          } else {
            validationRetries++;
            progress.notify(
              `Build failed (${validationRetries}/${maxValidationRetries}). Feeding errors back...`,
            );

            // Extract and compress compiler logs
            const compressedErrors = extractBuildErrors(
              (buildResult.stdout || "") + "\n" + (buildResult.stderr || ""),
            );

            agentOutputChannel.appendLine(
              `[Validation Failure] Build failed. Compressed Errors:\n${compressedErrors}`,
            );

            const buildErrorMsg = `Build validation failed when running "${buildResult.command}" (code ${buildResult.code}).\nErrors:\n${compressedErrors}\n\nPlease analyze the errors, make edits to fix them, and ensure the build succeeds.`;

            contextManager.addInteraction(responseText, buildErrorMsg);
            continue;
          }
        } else {
          progress.notify(
            "Build is still failing, but maximum self-correction retries reached.",
          );
          agentOutputChannel.appendLine(
            `[Validation Aborted] Maximum retries reached. Returning answer despite failures.`,
          );
          return `${finalMsg}\n\n Note: The build validation is currently failing. Please review the errors.`;
        }
      } else {
        progress.notify("Complete.");
        agentOutputChannel.appendLine(
          `\n[Finished] Completed request with no modifications. Ending loop.`,
        );
        return finalMsg;
      }
    }

    // Execute standard tools in parallel
    progress.notify(`Executing ${toolCalls.length} tools in parallel...`);
    agentOutputChannel.appendLine(
      `\n[Tools Parallel Execution] Count: ${toolCalls.length}`,
    );

    const executionPromises = toolCalls.map(async (tc, index) => {
      const tool = globalRegistry.getTool(tc.tool);
      if (!tool) {
        const errMsg = `Tool "${tc.tool}" not found. Available tools are: ${globalRegistry
          .getTools()
          .map((t) => t.name)
          .join(", ")}`;
        return { tool: tc.tool, success: false, content: `Error: ${errMsg}` };
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

        if (tc.tool === "write_file" || tc.tool === "create_file") {
          filesModified = true;
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

    const combinedResponses = results
      .map((r, i) => {
        agentOutputChannel.appendLine(
          `[Tool #${i + 1} Response] ${r.success ? "Finished" : "Failed"}`,
        );
        return `Response from Tool #${i + 1} (${r.tool}):\n${r.content}`;
      })
      .join("\n\n");

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
        model: "qwen2.5-coder:7b",
        messages,
        stream: true,
        options: {
          temperature: 0.1,
          num_predict: 256,
          num_ctx: 4096,
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
