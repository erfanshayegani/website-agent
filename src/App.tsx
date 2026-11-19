import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { OPTIONAL_TOOLS } from "./agentConfig";
import AnswerCard from "./components/AnswerCard";
import Composer from "./components/Composer";
import Header from "./components/Header";
import InteractionCard from "./components/InteractionCard";
import ModelCard from "./components/ModelCard";
import PlanTracker from "./components/PlanTracker";
import Timeline from "./components/Timeline";
import { useAgentWorker } from "./hooks/useAgentWorker";
import type { AgentTurnTrace, RunPhase } from "./types";
import { formatDuration, formatNumber } from "./utils/format";

const STATUS: Record<RunPhase, string> = {
  idle: "Idle",
  thinking: "Working",
  waiting: "Needs your input",
  complete: "Done",
  error: "Error",
};

export default function App() {
  const agent = useAgentWorker();
  // Same default as the original app: every optional built-in enabled.
  const [enabledTools, setEnabledTools] = useState<string[]>([...OPTIONAL_TOOLS]);

  const busy = agent.runPhase === "thinking" || agent.runPhase === "waiting";
  const modelReady = agent.modelPhase === "ready";
  const finalAnswer = agent.trace.find(
    (event): event is AgentTurnTrace => event.kind === "turn" && event.isFinal
  );
  const hasRun = agent.runPhase !== "idle" || agent.trace.length > 0;
  const toolCalls = agent.trace.filter(
    (event) => event.kind === "tool" && event.name !== "create_research_paper"
  ).length;
  const turns = new Set(agent.trace.filter((event) => event.kind === "turn").map((event) => event.id)).size;
  const status =
    agent.runPhase === "complete" && !finalAnswer ? "Stopped" : STATUS[agent.runPhase];

  const toggleTool = (name: string) =>
    setEnabledTools((current) =>
      current.includes(name) ? current.filter((tool) => tool !== name) : [...current, name]
    );

  return (
    <div className="app">
      <div className="backdrop" aria-hidden />
      <Header />

      <div className="workspace">
        {/* left: input */}
        <aside className="pane pane--left" aria-label="Task">
          <ModelCard
            phase={agent.modelPhase}
            runPhase={agent.runPhase}
            progress={agent.progress}
            onLoad={agent.load}
          />
          <Composer
            canRun={modelReady && !busy}
            busy={busy}
            modelReady={modelReady}
            enabledTools={enabledTools}
            onToggleTool={toggleTool}
            onRun={(prompt) => agent.generate(prompt, enabledTools)}
            onStop={agent.stop}
            mcpConnection={agent.mcpConnection}
            onMcpChange={agent.configureMcp}
          />
        </aside>

        {/* center: trajectory */}
        <main className="pane pane--center" aria-label="Agent trajectory">
          {!hasRun ? (
            <div className="empty">
              <span className="orb orb--big" aria-hidden>
                <span className="orb__core" />
                <span className="orb__ring" />
                <span className="orb__ring orb__ring--2" />
              </span>
              <h2>The agent's trajectory appears here</h2>
              <p className="muted">
                Wake up the agent, pick an example or write your own task, and hit Launch. You'll
                watch it plan, think, call tools and write its answer, live, all on your device.
              </p>
            </div>
          ) : (
            <>
              {agent.error && (
                <p className="notice notice--danger" role="alert">
                  <AlertTriangle size={16} aria-hidden /> {agent.error}
                </p>
              )}
              {agent.interaction && (
                <InteractionCard
                  key={agent.interaction.id}
                  interaction={agent.interaction}
                  onSubmit={agent.submitInteraction}
                />
              )}
              {finalAnswer && <AnswerCard answer={finalAnswer} artifact={agent.artifact} />}
              <section className="card trace">
                <h2 className="label">🛰️ Mission log · {agent.trace.length} events</h2>
                <Timeline trace={agent.trace} active={busy} />
              </section>
            </>
          )}
        </main>

        {/* right: status + plan */}
        <aside className="pane pane--right" aria-label="Status and plan">
          <section className="card hud">
            <div className="hud__head">
              <span className={`hud__orb hud__orb--${agent.runPhase}`} aria-hidden />
              <span className="hud__status">{status}</span>
            </div>
            <div className="hud__stats">
              <span className="stat">
                <b>{formatDuration(agent.elapsedMs)}</b>
                <small>time</small>
              </span>
              <span className="stat">
                <b>{formatNumber(agent.stats?.tokens ?? 0)}</b>
                <small>tokens</small>
              </span>
              <span className="stat">
                <b>{formatNumber(agent.stats?.tps ?? 0, 1)}</b>
                <small>tok/s</small>
              </span>
              <span className="stat">
                <b>{turns}</b>
                <small>turns</small>
              </span>
              <span className="stat">
                <b>{toolCalls}</b>
                <small>tool calls</small>
              </span>
            </div>
          </section>
          <PlanTracker plan={agent.plan} />
        </aside>
      </div>

      <footer className="footer">
        Model:{" "}
        <a href="https://huggingface.co/LiquidAI/LFM2.5-2.6B-ONNX" target="_blank" rel="noreferrer noopener">
          LFM2.5-2.6B
        </a>{" "}
        by Liquid AI, used under the{" "}
        <a href="https://huggingface.co/LiquidAI/LFM2.5-2.6B-ONNX/blob/main/LICENSE" target="_blank" rel="noreferrer noopener">
          LFM Open License v1.0
        </a>
        . Inference runs locally with Transformers.js and WebGPU. Wikipedia lookups, Exa web
        search and page reading (the URL is sent to Exa), location lookups and other MCP calls
        contact those services directly from your browser.{" "}
        <a href="https://github.com/erfanshayegani/website-agent" target="_blank" rel="noreferrer noopener">
          Source
        </a>
        .
      </footer>
    </div>
  );
}
