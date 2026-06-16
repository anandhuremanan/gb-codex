import { Tool } from "../types";
import { RepositoryCache } from "../cache";

export class ListFilesTool implements Tool {
  name = "list_workspace_files";
  description = "List all file relative paths in the workspace (excluding build output, dependencies, and git metadata). Use this to discover files and inspect project structure.";

  async execute(): Promise<string[]> {
    const cache = RepositoryCache.getInstance();
    return cache.getWorkspaceTree();
  }
}