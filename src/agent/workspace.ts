import * as path from "path";
import * as vscode from "vscode";

export const EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".gradle",
  ".idea",
  ".vscode-test",
];

export const EXCLUDE_GLOB = `**/{${EXCLUDED_DIRS.join(",")}}/**`;

export function getRoot(): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    throw new Error("No workspace folder is open.");
  }
  return root;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolves a user/model supplied path and ensures it stays within an open workspace folder. */
export function resolvePath(input: string | undefined): vscode.Uri {
  const root = getRoot();
  const raw = (input ?? "").trim().replace(/^["']|["']$/g, "");
  if (!raw || raw === ".") {
    return root;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const fsPath = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root.fsPath, raw);
  const compare = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const inside = folders.some((f) => isInside(compare(f.uri.fsPath), compare(fsPath)));
  if (!inside) {
    throw new Error(`Path "${input}" is outside the workspace. Only files inside the open workspace can be accessed.`);
  }
  return vscode.Uri.file(fsPath);
}

/** Workspace-relative path with forward slashes. */
export function relPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
}

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key && !d.isClosed);
}

export async function exists(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

/** Identifies the current file state, so edits can require an up-to-date read. */
export async function versionToken(uri: vscode.Uri): Promise<string | undefined> {
  const doc = openDocument(uri);
  if (doc?.isDirty) {
    return `doc:${doc.version}`;
  }
  const stat = await exists(uri);
  return stat ? `disk:${stat.mtime}:${stat.size}` : undefined;
}

export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}

/** Reads text, preferring the open editor buffer (which may contain unsaved changes). */
export async function readText(uri: vscode.Uri): Promise<string> {
  const doc = openDocument(uri);
  if (doc) {
    return doc.getText();
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (looksBinary(bytes)) {
    throw new Error(`${relPath(uri)} appears to be a binary file.`);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Writes text; goes through the editor buffer when the file is open so undo and dirty state stay consistent. */
export async function writeText(uri: vscode.Uri, content: string): Promise<void> {
  const doc = openDocument(uri);
  if (doc) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error(`VS Code rejected the edit to ${relPath(uri)}.`);
    }
    await doc.save();
    return;
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
}

/** Approximate added/removed line counts (common prefix/suffix trimmed). */
export function lineDiffStats(before: string, after: string): { added: number; removed: number } {
  const a = before.length ? before.split(/\r?\n/) : [];
  const b = after.length ? after.split(/\r?\n/) : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  return { added: Math.max(0, endB - start + 1), removed: Math.max(0, endA - start + 1) };
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[... ${omitted} characters omitted ...]\n\n${text.slice(-tail)}`;
}
