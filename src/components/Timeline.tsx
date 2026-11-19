import { CheckCircle2, Loader2 } from "lucide-react";
import { AGENT_TOOLS } from "../agentConfig";
import type { AgentTurnTrace, ToolTrace, TraceEvent } from "../types";
import Markdown from "./Markdown";
import { ToolIcon } from "./ToolIcon";
import { ToolArguments, ToolResult } from "./ToolResult";

export function toolLabel(name: string): string {
  if (name === "create_research_paper") return "Write report";
  return AGENT_TOOLS.find((tool) => tool.name === name)?.label ?? name;
}

function TurnItem({ turn, live }: { turn: AgentTurnTrace; live: boolean }) {
  if (turn.isFinal) return null; // shown in the answer card
  if (!turn.thinking && !turn.content) return null;
  const thinkingLive = live && !turn.content;
  return (
    <li className="event event--turn">
      <div className="event__marker" aria-hidden>
        💭
      </div>
      <div className="event__body">
        {turn.thinking &&
          (thinkingLive ? (
            <div className="thought thought--live">
              <span className="thought__label">Thinking…</span>
              <p className="thought__text">
                {turn.thinking.slice(-600)}
                <span className="caret" aria-hidden />
              </p>
            </div>
          ) : (
            <details className="thought">
              <summary className="thought__label">Thought · turn {turn.turn}</summary>
              <p className="thought__text">{turn.thinking}</p>
            </details>
          ))}
        {turn.content && (
          <div className="turn__content">
            <Markdown>{turn.content}</Markdown>
          </div>
        )}
      </div>
    </li>
  );
}

function ToolItem({ tool }: { tool: ToolTrace }) {
  const running = tool.status === "running";
  const isMcp = !AGENT_TOOLS.some((entry) => entry.name === tool.name) && tool.name !== "create_research_paper";
  return (
    <li className={`event event--tool ${running ? "event--running" : ""}`} data-tool={isMcp ? "mcp" : tool.name}>
      <div className="event__marker">
        <ToolIcon name={isMcp ? "mcp" : tool.name} size={14} />
      </div>
      <div className="event__body tool-card">
        <div className="tool-card__head">
          <span className="tool-card__name">{toolLabel(tool.name)}</span>
          {isMcp && <span className="tag">Exa / MCP</span>}
          {running ? (
            <span className="tool-card__state">
              <Loader2 size={13} className="spin" aria-hidden /> working
            </span>
          ) : (
            <CheckCircle2 size={14} className="ok" aria-label="done" />
          )}
        </div>
        <ToolArguments name={tool.name} args={tool.arguments} />
        {tool.result && <ToolResult name={tool.name} result={tool.result} />}
      </div>
    </li>
  );
}

export default function Timeline({ trace, active }: { trace: TraceEvent[]; active: boolean }) {
  if (!trace.length)
    return (
      <p className="muted small timeline__empty">
        <Loader2 size={13} className="spin" aria-hidden /> Spinning up…
      </p>
    );
  const lastId = trace[trace.length - 1].id;
  return (
    <ol className="timeline" aria-live="polite">
      {trace.map((event) =>
        event.kind === "turn" ? (
          <TurnItem key={event.id} turn={event} live={active && event.id === lastId} />
        ) : (
          <ToolItem key={event.id} tool={event} />
        )
      )}
    </ol>
  );
}
