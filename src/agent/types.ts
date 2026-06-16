import * as vscode from "vscode";

export interface Tool {
  name: string;
  description: string;
  schema: object;
  execute(args: any): Promise<any>;
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ToolCall {
  tool: string;
  args: any;
}

export interface AgentState {
  modifiedFiles: string[];
  completedObjectives: string[];
  discoveredFiles: string[];
  buildErrors: string[];
  recentlyModifiedFiles: string[];
  searchResults: string[];
  openedFiles: string[];
  discoveredSymbols: string[];
  finishHints: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TaskSubtask {
  description: string;
  completed: boolean;
}

export interface TaskPlan {
  goal: string;
  subtasks: TaskSubtask[];
}

export interface TaskMemory {
  currentGoal: string;
  activeFiles: string[];
  relatedFiles: string[];
  visitedFiles: string[];
  visitedQueries: string[];
  discoveredFacts: string[];
  completedActions: string[];
  createdFiles: string[];
  modifiedFiles: string[];
  rejectedFiles: string[];
  plan?: TaskPlan;
}

export interface SessionTaskSummary {
  goal: string;
  summary: string;
  modifiedFiles: string[];
  createdFiles: string[];
  symbolsTouched?: string[];
  timestamp: number;
}

export interface SessionMemory {
  workspaceId: string;
  workspacePathHash: string;
  recentTasks: SessionTaskSummary[];
  lastUpdated: number;
}

export interface RunningAgent {
  cancellationSource: vscode.CancellationTokenSource;
  promise: Promise<void>;
}

export interface AgentSession {
  taskMemory: TaskMemory;
  sessionMemory: SessionMemory;
  chatHistory: ChatMessage[];
  currentExecution?: RunningAgent;
}
