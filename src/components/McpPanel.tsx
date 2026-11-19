import { useEffect, useState } from "react";
import { DEFAULT_MCP_URL, McpConnection } from "../mcpClient";
import type { McpConfiguration } from "../mcpTypes";

/** Exa tools shown in the panel. Fixed: visitors can't change them.
 *  web_fetch_exa stays off because it duplicates read_webpage (which already
 *  uses Exa to download pages on the public site). */
const EXA_TOOLS = [
  { name: "web_search_exa", description: "Search the web and get clean, ready-to-use results.", on: true },
  { name: "web_fetch_exa", description: "Read a webpage's full content as Markdown.", on: false },
] as const;
const ENABLED = new Set<string>(EXA_TOOLS.filter((tool) => tool.on).map((tool) => tool.name));
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

// One connection per page, shared across React's dev double-mount.
let connecting: Promise<McpConfiguration> | null = null;

function connectWithRetry(connection: McpConnection): Promise<McpConfiguration> {
  connecting ??= (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await connection.connect(DEFAULT_MCP_URL);
      } catch (error) {
        if (attempt >= RETRY_DELAYS_MS.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      }
    }
  })();
  return connecting;
}

/**
 * Exa web tools: always connected (silently, on page load) with a fixed tool
 * selection. The panel only displays what the agent can use.
 */
export default function McpPanel({
  connection,
  onChange,
}: {
  connection: McpConnection;
  onChange: (configuration: McpConfiguration | undefined) => void;
}) {
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    connectWithRetry(connection).then(
      (configuration) =>
        onChange({
          ...configuration,
          tools: configuration.tools.filter((tool) => ENABLED.has(tool.name)),
        }),
      () => setUnavailable(true)
    );
  }, [connection, onChange]);

  return (
    <details className="mcp">
      <summary>
        Exa web tools <span className="muted">· web search on</span>
      </summary>
      <p className="muted small">
        Web search by Exa. Search queries are sent to Exa from your browser; results over 8000
        characters are shortened.
      </p>
      <ul className="mcp__tools">
        {EXA_TOOLS.map((tool) => (
          <li key={tool.name} className="mcp__tool">
            <input type="checkbox" checked={tool.on} disabled readOnly aria-label={tool.name} />
            <span>
              <strong>{tool.name}</strong>{" "}
              <span className="muted small">{tool.description}</span>
            </span>
          </li>
        ))}
      </ul>
      {unavailable && (
        <p className="muted small" role="status">
          Exa is unreachable right now; the built-in tools still work.
        </p>
      )}
    </details>
  );
}
