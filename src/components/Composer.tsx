import { Play, Square } from "lucide-react";
import { useState } from "react";
import { AGENT_TOOLS, OPTIONAL_TOOLS, WEBPAGE_READER_AVAILABLE } from "../agentConfig";
import type { McpConnection } from "../mcpClient";
import type { McpConfiguration } from "../mcpTypes";
import McpPanel from "./McpPanel";
import { ToolIcon } from "./ToolIcon";

const EXAMPLES = [
  "How far is it from Paris to Berlin in miles, and how long would it take at 80 km/h?",
  "What is the history of the Riverside, California citrus industry?",
  ...(WEBPAGE_READER_AVAILABLE
    ? ["Read https://en.wikipedia.org/wiki/WebGPU and explain what WebGPU is used for."]
    : []),
  "What's the weather like this time of year where I am?",
];

export default function Composer({
  canRun,
  busy,
  modelReady,
  enabledTools,
  onToggleTool,
  onRun,
  onStop,
  mcpConnection,
  onMcpChange,
}: {
  canRun: boolean;
  busy: boolean;
  modelReady: boolean;
  enabledTools: string[];
  onToggleTool(name: string): void;
  onRun(prompt: string): void;
  onStop(): void;
  mcpConnection: McpConnection;
  onMcpChange(configuration: McpConfiguration | undefined): void;
}) {
  const [prompt, setPrompt] = useState("");
  const submit = () => {
    if (prompt.trim() && canRun) onRun(prompt.trim());
  };

  return (
    <section className="card composer">
      <label htmlFor="prompt" className="label">
        Your task
      </label>
      <textarea
        id="prompt"
        className="composer__input"
        rows={3}
        placeholder="Ask a research question, paste a URL, or give it something to calculate…"
        value={prompt}
        disabled={busy}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
        }}
      />
      <div className="chips" aria-label="Examples">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className="chip"
            disabled={busy}
            onClick={() => setPrompt(example)}
          >
            {example}
          </button>
        ))}
      </div>

      <fieldset className="tools" disabled={busy}>
        <legend className="label">Tools</legend>
        {OPTIONAL_TOOLS.map((name) => {
          const tool = AGENT_TOOLS.find((entry) => entry.name === name)!;
          const on = enabledTools.includes(name);
          return (
            <label key={name} className={`toggle ${on ? "toggle--on" : ""}`} title={tool.description}>
              <input type="checkbox" checked={on} onChange={() => onToggleTool(name)} />
              <ToolIcon name={name} size={14} />
              {tool.label}
            </label>
          );
        })}
      </fieldset>

      <McpPanel connection={mcpConnection} busy={busy} onChange={onMcpChange} />

      <div className="composer__actions">
        {!modelReady && <span className="muted small">Load the model first.</span>}
        {busy ? (
          <button type="button" className="button button--danger" onClick={onStop}>
            <Square size={14} aria-hidden /> Stop
          </button>
        ) : (
          <button
            type="button"
            className="button button--primary"
            disabled={!canRun || !prompt.trim()}
            onClick={submit}
            title="Run (⌘/Ctrl + Enter)"
          >
            <Play size={14} aria-hidden /> Run agent
          </button>
        )}
      </div>
    </section>
  );
}
