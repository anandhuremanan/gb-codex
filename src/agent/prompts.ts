import * as os from "os";
import * as vscode from "vscode";
import { analyzeRepository } from "./analyzer";
import { EXCLUDED_DIRS, getRoot } from "./workspace";
import { shellDescription } from "./tools/runCommand";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".gbs/instructions.md", ".github/copilot-instructions.md"];
const MAX_INSTRUCTIONS_CHARS = 6000;

const MAIN_PROMPT = `You are GBS Agent, an autonomous software engineering agent inside VS Code. You complete coding tasks in the user's workspace by using tools to search, read, and edit code and to run commands.

# Working method
- Understand before changing. Locate code with grep/glob/list_dir, then read only what you need (use offset/limit for large files). Never guess file contents, APIs, or paths.
- Call independent tools together in one response — they run in parallel. E.g. read several files at once.
- For broad, open-ended investigation across many files, delegate to \`task\` (subagent_type "explore") so raw search output stays out of your context; launch several in one response for independent questions. Don't delegate a single known lookup.
- For work with 3+ steps, track a plan with \`todo_write\` and keep it updated. Skip it for simple requests.
- Edit existing files with \`edit_file\`; use \`write_file\` only for new files or full rewrites. Files must be read before they are modified.
- Match the existing style and conventions. Do exactly what was asked: no unrequested refactors, features, or comments.
- Verify your work: fix any errors reported in <diagnostics> after edits, and run the relevant build/test/lint command when one exists and the change warrants it.
- If a tool call fails, read the error and adjust instead of repeating the same call. If the user denies a tool call, don't retry it — change approach or ask.
- If the request is ambiguous in a way that changes the outcome, ask a concise question instead of guessing. Questions about the code only need tools if you must look something up.

# Communication
- Be concise and direct; use GitHub-flavored markdown. Reference code as \`path/to/file.ts:42\`.
- Don't narrate each tool call. A short sentence before a batch of work is enough.
- Finish with a brief summary of what changed and anything the user must do. Don't paste code you already wrote to files.`;

const EXPLORE_PROMPT = `You are a read-only code exploration subagent working for another agent. Answer its request by searching and reading the workspace efficiently:
- Prefer grep (files_with_matches first) and glob to locate code; read only relevant ranges; make parallel tool calls.
- You cannot modify files or run commands.
When done, reply with a concise report the caller can act on: the direct answer, key file paths with line numbers, and short code excerpts only where essential. No preamble. Aim for under 400 words.`;

const GENERAL_PROMPT = `You are a subagent working for another agent on a self-contained task in the user's workspace. You can search, read, edit files, and run commands.
- Read before editing; use edit_file for changes to existing files; verify with diagnostics or a build/test command when relevant.
- Stay strictly within the task's scope.
When done, reply with a concise report: what you changed (file paths), verification results, and any open issues. No preamble.`;

let environmentCache: { key: string; text: Promise<string> } | undefined;

async function readInstructions(root: vscode.Uri): Promise<string> {
  const parts: string[] = [];
  for (const name of INSTRUCTION_FILES) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name));
      const text = new TextDecoder().decode(bytes).trim();
      if (text) {
        parts.push(`From ${name}:\n${text}`);
      }
    } catch {
      // not present
    }
  }
  const joined = parts.join("\n\n");
  return joined.length > MAX_INSTRUCTIONS_CHARS ? `${joined.slice(0, MAX_INSTRUCTIONS_CHARS)}\n[truncated]` : joined;
}

async function gitBranch(root: vscode.Uri): Promise<string | undefined> {
  try {
    const head = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ".git", "HEAD")));
    const match = head.match(/ref: refs\/heads\/(.+)/);
    return match ? match[1].trim() : "detached HEAD";
  } catch {
    return undefined;
  }
}

async function buildEnvironment(shell: string): Promise<string> {
  const root = getRoot();
  const [profile, branch, instructions, entries] = await Promise.all([
    analyzeRepository(),
    gitBranch(root),
    readInstructions(root),
    Promise.resolve(vscode.workspace.fs.readDirectory(root)).catch(() => [] as [string, vscode.FileType][]),
  ]);
  const excluded = new Set([...EXCLUDED_DIRS]);
  const listing = entries
    .filter(([name]) => !excluded.has(name))
    .sort((a, b) => (b[1] & vscode.FileType.Directory) - (a[1] & vscode.FileType.Directory) || a[0].localeCompare(b[0]))
    .slice(0, 60)
    .map(([name, type]) => (type & vscode.FileType.Directory ? `${name}/` : name))
    .join("  ");

  const lines = [
    `Workspace root: ${root.fsPath}`,
    `OS: ${os.type()} ${os.release()} (${process.platform})`,
    `Shell for run_command: ${shellDescription(shell)}${process.platform === "win32" && !shell ? " — use cmd syntax (no ls/cat/grep; use dir, type, or the file tools)" : ""}`,
    `Project: ${profile.language}${profile.framework ? ` / ${profile.framework}` : ""}${profile.packageManager ? ` (package manager: ${profile.packageManager})` : ""}`,
  ];
  const commands = [
    profile.buildCommand && `build: ${profile.buildCommand}`,
    profile.testCommand && `test: ${profile.testCommand}`,
    profile.lintCommand && `lint: ${profile.lintCommand}`,
  ].filter(Boolean);
  if (commands.length) {
    lines.push(`Likely commands: ${commands.join("; ")}`);
  }
  if (branch) {
    lines.push(`Git branch: ${branch}`);
  }
  lines.push(`Root entries: ${listing || "(empty)"}`);

  let text = `# Environment\n${lines.join("\n")}`;
  if (instructions) {
    text += `\n\n# Project instructions (follow these)\n${instructions}`;
  }
  return text;
}

/** Environment text is cached per workspace/shell so the system prompt stays byte-identical (prefix-cache friendly). */
export function getEnvironment(shell: string, refresh = false): Promise<string> {
  const key = `${vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? ""}|${shell}`;
  if (refresh || !environmentCache || environmentCache.key !== key) {
    environmentCache = { key, text: buildEnvironment(shell).catch((err) => `# Environment\n(unavailable: ${err})`) };
  }
  return environmentCache.text;
}

export async function systemPromptFor(kind: "main" | "explore" | "general", shell: string): Promise<string> {
  const base = kind === "main" ? MAIN_PROMPT : kind === "explore" ? EXPLORE_PROMPT : GENERAL_PROMPT;
  return `${base}\n\n${await getEnvironment(shell)}`;
}
