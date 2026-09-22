import { Tool } from "./types";
import { createSkillTool } from "./skill";
import { SkillMeta } from "../../skills/types";
import { readFileTool } from "./readFile";
import { editFileTool } from "./editFile";
import { writeFileTool } from "./writeFile";
import { globTool, grepTool, listDirTool } from "./search";
import { runCommandTool } from "./runCommand";
import { todoWriteTool } from "./todoWrite";
import { taskTool } from "./task";

const readOnlyTools: Tool[] = [readFileTool, grepTool, globTool, listDirTool];

export const toolSets = {
  main: [...readOnlyTools, editFileTool, writeFileTool, runCommandTool, todoWriteTool, taskTool] as Tool[],
  explore: readOnlyTools,
  general: [...readOnlyTools, editFileTool, writeFileTool, runCommandTool] as Tool[],
};

export type ToolSetName = keyof typeof toolSets;

/**
 * Tools for an agent. The `skill` tool is added only when skills exist, so a workspace
 * without skills sends exactly the same tool schemas (and prompt) as before the feature.
 */
export function toolsFor(kind: ToolSetName, getSkills?: () => SkillMeta[]): Tool[] {
  const base = toolSets[kind];
  if (!getSkills || getSkills().every((s) => !s.valid)) {
    return base;
  }
  return [...base, createSkillTool(getSkills)];
}
