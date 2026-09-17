import { PermissionMode } from "../config";
import { PermissionKind } from "./tools/types";

const SHELL_META = /[;&|<>`$()\n]/;
const SAFE_COMMANDS = /^(git (status|diff|log|show|branch|rev-parse|ls-files)|pwd|ls|dir|node --version|npm --version|npm ls)(\s|$)/i;

/** "npm run build" -> "npm run build"; "git commit -m x" -> "git commit"; flags end the prefix. */
export function commandPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/);
  const prefix: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("-") || /["'=/\\.]/.test(token) || prefix.length === 3) {
      break;
    }
    prefix.push(token);
    if (prefix.length === 2 && !["run", "exec", "x"].includes(token)) {
      break;
    }
  }
  return prefix.join(" ") || tokens[0] || "";
}

export class PermissionPolicy {
  private readonly allowedCommandPrefixes = new Set<string>();
  private editsAllowedForSession = false;

  needsApproval(kind: PermissionKind, detail: string, mode: PermissionMode): boolean {
    if (mode === "auto") {
      return false;
    }
    if (kind === "edit") {
      return mode === "ask" && !this.editsAllowedForSession;
    }
    const command = detail.trim();
    if (!SHELL_META.test(command) && SAFE_COMMANDS.test(command)) {
      return false;
    }
    if (SHELL_META.test(command)) {
      return true;
    }
    return !this.allowedCommandPrefixes.has(commandPrefix(command));
  }

  allowAlways(kind: PermissionKind, detail: string): void {
    if (kind === "edit") {
      this.editsAllowedForSession = true;
    } else {
      this.allowedCommandPrefixes.add(commandPrefix(detail));
    }
  }

  reset(): void {
    this.allowedCommandPrefixes.clear();
    this.editsAllowedForSession = false;
  }

  describeAlways(kind: PermissionKind, detail: string): string {
    return kind === "edit" ? "Allow all edits this session" : `Always allow \`${commandPrefix(detail)}\``;
  }
}
