import * as vscode from "vscode";
import { exec } from "child_process";
import { RepositoryCache } from "./cache";

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

  const cache = RepositoryCache.getInstance();
  const profile = cache.getProfile();

  if (profile.language === "Unknown") {
    return {
      success: true,
      command: "none",
      stdout: "No build/test configuration detected. Skipping build validation.",
      stderr: "",
      code: 0
    };
  }

  // Deduce the command based on the repository profile
  let command = "";

  if (profile.buildCommand) {
    command = profile.buildCommand;
  } else if (profile.testCommand) {
    command = profile.testCommand;
  } else {
    // Language fallbacks
    switch (profile.language) {
      case "TypeScript":
      case "JavaScript":
        command = "npx tsc --noEmit";
        break;
      case "Go":
        command = "go build ./...";
        break;
      case "Rust":
        command = "cargo build";
        break;
      case "Python":
        command = "python -m unittest";
        break;
      case "Java":
        command = profile.packageManager === "gradle" ? "gradle build" : "mvn package";
        break;
      case "C#":
        command = "dotnet build";
        break;
      default:
        // Generic fallback: check if we can run typecheck or build
        command = "npm run build";
        break;
    }
  }

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
