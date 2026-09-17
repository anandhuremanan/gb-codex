import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Tool } from "./types";
import { EXCLUDED_DIRS, EXCLUDE_GLOB, getRoot, looksBinary, relPath, resolvePath } from "../workspace";
import { throwIfAborted } from "../../llm/http";

const GLOB_LIMIT = 200;

// ─── glob ────────────────────────────────────────────────────────────────────

interface GlobArgs {
  pattern: string;
  path?: string;
}

export const globTool: Tool<GlobArgs> = {
  name: "glob",
  description:
    'Find files by glob pattern, e.g. "**/*.tsx" or "src/**/user*.ts". Patterns are relative to `path` (default: workspace root); a pattern without "**/" only matches at that level. Dependency and build folders are excluded. Returns up to 200 paths.',
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern." },
      path: { type: "string", description: "Directory to search in, relative to the workspace root." },
    },
    required: ["pattern"],
  },
  readOnly: true,
  title: (a) => (a.path ? `${a.pattern} in ${a.path}` : a.pattern),
  async execute(args, ctx) {
    const base = resolvePath(args.path);
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(base, args.pattern.replace(/^\.\//, "")),
      EXCLUDE_GLOB,
      GLOB_LIMIT + 1,
    );
    throwIfAborted(ctx.signal);
    const paths = found.map(relPath).sort();
    if (paths.length === 0) {
      return { content: `No files match ${args.pattern}.` };
    }
    const shown = paths.slice(0, GLOB_LIMIT);
    const more = paths.length > GLOB_LIMIT ? `\n(More than ${GLOB_LIMIT} matches; use a narrower pattern.)` : "";
    return { content: shown.join("\n") + more };
  },
};

// ─── list_dir ────────────────────────────────────────────────────────────────

interface ListArgs {
  path?: string;
}

const LIST_LIMIT = 300;

export const listDirTool: Tool<ListArgs> = {
  name: "list_dir",
  description:
    "List the direct children of a directory (directories end with /). Cheaper than glob for getting oriented in a folder.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory relative to the workspace root (default: root)." },
    },
  },
  readOnly: true,
  title: (a) => a.path || ".",
  async execute(args) {
    const uri = resolvePath(args.path);
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return { content: `Not a readable directory: ${args.path ?? "."}`, isError: true };
    }
    const excluded = new Set(EXCLUDED_DIRS);
    const dirs: string[] = [];
    const files: string[] = [];
    let hidden = 0;
    for (const [name, type] of entries) {
      if (type & vscode.FileType.Directory) {
        if (excluded.has(name)) {
          hidden++;
          continue;
        }
        dirs.push(`${name}/`);
      } else {
        files.push(name);
      }
    }
    dirs.sort();
    files.sort();
    const all = [...dirs, ...files];
    let content = all.slice(0, LIST_LIMIT).join("\n") || "(empty directory)";
    if (all.length > LIST_LIMIT) {
      content += `\n(${all.length - LIST_LIMIT} more entries not shown)`;
    }
    if (hidden) {
      content += `\n(${hidden} dependency/build folder(s) omitted)`;
    }
    return { content, ui: { path: relPath(uri) } };
  },
};

// ─── grep ────────────────────────────────────────────────────────────────────

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "files_with_matches" | "content" | "count";
  case_insensitive?: boolean;
  context?: number;
  head_limit?: number;
}

let ripgrepPath: string | null | undefined;

function findRipgrep(): string | null {
  if (ripgrepPath !== undefined) {
    return ripgrepPath;
  }
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  const arch = `${process.platform}-${process.arch}`;
  const app = vscode.env.appRoot;
  const candidates = [
    path.join(app, "node_modules", "@vscode", "ripgrep", "bin", exe),
    path.join(app, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", exe),
    path.join(app, "node_modules.asar.unpacked", "@vscode", "ripgrep-universal", "bin", arch, exe),
    path.join(app, "node_modules", "@vscode", "ripgrep-universal", "bin", arch, exe),
  ];
  ripgrepPath = candidates.find((c) => fs.existsSync(c)) ?? null;
  return ripgrepPath;
}

function runRipgrep(rg: string, rgArgs: string[], cwd: string, maxLines: number, signal: AbortSignal): Promise<string[]> {
  return new Promise((resolve, reject) => {
    // stdin must be closed: with a piped stdin ripgrep searches stdin instead of the directory and never exits.
    const child = spawn(rg, rgArgs, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    let buffer = "";
    let stderr = "";
    let truncated = false;
    const onAbort = () => child.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      truncated = true;
      child.kill();
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) {
        return;
      }
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        lines.push(buffer.slice(0, nl).replace(/\r$/, ""));
        buffer = buffer.slice(nl + 1);
        if (lines.length > maxLines) {
          truncated = true;
          child.kill();
          return;
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        reject(new Error("Cancelled by user."));
        return;
      }
      if (buffer && !truncated) {
        lines.push(buffer);
      }
      // rg exits 1 when there are no matches, 2 on errors (bad regex, unreadable file).
      if (code === 2 && lines.length === 0 && stderr.trim()) {
        reject(new Error(stderr.trim().split("\n").slice(0, 3).join("\n")));
        return;
      }
      resolve(lines);
    });
  });
}

async function grepFallback(args: GrepArgs, base: vscode.Uri, maxLines: number, signal: AbortSignal): Promise<string[]> {
  const regex = new RegExp(args.pattern, args.case_insensitive ? "i" : "");
  const include = new vscode.RelativePattern(base, args.glob ? (args.glob.includes("/") ? args.glob : `**/${args.glob}`) : "**/*");
  const files = await vscode.workspace.findFiles(include, EXCLUDE_GLOB, 5000);
  const mode = args.output_mode ?? "files_with_matches";
  const out: string[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    let bytes: Uint8Array;
    try {
      const stat = await vscode.workspace.fs.stat(file);
      if (stat.size > 1_000_000) {
        continue;
      }
      bytes = await vscode.workspace.fs.readFile(file);
    } catch {
      continue;
    }
    if (looksBinary(bytes)) {
      continue;
    }
    const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
    const rel = relPath(file);
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        count++;
        if (mode === "content") {
          out.push(`${rel}:${i + 1}:${lines[i].slice(0, 400)}`);
        }
      }
    }
    if (count && mode === "files_with_matches") {
      out.push(rel);
    } else if (count && mode === "count") {
      out.push(`${rel}:${count}`);
    }
    if (out.length > maxLines) {
      break;
    }
  }
  return out;
}

export const grepTool: Tool<GrepArgs> = {
  name: "grep",
  description:
    "Search file contents with a regular expression (ripgrep syntax). Respects .gitignore. output_mode: \"files_with_matches\" (default, cheapest), \"content\" (matching lines with line numbers; supports `context`), or \"count\". Filter files with `glob` (e.g. \"*.ts\") and narrow with `path`. Start with files_with_matches, then read or grep specific files.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "File or directory to search, relative to the workspace root." },
      glob: { type: "string", description: 'File filter, e.g. "*.py" or "src/**/*.tsx".' },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
      case_insensitive: { type: "boolean" },
      context: { type: "number", description: "Lines of context around each match (content mode only)." },
      head_limit: { type: "number", description: "Maximum result lines to return (default 100)." },
    },
    required: ["pattern"],
  },
  readOnly: true,
  title: (a) => `"${a.pattern}"${a.path ? ` in ${a.path}` : ""}${a.glob ? ` (${a.glob})` : ""}`,
  async execute(args, ctx) {
    const root = getRoot();
    const target = resolvePath(args.path);
    const mode = args.output_mode ?? "files_with_matches";
    const limit = Math.max(1, Math.min(500, Math.floor(args.head_limit ?? 100)));
    const rg = findRipgrep();

    let lines: string[];
    if (rg) {
      const rgArgs = ["--color", "never", "--no-messages", "--path-separator", "/", "--max-columns", "400", "--max-columns-preview"];
      if (mode === "files_with_matches") {
        rgArgs.push("-l");
      } else if (mode === "count") {
        rgArgs.push("-c");
      } else {
        rgArgs.push("-n", "--no-heading", "--with-filename");
        if (args.context) {
          rgArgs.push("-C", String(Math.min(10, Math.max(0, Math.floor(args.context)))));
        }
      }
      if (args.case_insensitive) {
        rgArgs.push("-i");
      }
      if (args.glob) {
        rgArgs.push("--glob", args.glob);
      }
      for (const dir of EXCLUDED_DIRS) {
        rgArgs.push("--glob", `!${dir}/`);
      }
      rgArgs.push("--regexp", args.pattern);
      const relTarget = path.relative(root.fsPath, target.fsPath);
      rgArgs.push("--", relTarget || ".");
      lines = (await runRipgrep(rg, rgArgs, root.fsPath, limit, ctx.signal)).map((l) => l.replace(/^\.\//, ""));
    } else {
      lines = await grepFallback(args, target, limit, ctx.signal);
    }

    if (mode !== "content") {
      lines.sort();
    }
    if (lines.length === 0) {
      return { content: `No matches for ${JSON.stringify(args.pattern)}.` };
    }
    const shown = lines.slice(0, limit);
    const more = lines.length > limit ? `\n(Results truncated at ${limit}; narrow the search or raise head_limit.)` : "";
    return { content: shown.join("\n") + more };
  },
};
