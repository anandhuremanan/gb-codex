import { Tool } from "../types";
import { RepositoryCache } from "../cache";

export class ReadFileTool implements Tool {
  name = "read_file";
  description = "Read the content of a file in the workspace. Arguments: { \"path\": \"relative/path/to/file\" }";

  async execute(args: { path: string }): Promise<string> {
    if (!args || typeof args.path !== "string") {
      throw new Error("Invalid arguments: 'path' must be a string.");
    }
    const cache = RepositoryCache.getInstance();
    return cache.getFileContent(args.path);
  }
}

