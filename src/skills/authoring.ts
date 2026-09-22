import * as vscode from "vscode";
import { SKILL_FILE } from "./types";

const TEMPLATE = (name: string) => `---
name: ${name}
description: One sentence on what this covers, then when to use it (keep under 240 characters — it is sent with every request).
# autoAttach: ["src/**/*.tsx"]   # optional: files that make this skill relevant
---

# ${name}

## When to use this
Replace with the situations this skill applies to.

## Rules
- The conventions that matter, stated as instructions.
- What people get wrong.

## Details
Move long material into files next to this one and link them, so they load only when needed:
- Example: see references/example.md
`;

function suggestTarget(userSkillsDir: vscode.Uri | undefined): { label: string; base: vscode.Uri }[] {
  const options: { label: string; base: vscode.Uri }[] = [];
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (root) {
    options.push({ label: "This project (.gbs/skills) — shared with everyone on the repo", base: vscode.Uri.joinPath(root, ".gbs", "skills") });
  }
  if (userSkillsDir) {
    options.push({ label: "My skills folder — available in every project", base: userSkillsDir });
  }
  return options;
}

/** Scaffolds a skill folder with a SKILL.md and opens it. */
export async function createSkill(userSkillsDir: vscode.Uri | undefined): Promise<void> {
  const targets = suggestTarget(userSkillsDir);
  if (!targets.length) {
    vscode.window.showWarningMessage("Open a folder first, or configure gbsAgent.skillsPath.");
    return;
  }
  let picked = targets[0];
  if (targets.length > 1) {
    const label = await vscode.window.showQuickPick(
      targets.map((t) => t.label),
      { title: "Where should this skill live?" },
    );
    const chosen = targets.find((t) => t.label === label);
    if (!chosen) {
      return;
    }
    picked = chosen;
  }
  const name = await vscode.window.showInputBox({
    title: "New skill",
    prompt: "Skill name (lowercase letters, numbers and hyphens)",
    placeHolder: "component-library",
    validateInput: (value) =>
      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value.trim()) ? undefined : "Use lowercase letters, numbers and hyphens, e.g. component-library",
  });
  if (!name) {
    return;
  }
  const dir = vscode.Uri.joinPath(picked.base, name.trim());
  const file = vscode.Uri.joinPath(dir, SKILL_FILE);
  try {
    await vscode.workspace.fs.stat(file);
    vscode.window.showWarningMessage(`${name} already exists.`);
  } catch {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(TEMPLATE(name.trim())));
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
}

/** Opens the personal skills folder, creating it on first use. */
export async function openSkillsFolder(dir: vscode.Uri | undefined): Promise<void> {
  if (!dir) {
    vscode.window.showWarningMessage("No skills folder configured (gbsAgent.skillsPath).");
    return;
  }
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.commands.executeCommand("revealFileInOS", dir);
}
