import { Tool } from "./types";
import { isSensitiveRead } from "../permissions";
import { readText, relPath, resolvePath, versionToken } from "../workspace";

const DEFAULT_LIMIT = 1000;
const MAX_LINE_CHARS = 1500;

interface Args {
  path: string;
  offset?: number;
  limit?: number;
}

export const readFileTool: Tool<Args> = {
  name: "read_file",
  description:
    "Read a text file. Returns lines prefixed with line numbers (`N\\tline`). Reads up to 1000 lines by default; for large files pass `offset` (1-based start line) and `limit` to read only the relevant range. You can read several files in parallel by calling this tool multiple times in one response.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace root." },
      offset: { type: "number", description: "1-based line number to start reading from." },
      limit: { type: "number", description: "Maximum number of lines to read." },
    },
    required: ["path"],
  },
  readOnly: true,
  permission: (a) => {
    const rel = relPath(resolvePath(a.path));
    return isSensitiveRead(rel) ? { kind: "read", detail: `Read ${rel} (may contain credentials)`, path: rel } : undefined;
  },
  title: (a) => {
    const range = a.offset || a.limit ? ` · lines ${a.offset ?? 1}–${(a.offset ?? 1) + (a.limit ?? DEFAULT_LIMIT) - 1}` : "";
    return `${a.path}${range}`;
  },
  async execute(args, ctx) {
    const uri = resolvePath(args.path);
    let text: string;
    try {
      text = await readText(uri);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/EntryNotFound|ENOENT|FileNotFound|nonexistent/i.test(message)) {
        return { content: `File not found: ${args.path}. Use glob or list_dir to find the correct path.`, isError: true };
      }
      if (/EntryIsADirectory|EISDIR/i.test(message)) {
        return { content: `${args.path} is a directory. Use list_dir instead.`, isError: true };
      }
      throw err;
    }

    const token = await versionToken(uri);
    if (token) {
      ctx.state.readVersions.set(uri.fsPath, token);
    }

    const lines = text.split(/\r?\n/);
    if (text.length === 0) {
      return { content: `${relPath(uri)} is empty.`, ui: { path: relPath(uri) } };
    }
    const start = Math.max(1, Math.floor(args.offset ?? 1));
    const limit = Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT));
    const end = Math.min(lines.length, start + limit - 1);
    if (start > lines.length) {
      return { content: `Offset ${start} is past the end of the file (${lines.length} lines).`, isError: true };
    }

    const out: string[] = [];
    for (let i = start; i <= end; i++) {
      const line = lines[i - 1];
      out.push(`${i}\t${line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + " [line truncated]" : line}`);
    }
    let content = out.join("\n");
    if (start > 1 || end < lines.length) {
      content += `\n\n(Showing lines ${start}-${end} of ${lines.length}. Use offset/limit to read other parts.)`;
    }
    return { content, ui: { path: relPath(uri), line: start } };
  },
};
