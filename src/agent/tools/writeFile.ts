import * as vscode from "vscode";
import { Tool } from "../types";
import { RepositoryCache } from "../cache";

export class WriteFileTool implements Tool {
  name = "write_file";
  description = "Edit/write content to a file in the workspace. Arguments: { \"path\": \"relative/path/to/file\", \"content\": \"updated content\" }";

  async execute(args: { path: string; content: string }): Promise<{ success: boolean; message: string }> {
    if (!args || typeof args.path !== "string" || typeof args.content !== "string") {
      throw new Error("Invalid arguments: 'path' and 'content' must be strings.");
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      throw new Error("No workspace folder open.");
    }
    const uri = vscode.Uri.joinPath(root, args.path);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      // Fallback: If document doesn't exist, create it.
      const createEdit = new vscode.WorkspaceEdit();
      createEdit.createFile(uri, { overwrite: true, ignoreIfExists: true });
      createEdit.insert(uri, new vscode.Position(0, 0), args.content);
      const applied = await vscode.workspace.applyEdit(createEdit);
      if (applied) {
        doc = await vscode.workspace.openTextDocument(uri);
        await doc.save();
        RepositoryCache.getInstance().setFileContent(args.path, args.content);
        return { success: true, message: `Created and wrote to ${args.path}` };
      }
      throw new Error(`File does not exist and failed to create: ${err}`);
    }

    // Line-based minimal diffing to apply WorkspaceEdit edits
    const oldLines = doc.getText().split(/\r?\n/);
    const newLines = args.content.split(/\r?\n/);

    let startLine = 0;
    while (startLine < oldLines.length && startLine < newLines.length && oldLines[startLine] === newLines[startLine]) {
      startLine++;
    }

    let oldEnd = oldLines.length - 1;
    let newEnd = newLines.length - 1;

    while (oldEnd >= startLine && newEnd >= startLine && oldLines[oldEnd] === newLines[newEnd]) {
      oldEnd--;
      newEnd--;
    }

    const replacedText = newLines.slice(startLine, newEnd + 1).join('\n');
    const startPosition = new vscode.Position(startLine, 0);
    const endPosition = oldEnd < startLine
      ? new vscode.Position(startLine, 0)
      : doc.lineAt(oldEnd).range.end;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(startPosition, endPosition), replacedText);
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      await doc.save();
      RepositoryCache.getInstance().setFileContent(args.path, args.content);
      return { success: true, message: `Successfully updated ${args.path} with minimal edits.` };
    } else {
      return { success: false, message: `Failed to apply workspace edit to ${args.path}.` };
    }
  }
}

