import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { exec } from "child_process";

export interface ValidationResult {
  success: boolean;
  command: string;
  stdout: string;
  stderr: string;
  code: number;
}

export async function validateBuild(): Promise<ValidationResult> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    throw new Error("No workspace folder open.");
  }

  let hasBuildScript = false;
  const packageJsonPath = path.join(root, "package.json");

  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (pkg.scripts && typeof pkg.scripts.build === "string") {
        hasBuildScript = true;
      }
    } catch {
      // Ignore parsing errors and default to tsc
    }
  }

  const command = hasBuildScript ? "npm run build" : "npx tsc --noEmit";

  return new Promise((resolve) => {
    exec(command, { cwd: root }, (error, stdout, stderr) => {
      const code = error ? (error.code ?? 1) : 0;
      resolve({
        success: code === 0,
        command,
        stdout,
        stderr,
        code
      });
    });
  });
}
