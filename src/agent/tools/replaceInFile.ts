import * as vscode from "vscode";
import { Tool } from "../types";
import { RepositoryCache } from "../cache";

export class ReplaceInFileTool implements Tool {
  name = "replace_in_file";
  description = "Apply a search-and-replace edit to an existing file in the workspace. Arguments: { \"path\": \"relative/path/to/file\", \"search\": \"exact text block to replace\", \"replace\": \"replacement text block\" }";
  schema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file to modify"
      },
      search: {
        type: "string",
        description: "The exact code block to search for and replace"
      },
      replace: {
        type: "string",
        description: "The new replacement code block"
      }
    },
    required: ["path", "search", "replace"]
  };

  async execute(args: { path: string; search: string; replace: string }): Promise<{ success: boolean; message: string } | string> {
    if (!args || typeof args.path !== "string" || typeof args.search !== "string" || typeof args.replace !== "string") {
      throw new Error("Invalid arguments: 'path', 'search', and 'replace' must be strings.");
    }
    if (args.search === args.replace) {
      return "NO_CHANGES_REQUIRED";
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
      return { success: false, message: `File does not exist: ${args.path}` };
    }

    const content = doc.getText();
    
    // Construct regex to find the search block regardless of differences in line-endings (\r\n vs \n)
    const escapeRegExp = (str: string) => {
      return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    };
    const escapedSearch = escapeRegExp(args.search);
    const regexStr = escapedSearch.replace(/\r?\n/g, "\\r?\\n");
    const regex = new RegExp(regexStr, "g");

    const matches = [...content.matchAll(regex)];
    if (matches.length === 0) {
      return {
        success: false,
        message: `Error: Search block not found in '${args.path}'. Please verify spelling, spaces, and indentation.`
      };
    }
    if (matches.length > 1) {
      return {
        success: false,
        message: `Error: Multiple matches found for the search block in '${args.path}'. Please include more surrounding context lines to make it unique.`
      };
    }

    const match = matches[0];
    const startIndex = match.index!;
    const endIndex = startIndex + match[0].length;

    const startPos = doc.positionAt(startIndex);
    const endPos = doc.positionAt(endIndex);

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(startPos, endPos), args.replace);
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      await doc.save();
      RepositoryCache.getInstance().setFileContent(args.path, doc.getText());
      
      // Structured tool success feedback
      return {
        success: true,
        message: `SUCCESS\nTool: replace_in_file\nFile: ${args.path}\nOperation: Patched\nCharacters Written: ${args.replace.length}`
      };
    } else {
      return { success: false, message: `Failed to apply workspace edit to ${args.path}` };
    }
  }
}
