export interface Tool {
  name: string;
  description: string;
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
