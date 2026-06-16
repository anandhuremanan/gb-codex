import * as vscode from "vscode";
import { Tool } from "../types";
import { RepositoryCache } from "../cache";

export class GetDirectoryContextTool implements Tool {
  name = "get_directory_context";
  description = "Get context for a directory, including sibling files, child routes, and nearby components/pages. Arguments: { \"path\": \"relative/path/to/directory\" }";
  schema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the directory to inspect"
      }
    },
    required: ["path"]
  };

  async execute(args: { path: string }): Promise<string> {
    if (!args || typeof args.path !== "string") {
      throw new Error("Invalid arguments: 'path' must be a string.");
    }

    const cache = RepositoryCache.getInstance();
    const tree = cache.getWorkspaceTree();

    const targetDir = args.path.replace(/[\\/]$/, ""); // strip trailing slash
    const targetDirNormalized = targetDir.replace(/\\/g, "/");

    const directChildren: string[] = [];
    const nestedFiles: string[] = [];
    const nearbyComponents: string[] = [];
    const nearbyPages: string[] = [];

    // Find parent directory to find nearby things
    const targetParent = targetDirNormalized.includes("/") 
      ? targetDirNormalized.substring(0, targetDirNormalized.lastIndexOf("/"))
      : "";

    for (const filePath of tree) {
      const normalizedPath = filePath.replace(/\\/g, "/");
      
      // Check if it is under target directory
      if (normalizedPath.startsWith(targetDirNormalized + "/")) {
        const relative = normalizedPath.substring(targetDirNormalized.length + 1);
        if (!relative.includes("/")) {
          directChildren.push(filePath);
        } else {
          nestedFiles.push(filePath);
        }
      }

      // Check if nearby (shares target parent)
      if (targetParent && normalizedPath.startsWith(targetParent + "/")) {
        const relative = normalizedPath.substring(targetParent.length + 1);
        const lowerRelative = relative.toLowerCase();
        if (lowerRelative.includes("component") && !normalizedPath.startsWith(targetDirNormalized + "/")) {
          nearbyComponents.push(filePath);
        }
        if ((lowerRelative.includes("page") || lowerRelative.includes("route") || lowerRelative.includes("app")) && !normalizedPath.startsWith(targetDirNormalized + "/")) {
          nearbyPages.push(filePath);
        }
      }
    }

    return JSON.stringify({
      siblingFiles: directChildren,
      childRoutes: nestedFiles,
      nearbyComponents: nearbyComponents.slice(0, 10),
      nearbyPages: nearbyPages.slice(0, 10)
    }, null, 2);
  }
}
