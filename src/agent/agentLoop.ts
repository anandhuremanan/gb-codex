import * as vscode from "vscode";
import { Message, ToolCall } from "./types";
import { globalRegistry } from "./registry";
import { validateBuild } from "./validator";

export interface AgentProgress {
  notify(text: string): void;
  token(text: string): void;
}

// Create a debug output channel to show real-time agent execution
export const agentOutputChannel = vscode.window.createOutputChannel("GBS Agent Debug");

export async function runAgent(
  userRequest: string,
  progress: AgentProgress,
  token?: vscode.CancellationToken
): Promise<string> {
  const tools = globalRegistry.getTools();
  
  // Show and clear debug output channel
  agentOutputChannel.show(true);
  agentOutputChannel.clear();
  agentOutputChannel.appendLine("[GBS Agent Loop Started]");
  agentOutputChannel.appendLine(`User Request: ${userRequest}\n`);

  const systemPrompt = `You are a tool-driven autonomous coding agent similar to Cursor or Claude Code.
You execute tasks in the workspace by planning, invoking tools, and analyzing results.

Available tools:
${tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

Rules:
1. You MUST respond in a single valid JSON block containing either a tool call or the final answer.
2. Do not output any conversational chat, explanation, or markdown outside the JSON block.
3. Every turn you can call ONE tool. To call a tool, output a JSON object of this structure:
{
  "tool": "tool_name",
  "args": {
    "arg_name": "value"
  }
}
4. When writing or editing files, prefer write_file (which applies minimal edits) for existing files.
5. If you need to create a new file that does not exist in the workspace, you MUST call the create_file tool. Do NOT just output the file contents in the final answer or conversational chat. You must execute the changes using tools!
6. If you have completed the user's request, verified that all file changes exist in the workspace, and confirmed the build succeeds, output the final answer:
{
  "tool": "final_answer",
  "args": {
    "message": "Write the final explanation of the changes made and results."
  }
}
7. Always think step-by-step. Discover workspace structure first.`;

  // Workspace Discovery: auto-discover project structure at start
  progress.notify("Discovering workspace structure...");
  const listFilesTool = globalRegistry.getTool("list_workspace_files");
  let workspaceFiles: string[] = [];
  if (listFilesTool) {
    try {
      workspaceFiles = await listFilesTool.execute({});
      agentOutputChannel.appendLine(`[Workspace Discovery] Found ${workspaceFiles.length} files:`);
      workspaceFiles.forEach(f => agentOutputChannel.appendLine(`  - ${f}`));
      agentOutputChannel.appendLine("");
    } catch (err) {
      progress.notify(`Failed to automatically discover files: ${err}`);
      agentOutputChannel.appendLine(`[Workspace Discovery Error] ${err}\n`);
    }
  }

  const initialUserMsg = `Workspace file structure:\n${workspaceFiles.map(f => `- ${f}`).join('\n')}\n\nUser Request: ${userRequest}`;

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: initialUserMsg }
  ];

  let loopCount = 0;
  const maxLoopCount = 20;
  let validationRetries = 0;
  const maxValidationRetries = 5;
  let filesModified = false;

  while (loopCount < maxLoopCount) {
    if (token?.isCancellationRequested) {
      agentOutputChannel.appendLine("\n[Cancelled] Agent execution stopped by user request.");
      return "Agent execution was cancelled by the user.";
    }
    loopCount++;
    progress.notify(`Thinking (step ${loopCount})...`);
    agentOutputChannel.appendLine(`--- Step ${loopCount} ---`);
    agentOutputChannel.append("Model response: ");

    let responseText = "";
    try {
      await streamOllamaResponse(messages, (tokenStr) => {
        responseText += tokenStr;
        progress.token(tokenStr);
        agentOutputChannel.append(tokenStr);
      }, token);
      agentOutputChannel.appendLine("");
    } catch (err) {
      progress.notify(`Error calling Ollama: ${err}`);
      agentOutputChannel.appendLine(`\n[Model Connection Error] ${err}`);
      return `Failed to generate response due to model error: ${err}`;
    }

    const toolCall = extractToolCall(responseText);
    if (!toolCall) {
      // Treat the response as the final explanation if it cannot be parsed as JSON tool call.
      progress.notify("Complete.");
      agentOutputChannel.appendLine("\n[Warning] Response was not valid JSON tool call. Treating as final answer.");
      return responseText;
    }

    if (toolCall.tool === "final_answer") {
      const finalMsg = toolCall.args.message || JSON.stringify(toolCall.args);
      if (filesModified) {
        if (validationRetries < maxValidationRetries) {
          progress.notify("Validating changes (running build/type-check)...");
          agentOutputChannel.appendLine(`\n[Validation] Checking build after file modifications...`);
          const buildResult = await validateBuild();
          agentOutputChannel.appendLine(`[Validation Output] Command: "${buildResult.command}" (exit code ${buildResult.code})`);
          if (buildResult.stdout) {
            agentOutputChannel.appendLine(`Stdout:\n${buildResult.stdout}`);
          }
          if (buildResult.stderr) {
            agentOutputChannel.appendLine(`Stderr:\n${buildResult.stderr}`);
          }

          if (buildResult.success) {
            progress.notify("Build succeeded!");
            agentOutputChannel.appendLine(`[Validation Success] Build succeeded! Ending loop.`);
            return finalMsg;
          } else {
            validationRetries++;
            progress.notify(`Build failed (${validationRetries}/${maxValidationRetries}). Feeding errors back to model...`);
            agentOutputChannel.appendLine(`[Validation Failure] Build failed. Self-correcting retry #${validationRetries}`);
            const buildErrorMsg = `Build validation failed when running "${buildResult.command}" (code ${buildResult.code}).\nStdout:\n${buildResult.stdout}\nStderr:\n${buildResult.stderr}\n\nPlease analyze the errors, make edits to fix them, and ensure the build succeeds.`;

            messages.push({ role: "assistant", content: responseText });
            messages.push({ role: "user", content: buildErrorMsg });
            continue;
          }
        } else {
          progress.notify("Build is still failing, but maximum self-correction retries reached.");
          agentOutputChannel.appendLine(`[Validation Aborted] Maximum retries reached. Returning answer despite failures.`);
          return `${finalMsg}\n\n Note: The build validation is currently failing. Please review the errors.`;
        }
      } else {
        progress.notify("Complete.");
        agentOutputChannel.appendLine(`\n[Finished] Completed request with no modifications. Ending loop.`);
        return finalMsg;
      }
    }

    // Execute standard tool
    const tool = globalRegistry.getTool(toolCall.tool);
    if (!tool) {
      const errMsg = `Tool "${toolCall.tool}" not found. Available tools are: ${globalRegistry.getTools().map(t => t.name).join(', ')}`;
      messages.push({ role: "assistant", content: responseText });
      messages.push({ role: "user", content: `Error: ${errMsg}` });
      progress.notify(`Tool not found: ${toolCall.tool}`);
      agentOutputChannel.appendLine(`\n[Tool Executing Failed] Tool "${toolCall.tool}" not found.`);
      continue;
    }

    progress.notify(`Executing tool \`${toolCall.tool}\`...`);
    agentOutputChannel.appendLine(`\n[Tool Invoked] Name: "${toolCall.tool}"`);
    agentOutputChannel.appendLine(`Arguments:\n${JSON.stringify(toolCall.args, null, 2)}`);
    try {
      const result = await tool.execute(toolCall.args);
      const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);

      if (toolCall.tool === "write_file" || toolCall.tool === "create_file") {
        filesModified = true;
      }

      messages.push({ role: "assistant", content: responseText });
      messages.push({ role: "user", content: `Tool response:\n${resultStr}` });
      progress.notify(`Tool \`${toolCall.tool}\` finished.`);
      agentOutputChannel.appendLine(`[Tool Response] Finished.\n`);
    } catch (err: any) {
      messages.push({ role: "assistant", content: responseText });
      messages.push({ role: "user", content: `Tool error: ${err.message || err}` });
      progress.notify(`Tool \`${toolCall.tool}\` failed: ${err.message || err}`);
      agentOutputChannel.appendLine(`[Tool Response Error] ${err.message || err}\n`);
    }
  }

  return "Agent stopped: Exceeded maximum iterations without reaching a final answer.";
}

function extractToolCall(response: string): ToolCall | null {
  // 1. Try to find a JSON code block
  const jsonBlockRegex = /```(?:json)?\n([\s\S]*?)```/i;
  const match = response.match(jsonBlockRegex);
  const textToParse = match ? match[1].trim() : response.trim();

  // 2. Find first outer curly brace pair
  const startIdx = textToParse.indexOf('{');
  const endIdx = textToParse.lastIndexOf('}');
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const jsonCandidate = textToParse.slice(startIdx, endIdx + 1);
    try {
      const parsed = JSON.parse(jsonCandidate);
      if (parsed && typeof parsed === "object" && typeof parsed.tool === "string") {
        return parsed as ToolCall;
      }
    } catch {
      // ignore
    }
  }

  // 3. Fallback to parsing direct text
  try {
    const parsed = JSON.parse(textToParse);
    if (parsed && typeof parsed === "object" && typeof parsed.tool === "string") {
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
  token?: vscode.CancellationToken
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
        model: "gemma4:e4b",
        messages,
        stream: true,
      }),
      signal: abortController.signal
    });
  } catch (err: any) {
    if (err.name === 'AbortError' || token?.isCancellationRequested) {
      throw new Error("Request cancelled by user.");
    }
    throw new Error("Could not reach Ollama at localhost:11434. Is it running?");
  } finally {
    if (disposable) {
      disposable.dispose();
    }
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown error");
    throw new Error(`Ollama returned an error (${response.status}): ${errText}`);
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

