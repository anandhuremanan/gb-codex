/** Where a skill came from, which decides how much it is trusted. */
export type SkillSource = "project" | "package" | "user";

export interface SkillMeta {
  name: string;
  description: string;
  source: SkillSource;
  /** Absolute path of the skill folder. */
  dir: string;
  /** Absolute path of SKILL.md. */
  file: string;
  /** Where the skill came from, for the UI (e.g. ".gbs/skills" or "@gbs/ui"). */
  origin: string;
  /** Globs that make this skill relevant to the file the user is working on. */
  autoAttach: string[];
  /** Problems found while loading; the skill is still listed unless `valid` is false. */
  warnings: string[];
  valid: boolean;
}

export interface SkillCatalog {
  skills: SkillMeta[];
  /** Rendered catalog for the system prompt; empty when there are no usable skills. */
  text: string;
  approxTokens: number;
  /** True when project or package skills exist and the user has not enabled them yet. */
  needsConsent: boolean;
}

export const SKILL_FILE = "SKILL.md";
/** Descriptions are capped well below Anthropic's 1024 chars: the catalog is in every request. */
export const MAX_DESCRIPTION_CHARS = 240;
export const MAX_NAME_CHARS = 64;
/** Body cap (~1.5k tokens). Authors are told to split the rest into reference files. */
export const MAX_BODY_CHARS = 6000;
export const MAX_RESOURCE_CHARS = 12000;
/** Above this many skills the catalog is trimmed to auto-attached ones to protect the prompt. */
export const MAX_CATALOG_SKILLS = 12;
