import { Tool } from "./types";
import { checkFreshRead } from "./editFile";
import { exists, lineDiffStats, readText, relPath, resolvePath, versionToken, writeText } from "../workspace";

interface Args {
  path: string;
  content: string;
}

export const writeFileTool: Tool<Args> = {
  name: "write_file",
  description:
    "Create a new file, or completely overwrite an existing one (you must read an existing file first). Parent directories are created automatically. For partial changes to existing files use edit_file instead — it is much cheaper.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace root." },
      content: { type: "string", description: "The complete file content." },
    },
    required: ["path", "content"],
  },
  readOnly: false,
  permission: (a) => ({ kind: "edit", detail: `Write ${a.path}` }),
  title: (a) => a.path,
  async execute(args, ctx) {
    if (typeof args.content !== "string") {
      return { content: "content must be a string.", isError: true };
    }
    const uri = resolvePath(args.path);
    const rel = relPath(uri);
    const stat = await exists(uri);
    let before: string | undefined;
    if (stat) {
      const stale = await checkFreshRead(uri, ctx);
      if (stale) {
        return { content: stale, isError: true };
      }
      before = await readText(uri);
    }

    await writeText(uri, args.content);
    const token = await versionToken(uri);
    if (token) {
      ctx.state.readVersions.set(uri.fsPath, token);
    }
    ctx.fileChanged(uri);
    const snapshotId = ctx.host.recordFileChange(uri, before, args.content);
    const stats = lineDiffStats(before ?? "", args.content);
    const lineCount = args.content.length ? args.content.split(/\r?\n/).length : 0;
    return {
      content: `${before === undefined ? "Created" : "Overwrote"} ${rel} (${lineCount} lines).`,
      ui: { path: rel, stats, snapshotId },
    };
  },
};
