import * as vscode from "vscode";
import { relPath } from "./workspace";

const MAX_WAIT_MS = 1500;
const SETTLE_MS = 250;
const MAX_ENTRIES = 15;

/**
 * Waits briefly for language servers to re-analyze the changed files, then
 * returns a compact list of errors. Far cheaper than running a full build
 * after every edit.
 */
export async function collectDiagnostics(uris: vscode.Uri[], signal: AbortSignal): Promise<string> {
  if (uris.length === 0) {
    return "";
  }
  const keys = new Set(uris.map((u) => u.toString()));

  // Opening the documents makes language servers analyze them.
  await Promise.all(uris.map((u) => Promise.resolve(vscode.workspace.openTextDocument(u)).catch(() => undefined)));

  await new Promise<void>((resolve) => {
    let settleTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      clearTimeout(maxTimer);
      clearTimeout(settleTimer);
      sub.dispose();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const sub = vscode.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => keys.has(u.toString()))) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(finish, SETTLE_MS);
      }
    });
    const maxTimer = setTimeout(finish, MAX_WAIT_MS);
    signal.addEventListener("abort", finish, { once: true });
  });

  const lines: string[] = [];
  let total = 0;
  for (const uri of uris) {
    const errors = vscode.languages
      .getDiagnostics(uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    total += errors.length;
    for (const d of errors) {
      if (lines.length >= MAX_ENTRIES) {
        break;
      }
      const code = typeof d.code === "object" ? d.code.value : d.code;
      lines.push(`  ${relPath(uri)}:${d.range.start.line + 1}: ${d.message.split("\n")[0]}${code ? ` (${code})` : ""}`);
    }
  }
  if (total === 0) {
    return "";
  }
  const more = total > lines.length ? `\n  ... and ${total - lines.length} more` : "";
  return `\n\n<diagnostics>\nThe editor reports ${total} error(s) after this change:\n${lines.join("\n")}${more}\n</diagnostics>`;
}
