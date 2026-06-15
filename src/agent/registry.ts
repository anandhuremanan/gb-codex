import { Tool } from "./types";
import { ListFilesTool } from "./tools/listFiles";
import { ReadFileTool } from "./tools/readFile";
import { WriteFileTool } from "./tools/writeFile";
import { CreateFileTool } from "./tools/createFile";
import { SearchWorkspaceTool } from "./tools/searchWorkspace";
import { RunTerminalCommandTool } from "./tools/runCommand";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  public register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  public getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  public getTools(): Tool[] {
    return Array.from(this.tools.values());
  }
}

export const globalRegistry = new ToolRegistry();
globalRegistry.register(new ListFilesTool());
globalRegistry.register(new ReadFileTool());
globalRegistry.register(new WriteFileTool());
globalRegistry.register(new CreateFileTool());
globalRegistry.register(new SearchWorkspaceTool());
globalRegistry.register(new RunTerminalCommandTool());

