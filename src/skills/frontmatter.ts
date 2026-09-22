import { MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS } from "./types";

export interface ParsedSkill {
  name?: string;
  description?: string;
  autoAttach: string[];
  body: string;
  warnings: string[];
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Minimal YAML front-matter reader for the handful of fields a skill declares.
 * Only `key: value` and simple lists are supported, which keeps this dependency-free
 * and means a malformed skill degrades to a warning instead of breaking the session.
 */
export function parseSkill(text: string): ParsedSkill {
  const result: ParsedSkill = { autoAttach: [], body: text.trim(), warnings: [] };
  const match = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    result.warnings.push("Missing YAML front matter (--- name / description ---).");
    return result;
  }
  result.body = match[2].trim();

  const fields = new Map<string, string>();
  const lists = new Map<string, string[]>();
  let listKey: string | undefined;
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }
    const item = line.match(/^\s+-\s*(.+)$/);
    if (item && listKey) {
      lists.get(listKey)!.push(unquote(item[1]));
      continue;
    }
    const pair = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!pair) {
      continue;
    }
    const [, key, value] = pair;
    if (!value.trim()) {
      listKey = key;
      lists.set(key, []);
      continue;
    }
    listKey = undefined;
    const inline = value.match(/^\[(.*)\]$/);
    if (inline) {
      lists.set(
        key,
        inline[1]
          .split(",")
          .map((v) => unquote(v.trim()))
          .filter(Boolean),
      );
    } else {
      fields.set(key, unquote(value.trim()));
    }
  }

  result.name = fields.get("name");
  result.description = fields.get("description");
  result.autoAttach = lists.get("autoAttach") ?? lists.get("auto_attach") ?? [];

  if (!result.name) {
    result.warnings.push("Front matter has no `name`.");
  } else if (result.name.length > MAX_NAME_CHARS || !NAME_PATTERN.test(result.name)) {
    result.warnings.push(`\`name\` must be lowercase letters, numbers and hyphens (max ${MAX_NAME_CHARS} chars).`);
    result.name = undefined;
  }
  if (!result.description) {
    result.warnings.push("Front matter has no `description`; the agent needs it to know when to use the skill.");
  } else if (result.description.length > MAX_DESCRIPTION_CHARS) {
    result.warnings.push(
      `\`description\` is ${result.description.length} chars; it is sent with every request, so keep it under ${MAX_DESCRIPTION_CHARS}.`,
    );
    result.description = `${result.description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`;
  }
  if (result.body.split(/\r?\n/).length > 500) {
    result.warnings.push("SKILL.md body is over 500 lines; move detail into reference files next to it.");
  }
  return result;
}

function unquote(value: string): string {
  const trimmed = value.trim().replace(/\s+#.*$/, "");
  const quoted = trimmed.match(/^(["'])([\s\S]*)\1$/);
  return quoted ? quoted[2] : trimmed;
}

/** Very small glob matcher for autoAttach patterns (`**`, `*`, `?`). */
export function matchesGlob(pattern: string, relPath: string): boolean {
  const escaped = pattern
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0002")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0001/g, "(?:.*/)?")
    .replace(/\u0002/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(relPath.replace(/\\/g, "/"));
}
