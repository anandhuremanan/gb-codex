import { Tool } from "./types";

interface Args {
  description: string;
  prompt: string;
  subagent_type?: "explore" | "general";
}

export const taskTool: Tool<Args> = {
  name: "task",
  description: `Launch a subagent that works independently in its own context and returns only a final report. This keeps your own context small and lets work run in parallel.
- "explore" (default): read-only research — finding where something is implemented, tracing how a feature works, surveying many files. Several explore tasks in one response run concurrently.
- "general": a self-contained multi-step job that may edit files and run commands (runs sequentially).
The subagent cannot see this conversation: write a complete, specific prompt (goal, relevant paths/names you already know, and exactly what to report back). Do not use it for a single known-file read or a simple grep — call those tools directly.`,
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "3-6 word label shown to the user." },
      prompt: { type: "string", description: "Complete, self-contained instructions for the subagent." },
      subagent_type: { type: "string", enum: ["explore", "general"] },
    },
    required: ["description", "prompt"],
  },
  readOnly: false,
  isConcurrencySafe: (a) => (a.subagent_type ?? "explore") === "explore",
  title: (a) => a.description || "Subagent",
  async execute(args, ctx) {
    if (typeof args.prompt !== "string" || !args.prompt.trim()) {
      return { content: "prompt must be a non-empty string.", isError: true };
    }
    const report = await ctx.host.runSubagent({
      type: args.subagent_type === "general" ? "general" : "explore",
      description: args.description || "Subagent",
      prompt: args.prompt,
      parentItemId: ctx.itemId,
      signal: ctx.signal,
    });
    return { content: report };
  },
};
