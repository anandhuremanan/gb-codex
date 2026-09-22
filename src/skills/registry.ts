import * as path from "path";
import * as vscode from "vscode";
import { matchesGlob, parseSkill } from "./frontmatter";
import { MAX_CATALOG_SKILLS, SKILL_FILE, SkillCatalog, SkillMeta, SkillSource } from "./types";

/** Folders inside the workspace that may contain skills. `.claude/skills` is read for compatibility. */
const PROJECT_SKILL_DIRS = [".gbs/skills", ".claude/skills"];
const MAX_SKILLS = 64;
const MAX_SKILL_FILE_BYTES = 256 * 1024;

const decoder = new TextDecoder("utf-8");

async function readFile(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_SKILL_FILE_BYTES) {
      return undefined;
    }
    return decoder.decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function readSkillFolder(dir: vscode.Uri, source: SkillSource, origin: string): Promise<SkillMeta | undefined> {
  const file = vscode.Uri.joinPath(dir, SKILL_FILE);
  const text = await readFile(file);
  if (text === undefined) {
    return undefined;
  }
  const parsed = parseSkill(text);
  const fallbackName = path.basename(dir.fsPath).toLowerCase();
  return {
    name: parsed.name ?? fallbackName,
    description: parsed.description ?? "",
    source,
    dir: dir.fsPath,
    file: file.fsPath,
    origin,
    autoAttach: parsed.autoAttach,
    warnings: parsed.warnings,
    valid: !!parsed.name && !!parsed.description,
  };
}

async function readSkillsIn(parent: vscode.Uri, source: SkillSource, origin: string): Promise<SkillMeta[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(parent);
  } catch {
    return [];
  }
  const found: SkillMeta[] = [];
  for (const [name, type] of entries) {
    if (!(type & vscode.FileType.Directory) || name.startsWith(".")) {
      continue;
    }
    const skill = await readSkillFolder(vscode.Uri.joinPath(parent, name), source, origin);
    if (skill) {
      found.push(skill);
    }
  }
  return found;
}

/** Skills shipped inside dependencies that opt in with a `gbsSkills` array in their package.json. */
async function readPackageSkills(root: vscode.Uri): Promise<SkillMeta[]> {
  const manifest = await readFile(vscode.Uri.joinPath(root, "package.json"));
  if (!manifest) {
    return [];
  }
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(manifest);
  } catch {
    return [];
  }
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const found: SkillMeta[] = [];
  for (const dep of deps) {
    if (found.length >= MAX_SKILLS) {
      break;
    }
    const depRoot = vscode.Uri.joinPath(root, "node_modules", ...dep.split("/"));
    const depManifest = await readFile(vscode.Uri.joinPath(depRoot, "package.json"));
    if (!depManifest) {
      continue;
    }
    let entries: unknown;
    try {
      entries = (JSON.parse(depManifest) as { gbsSkills?: unknown }).gbsSkills;
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries.slice(0, 10)) {
      if (typeof entry !== "string" || entry.includes("..")) {
        continue;
      }
      const skill = await readSkillFolder(vscode.Uri.joinPath(depRoot, ...entry.split("/")), "package", dep);
      if (skill) {
        found.push(skill);
      }
    }
  }
  return found;
}

export interface SkillRegistryOptions {
  /** User-level skills folder (machine setting, or the extension's global storage). */
  userSkillsDir?: vscode.Uri;
  /** Whether project and package skills may be used (asked once per workspace). */
  projectSkillsAllowed: boolean;
}

/**
 * Finds skills and renders the catalog. Results are cached until `invalidate()` so the
 * system prompt stays byte-identical across the steps of a session.
 */
export class SkillRegistry {
  private cache?: { key: string; skills: SkillMeta[] };

  invalidate(): void {
    this.cache = undefined;
  }

  async list(options: SkillRegistryOptions): Promise<SkillMeta[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const key = `${root?.toString() ?? ""}|${options.userSkillsDir?.toString() ?? ""}|${options.projectSkillsAllowed}`;
    if (this.cache?.key === key) {
      return this.cache.skills;
    }

    const groups: SkillMeta[][] = [];
    if (options.userSkillsDir) {
      groups.push(await readSkillsIn(options.userSkillsDir, "user", "user skills folder"));
    }
    if (root && options.projectSkillsAllowed) {
      groups.push(await readPackageSkills(root));
      for (const dir of PROJECT_SKILL_DIRS) {
        groups.push(await readSkillsIn(vscode.Uri.joinPath(root, ...dir.split("/")), "project", dir));
      }
    }

    // Later groups win, so a project skill overrides a package skill, which overrides a user skill.
    const byName = new Map<string, SkillMeta>();
    for (const group of groups) {
      for (const skill of group) {
        byName.set(skill.name, skill);
      }
    }
    const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SKILLS);
    this.cache = { key, skills };
    return skills;
  }

}

/** Renders the always-loaded part of skills: one line per skill. */
export function renderCatalog(skills: SkillMeta[], activeFile?: string): SkillCatalog {
  const usable = skills.filter((s) => s.valid);
  if (usable.length === 0) {
    return { skills, text: "", approxTokens: 0, needsConsent: false };
  }
  const attached = activeFile ? usable.filter((s) => s.autoAttach.some((g) => matchesGlob(g, activeFile))) : [];
  // With many skills, list the ones relevant to the current file first and trim the tail.
  const ordered = [...attached, ...usable.filter((s) => !attached.includes(s))];
  const listed = ordered.slice(0, MAX_CATALOG_SKILLS);
  const omitted = ordered.length - listed.length;

  const lines = listed.map((s) => `- ${s.name}: ${s.description}`);
  const text = `# Skills
Project- and team-specific instructions you can load when they apply. Call the \`skill\` tool with the name to read the full instructions before doing that kind of work; load a skill at most once per conversation.
${lines.join("\n")}${omitted > 0 ? `\n(${omitted} more skill(s) available; ask the user if you need one that is not listed.)` : ""}`;
  return { skills, text, approxTokens: Math.ceil(text.length / 3.5), needsConsent: false };
}

/** One short line added to a user turn when the open file matches a skill's autoAttach globs. */
export function autoAttachHint(skills: SkillMeta[], activeFile: string | undefined): string {
  if (!activeFile) {
    return "";
  }
  const names = skills
    .filter((s) => s.valid && s.autoAttach.some((g) => matchesGlob(g, activeFile)))
    .map((s) => s.name);
  return names.length ? `\n\n<skills_hint>Relevant skill(s) for ${activeFile}: ${names.join(", ")}.</skills_hint>` : "";
}
