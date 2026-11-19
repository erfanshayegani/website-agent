// Serializable snapshots travel with sessions so edited branches retain their tools.
export interface McpTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface McpConfiguration {
  url: string;
  tools: McpTool[];
}
