import { Tool } from "../types";

export class FinishTool implements Tool {
  name = "finish";
  description = "Signal task completion. This will immediately stop the agent's reasoning loop. Arguments: { \"summary\": \"final explanation of the task completion\" }";
  schema = {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "A detailed summary of the changes made and results."
      }
    },
    required: ["summary"]
  };

  async execute(args: { summary: string }): Promise<{ success: boolean; message: string }> {
    return {
      success: true,
      message: `SUCCESS\nTool: finish\nSummary: ${args.summary}`
    };
  }
}
