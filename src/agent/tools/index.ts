import { Tool } from "./types";
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
