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

export class ValidationStrategy {
  public static getValidationCommand(profile: any, modifiedFiles: string[]): string {
    // 1. React / Frontend Framework light check
    if (profile.framework === "React" || profile.framework === "Next.js" || profile.framework === "Vue") {
      const lintableFiles = modifiedFiles.filter(f => f.match(/\.(ts|tsx|js|jsx)$/));
      if (lintableFiles.length > 0) {
        return `npx eslint ${lintableFiles.join(" ")}`;
      }
    }

    // 2. TypeScript / JavaScript check
    if (profile.language === "TypeScript") {
      return "npx tsc --noEmit";
    }

    // 3. Go check
    if (profile.language === "Go") {
      return "go build ./...";
    }

    // 4. Rust check
    if (profile.language === "Rust") {
      return "cargo check";
    }

    // 5. Python check
    if (profile.language === "Python") {
      const pythonFiles = modifiedFiles.filter(f => f.endsWith(".py"));
      const testFiles = pythonFiles.filter(f => f.includes("test_") || f.endsWith("_test.py"));
      if (testFiles.length > 0) {
        return `pytest ${testFiles.join(" ")}`;
      }
      if (pythonFiles.length > 0) {
        return `python -m py_compile ${pythonFiles.join(" ")}`;
      }
      return profile.testCommand || "pytest";
    }

    // Fallbacks
    if (profile.buildCommand) {
      return profile.buildCommand;
    }
    if (profile.testCommand) {
      return profile.testCommand;
    }

    return "npm run build";
  }
}

export async function validateBuild(modifiedFiles: string[] = []): Promise<ValidationResult> {
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

  // Determine the command dynamically based on the ValidationStrategy
  const command = ValidationStrategy.getValidationCommand(profile, modifiedFiles);

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
