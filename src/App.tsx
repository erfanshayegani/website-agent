import { AlertTriangle, Loader2 } from "lucide-react";
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
import type { AgentTurnTrace } from "./types";
import { formatDuration, formatNumber } from "./utils/format";

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

  const toggleTool = (name: string) =>
    setEnabledTools((current) =>
      current.includes(name) ? current.filter((tool) => tool !== name) : [...current, name]
    );

  return (
    <div className="page">
      <Header />
      <main>
        <ModelCard phase={agent.modelPhase} progress={agent.progress} onLoad={agent.load} />
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

        {hasRun && (
          <div className="run">
            <div className="run__status">
              {busy ? (
                <span className="status status--live">
                  <Loader2 size={14} className="spin" aria-hidden />
                  {agent.runPhase === "waiting" ? "Waiting for your answer" : "Working"}
                </span>
              ) : agent.runPhase === "complete" ? (
                <span className="status status--done">{finalAnswer ? "Done" : "Stopped"}</span>
              ) : agent.runPhase === "error" ? (
                <span className="status status--error">Error</span>
              ) : null}
              <span className="muted small">
                {formatDuration(agent.elapsedMs)}
                {agent.stats &&
                  ` · ${formatNumber(agent.stats.tokens)} tokens · ${formatNumber(agent.stats.tps, 1)} tok/s`}
              </span>
            </div>

            {agent.error && (
              <p className="notice notice--danger" role="alert">
                <AlertTriangle size={16} aria-hidden /> {agent.error}
              </p>
            )}

            <div className="run__grid">
              <PlanTracker plan={agent.plan} />
              <div className="run__main">
                {agent.interaction && (
                  <InteractionCard
                    key={agent.interaction.id}
                    interaction={agent.interaction}
                    onSubmit={agent.submitInteraction}
                  />
                )}
                {finalAnswer && <AnswerCard answer={finalAnswer} artifact={agent.artifact} />}
                <details className="card trace" open={!finalAnswer}>
                  <summary className="label">Agent trace · {agent.trace.length} events</summary>
                  <Timeline trace={agent.trace} active={busy} />
                </details>
              </div>
            </div>
          </div>
        )}
      </main>
      <footer className="footer">
        Model:{" "}
        <a href="https://huggingface.co/LiquidAI/LFM2.5-2.6B-ONNX" target="_blank" rel="noreferrer noopener">
          LFM2.5-2.6B
        </a>{" "}
        by Liquid AI, used under the{" "}
        <a href="https://huggingface.co/LiquidAI/LFM2.5-2.6B-ONNX/blob/main/LICENSE" target="_blank" rel="noreferrer noopener">
          LFM Open License v1.0
        </a>
        . Inference runs locally with Transformers.js and WebGPU. Wikipedia, webpage reads, location
        lookups and optional MCP calls contact those services directly.
      </footer>
    </div>
  );
}
