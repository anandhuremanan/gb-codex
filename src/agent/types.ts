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
