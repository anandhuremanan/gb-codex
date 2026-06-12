import * as vscode from "vscode";
import * as path from "path";

// ─── Find a file anywhere in the workspace by name ───────────────────────────

export async function findFileInWorkspace(
  filename: string,
): Promise<vscode.Uri | null> {
  const results = await vscode.workspace.findFiles(
    `**/${filename}`,
    "**/node_modules/**",
    1,
  );
  return results[0] ?? null;
}

// ─── Read a file's text content ──────────────────────────────────────────────

export async function readFile(uri: vscode.Uri): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder("utf8").decode(bytes);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to read file: ${err}`);
    return null;
  }
}

// ─── Write text content to a file ────────────────────────────────────────────

export async function writeFile(
  uri: vscode.Uri,
  content: string,
): Promise<boolean> {
  try {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to write file: ${err}`);
    return false;
  }
}

// ─── Extract filename mentions from a chat message ───────────────────────────
// Matches patterns like: index.html  src/app.ts  ./utils/helper.js

export function extractFilenameFromMessage(message: string): string | null {
  const match = message.match(
    /([a-zA-Z0-9_\-./]+\.(html|css|js|ts|json|py|md|txt|jsx|tsx|scss|yaml|yml))/,
  );
  return match ? path.basename(match[1]) : null;
}

// ─── Pull the first fenced code block out of model output ────────────────────

export function extractCodeBlock(response: string): string | null {
  const match = response.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}
