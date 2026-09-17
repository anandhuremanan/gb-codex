import { Tool } from "./types";
import { Todo } from "../transcript";

interface Args {
  todos: Todo[];
}

const STATUSES = new Set(["pending", "in_progress", "completed"]);

export const todoWriteTool: Tool<Args> = {
  name: "todo_write",
  description:
    "Create or update the task checklist shown to the user. Use it for multi-step work (3+ steps): send the full list every time, keep exactly one item in_progress while working, and mark items completed as soon as they are done. Skip it for simple one-step requests.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete, updated list.",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Imperative description, e.g. 'Add login route'." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  readOnly: true,
  title: (a) => {
    const todos = Array.isArray(a.todos) ? a.todos : [];
    const done = todos.filter((t) => t?.status === "completed").length;
    return `${done}/${todos.length} done`;
  },
  async execute(args, ctx) {
    if (!Array.isArray(args.todos)) {
      return { content: "todos must be an array.", isError: true };
    }
    const todos: Todo[] = args.todos
      .filter((t) => t && typeof t.content === "string" && t.content.trim())
      .map((t) => ({
        content: t.content.trim(),
        status: STATUSES.has(t.status) ? t.status : "pending",
      }));
    ctx.host.setTodos(todos);
    const open = todos.filter((t) => t.status !== "completed").length;
    return { content: `Todo list updated (${todos.length - open} completed, ${open} remaining).` };
  },
};
