import { Rocket, Square } from "lucide-react";
import { useState } from "react";
import { AGENT_TOOLS, OPTIONAL_TOOLS } from "../agentConfig";
import type { McpConnection } from "../mcpClient";
import type { McpConfiguration } from "../mcpTypes";
import McpPanel from "./McpPanel";
import { ToolIcon } from "./ToolIcon";

// Each example exercises a different part of the harness.
const EXAMPLES = [
  {
    emoji: "🛰️",
    title: "Sunrises in orbit",
    hint: "Python",
    prompt:
      "The ISS circles Earth about every 92 minutes. How many sunrises do astronauts see in a day and in a year? Check the math with Python.",
  },
  {
    emoji: "🧬",
    title: "DNA to the Moon",
    hint: "Wikipedia + Python",
    prompt:
      "If you stretched out all the DNA in one human cell end to end, how long would it be? How many cells' worth would reach the Moon?",
  },
  {
    emoji: "📍",
    title: "Where am I?",
    hint: "Location + Wikipedia",
    prompt: "Where am I right now, and what is one surprising bit of history about this place?",
  },
  {
    emoji: "🛡️",
    title: "Read & explain",
    hint: "Read webpage",
    prompt:
      "Read https://en.wikipedia.org/wiki/Prompt_injection and explain the main attack types and defenses it describes.",
  },
  {
    emoji: "🔎",
    title: "What's new?",
    hint: "Exa web search",
    prompt:
      "Search the web for recent news about on-device AI in the browser and summarize the three most interesting items with links.",
  },
  {
    emoji: "🏛️",
    title: "History, your way",
    hint: "Asks you first",
    prompt: "Tell me about the history of Persia.",
  },
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
      <div className="prompt">
        <textarea
          id="prompt"
          aria-label="Your task"
          className="prompt__input"
          rows={4}
          placeholder="Ask a research question, paste a URL, or give it something to calculate…"
          value={prompt}
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
          }}
        />
        <div className="prompt__actions">
          <span className="muted small">
            {modelReady ? "⌘/Ctrl + Enter" : "Wake up the agent first"}
          </span>
          {busy ? (
            <button type="button" className="button button--danger" onClick={onStop}>
              <Square size={14} aria-hidden /> Stop
            </button>
          ) : (
            <button
              type="button"
              className="button button--glow"
              disabled={!canRun || !prompt.trim()}
              onClick={submit}
            >
              <Rocket size={15} aria-hidden /> Launch
            </button>
          )}
        </div>
      </div>

      <div>
        <h2 className="label">Try an example</h2>
        <div className="examples">
          {EXAMPLES.map((example) => (
            <button
              key={example.title}
              type="button"
              className={`example ${prompt === example.prompt ? "example--active" : ""}`}
              disabled={busy}
              onClick={() => setPrompt(example.prompt)}
              title={example.prompt}
            >
              <span className="example__emoji" aria-hidden>
                {example.emoji}
              </span>
              <span className="example__title">{example.title}</span>
              <span className="example__hint">{example.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <fieldset className="tools" disabled={busy}>
        <legend className="label">Built-in tools</legend>
        {OPTIONAL_TOOLS.map((name) => {
          const tool = AGENT_TOOLS.find((entry) => entry.name === name)!;
          const on = enabledTools.includes(name);
          return (
            <label
              key={name}
              className={`toggle ${on ? "toggle--on" : ""}`}
              data-tool={name}
              title={tool.description}
            >
              <input type="checkbox" checked={on} onChange={() => onToggleTool(name)} />
              <ToolIcon name={name} size={13} />
              {tool.label}
            </label>
          );
        })}
      </fieldset>

      <McpPanel connection={mcpConnection} onChange={onMcpChange} />
    </section>
  );
}
