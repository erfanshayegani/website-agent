import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AGENT_TOOLS } from "./agentConfig";
import type { McpConfiguration } from "./mcpTypes";

export const DEFAULT_MCP_URL = "https://mcp.exa.ai/mcp";
export const MCP_RESULT_CHAR_LIMIT = 8000;

export function validateMcpUrl(value: string): URL {
  const url = new URL(value.trim());
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Use an HTTPS MCP URL, or HTTP on localhost, without embedded credentials."
    );
  return url;
}

export function compactMcpResult(
  response: Record<string, unknown>
): Record<string, unknown> {
  const result = response.structuredContent ?? {
    content: response.content ?? [],
  };
  const serialized = JSON.stringify(result);
  if (serialized.length <= MCP_RESULT_CHAR_LIMIT)
    return { isError: response.isError === true, data: result };
  const content = Array.isArray(response.content) ? response.content : [];
  const text = content
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("\n");
  return {
    isError: response.isError === true,
    truncated: true,
    original_characters: serialized.length,
    character_limit: MCP_RESULT_CHAR_LIMIT,
    text: (text || serialized).slice(0, MCP_RESULT_CHAR_LIMIT),
  };
}

export class McpConnection {
  private client: Client | null = null;
  private configuration: McpConfiguration | null = null;
  private callSignal: AbortSignal | undefined;

  async connect(rawUrl: string): Promise<McpConfiguration> {
    const url = validateMcpUrl(rawUrl);
    await this.disconnect();
    const client = new Client({ name: "lfm-2.6b-agent", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          // Optional server-to-client GET streams are unnecessary for tool calls.
          fetch: (input, init) =>
            String(init?.method ?? "GET").toUpperCase() === "GET"
              ? Promise.resolve(new Response(null, { status: 405 }))
              : fetch(input, {
                  ...init,
                  signal: this.callSignal
                    ? AbortSignal.any([
                        this.callSignal,
                        ...(init?.signal ? [init.signal] : []),
                      ])
                    : init?.signal,
                }),
        }),
        { timeout: 20000 }
      );
      const tools: McpConfiguration["tools"] = [];
      const names = new Set<string>(AGENT_TOOLS.map((tool) => tool.name));
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const tool of page.tools) {
          if (
            !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(tool.name) ||
            names.has(tool.name) ||
            tool.inputSchema.type !== "object"
          )
            continue;
          names.add(tool.name);
          tools.push({
            name: tool.name,
            description: tool.description ?? tool.name,
            parameters: structuredClone(tool.inputSchema),
          });
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor))
          throw new Error("MCP server repeated a tool-list cursor.");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      this.client = client;
      this.configuration = { url: url.href, tools };
      return structuredClone(this.configuration);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async disconnect() {
    const client = this.client;
    this.client = null;
    this.configuration = null;
    await client?.close().catch(() => undefined);
  }

  async call(
    url: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ) {
    if (!this.client || this.configuration?.url !== url)
      throw new Error(
        "Connect to this session's MCP server in the agent tab before continuing: " +
          url
      );
    if (!this.configuration.tools.some((tool) => tool.name === name))
      throw new Error(
        "This tool is not advertised by the connected MCP server: " + name
      );
    signal.throwIfAborted();
    const controller = new AbortController();
    const callSignal = AbortSignal.any([signal, controller.signal]);
    this.callSignal = callSignal;
    try {
      const response = await this.client.callTool(
        { name, arguments: args },
        undefined,
        { signal: callSignal, timeout: 60000 }
      );
      callSignal.throwIfAborted();
      return compactMcpResult(response);
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      if (this.callSignal === callSignal) this.callSignal = undefined;
    }
  }
}
