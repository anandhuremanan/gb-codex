import * as vscode from "vscode";
import { Tool, ToolContext } from "./types";
import { exists, lineDiffStats, readText, relPath, resolvePath, versionToken, writeText } from "../workspace";

interface Args {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export function previewText(text: unknown, max = 1500): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/** Ensures the agent has seen the current version of an existing file before modifying it. */
export async function checkFreshRead(uri: vscode.Uri, ctx: ToolContext): Promise<string | undefined> {
  const seen = ctx.state.readVersions.get(uri.fsPath);
  if (!seen) {
    return `You must read ${relPath(uri)} with read_file before modifying it.`;
  }
  const current = await versionToken(uri);
  if (current && current !== seen) {
    return `${relPath(uri)} has changed since you last read it (possibly edited by the user). Read it again before modifying it.`;
  }
  return undefined;
}

/** Finds `needle` in `haystack`, tolerating LF vs CRLF differences. */
export function findOccurrences(haystack: string, needle: string): { positions: number[]; needle: string } {
  const variants = [needle];
  if (haystack.includes("\r\n") && !needle.includes("\r\n") && needle.includes("\n")) {
    variants.push(needle.replace(/\n/g, "\r\n"));
  } else if (!haystack.includes("\r\n") && needle.includes("\r\n")) {
    variants.push(needle.replace(/\r\n/g, "\n"));
  }
  for (const variant of variants) {
    const positions: number[] = [];
    let from = 0;
    while (true) {
      const idx = haystack.indexOf(variant, from);
      if (idx < 0) {
        break;
      }
      positions.push(idx);
      from = idx + Math.max(variant.length, 1);
    }
    if (positions.length) {
      return { positions, needle: variant };
    }
  }
  return { positions: [], needle };
}

/** Suggests where a failed old_string probably was, to help the model self-correct cheaply. */
export function nearMissHint(content: string, oldString: string): string {
  const firstLine = oldString.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
  if (!firstLine) {
    return "";
  }
  const lines = content.split(/\r?\n/);
  const hits: number[] = [];
  for (let i = 0; i < lines.length && hits.length < 3; i++) {
    if (lines[i].trim() === firstLine) {
      hits.push(i + 1);
    }
  }
  if (hits.length) {
    return ` A line matching the first line of old_string exists at line(s) ${hits.join(", ")}; the surrounding lines or whitespace/indentation differ. Re-read that range and copy the text exactly.`;
  }
  return " Re-read the file and copy the exact text, including indentation.";
}

export const editFileTool: Tool<Args> = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. `old_string` must match the file exactly (including whitespace and indentation, without the line-number prefix from read_file) and must be unique unless `replace_all` is true; include enough surrounding lines to make it unique. Prefer this over write_file for changes to existing files. You must read the file first.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the workspace root." },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: { type: "string", description: "Replacement text (must differ from old_string)." },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
    },
    required: ["path", "old_string", "new_string"],
  },
  readOnly: false,
  permission: (a) => {
    const rel = relPath(resolvePath(a.path));
    return { kind: "edit", detail: `Edit ${rel}`, path: rel, preview: previewText(a.new_string) };
  },
  title: (a) => a.path,
  async execute(args, ctx) {
    const uri = resolvePath(args.path);
    const rel = relPath(uri);
    if (typeof args.old_string !== "string" || typeof args.new_string !== "string") {
      return { content: "old_string and new_string must be strings.", isError: true };
    }
    if (args.old_string === args.new_string) {
      return { content: "old_string and new_string are identical; nothing to change.", isError: true };
    }
    if (!(await exists(uri))) {
      return { content: `File not found: ${args.path}. Use write_file to create new files.`, isError: true };
    }
    if (args.old_string === "") {
      return { content: "old_string is empty. Use write_file to create or fully rewrite a file.", isError: true };
    }
    const stale = await checkFreshRead(uri, ctx);
    if (stale) {
      return { content: stale, isError: true };
    }

    const before = await readText(uri);
    const { positions, needle } = findOccurrences(before, args.old_string);
    if (positions.length === 0) {
      return { content: `old_string was not found in ${rel}.${nearMissHint(before, args.old_string)}`, isError: true };
    }
    if (positions.length > 1 && !args.replace_all) {
      return {
        content: `old_string matches ${positions.length} locations in ${rel}. Add more surrounding context to make it unique, or set replace_all to true.`,
        isError: true,
      };
    }

    const replacement = needle.includes("\r\n") ? args.new_string.replace(/\r?\n/g, "\r\n") : args.new_string;
    let after = "";
    let cursor = 0;
    for (const pos of positions) {
      after += before.slice(cursor, pos) + replacement;
      cursor = pos + needle.length;
    }
    after += before.slice(cursor);

    await writeText(uri, after);
    const token = await versionToken(uri);
    if (token) {
      ctx.state.readVersions.set(uri.fsPath, token);
    }
    ctx.fileChanged(uri);
    const snapshotId = ctx.host.recordFileChange(uri, before, after);
    const stats = lineDiffStats(before, after);
    const line = before.slice(0, positions[0]).split("\n").length;
    return {
      content: `Edited ${rel}: replaced ${positions.length} occurrence(s) at line ${line} (+${stats.added} -${stats.removed} lines).`,
      ui: { path: rel, line, stats, snapshotId },
    };
  },
};
