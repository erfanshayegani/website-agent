import { Brain, CheckCircle2, Loader2 } from "lucide-react";
import { AGENT_TOOLS } from "../agentConfig";
import type { AgentTurnTrace, ToolTrace, TraceEvent } from "../types";
import Markdown from "./Markdown";
import { ToolIcon } from "./ToolIcon";
import { ToolArguments, ToolResult } from "./ToolResult";

function toolLabel(name: string): string {
  if (name === "create_research_paper") return "Write report";
  return AGENT_TOOLS.find((tool) => tool.name === name)?.label ?? `MCP · ${name}`;
}

function TurnItem({ turn, live }: { turn: AgentTurnTrace; live: boolean }) {
  if (turn.isFinal) return null; // shown in the answer card
  if (!turn.thinking && !turn.content) return null;
  return (
    <li className="event event--turn">
      <div className="event__marker">
        <Brain size={14} aria-hidden />
      </div>
      <div className="event__body">
        {turn.thinking && (
          <details className="thinking" open={live && !turn.content}>
            <summary>
              Thinking · turn {turn.turn}
              {live && !turn.content && <Loader2 size={12} className="spin" aria-hidden />}
            </summary>
            <p className="thinking__text">{turn.thinking}</p>
          </details>
        )}
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
  return (
    <li className={`event event--tool ${running ? "event--running" : ""}`}>
      <div className="event__marker">
        <ToolIcon name={tool.name} size={14} />
      </div>
      <div className="event__body">
        <div className="tool__head">
          <span className="tool__name">{toolLabel(tool.name)}</span>
          {running ? (
            <Loader2 size={13} className="spin muted" aria-label="running" />
          ) : (
            <CheckCircle2 size={13} className="ok" aria-label="done" />
          )}
        </div>
        <ToolArguments name={tool.name} args={tool.arguments} />
        {tool.result && <ToolResult name={tool.name} result={tool.result} />}
      </div>
    </li>
  );
}

export default function Timeline({ trace, active }: { trace: TraceEvent[]; active: boolean }) {
  if (!trace.length) return null;
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
