import { useEffect, useRef, useState } from "react";
import { DEFAULT_MCP_URL, McpConnection } from "../mcpClient";
import type { McpConfiguration } from "../mcpTypes";

export default function McpPanel({
  connection,
  busy,
  onChange,
}: {
  connection: McpConnection;
  busy: boolean;
  onChange: (configuration: McpConfiguration | undefined) => void;
}) {
  const [url, setUrl] = useState(DEFAULT_MCP_URL);
  const [configuration, setConfiguration] = useState<McpConfiguration>();
  const [enabled, setEnabled] = useState<string[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  const connect = async () => {
    setConnecting(true);
    setError("");
    onChange(undefined);
    setConfiguration(undefined);
    setEnabled([]);
    try {
      const next = await connection.connect(url);
      setConfiguration(next);
      // Connecting alone never gives the model access; select tools explicitly.
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnecting(false);
    }
  };
  const select = (names: string[]) => {
    if (busyRef.current || !configuration) return;
    setEnabled(names);
    onChange({
      ...configuration,
      tools: configuration.tools.filter((tool) => names.includes(tool.name)),
    });
  };
  return (
    <details className="mcp">
      <summary>
        Optional MCP tools ·{" "}
        <span className="muted">{configuration ? `${enabled.length} enabled` : "disconnected"}</span>
      </summary>
      <p className="muted small">
        Connect a Streamable HTTP server (for example Exa web search), then select tools. Tool
        arguments leave this browser and go to that server. Browser access (CORS) is required.
        Results over 8000 characters are shortened. Built-in tools stay available.
      </p>
      <fieldset disabled={busy || connecting} className="mcp__form">
        <label className="mcp__url">
          <span className="small">MCP server URL</span>
          <input value={url} onChange={(event) => setUrl(event.target.value)} type="url" />
        </label>
        <div className="mcp__buttons">
          <button type="button" className="button" onClick={() => void connect()}>
            {connecting ? "Connecting…" : "Connect"}
          </button>
          {configuration && (
            <button
              type="button"
              className="button"
              onClick={() => {
                onChange(undefined);
                setConfiguration(undefined);
                setEnabled([]);
                void connection.disconnect();
              }}
            >
              Disconnect
            </button>
          )}
        </div>
        {configuration && (
          <div className="mcp__tools">
            <p className="small">Connected to {configuration.url}. Select tools before starting a run.</p>
            {configuration.tools.length === 0 && (
              <p className="small">No compatible tools found (built-in name conflicts are skipped).</p>
            )}
            {configuration.tools.map((tool) => (
              <label key={tool.name} className="mcp__tool">
                <input
                  type="checkbox"
                  checked={enabled.includes(tool.name)}
                  onChange={(event) =>
                    select(
                      event.target.checked
                        ? [...enabled, tool.name]
                        : enabled.filter((name) => name !== tool.name)
                    )
                  }
                />
                <span>
                  <strong>{tool.name}</strong>{" "}
                  <span className="muted small">{tool.description}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      {busy && (
        <p className="small muted">
          Connection and tool selection are fixed during a run. Stop before changing them.
        </p>
      )}
      {error && (
        <p className="notice notice--danger" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
