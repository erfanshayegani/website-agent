// UI <-> worker bridge (SPEC §9.5). Also services the worker's main-thread
// requests: Python sandbox, webpage fetch, MCP calls and geolocation.
import { useCallback, useEffect, useRef, useState } from "react";
import { McpConnection } from "../mcpClient";
import type { McpConfiguration } from "../mcpTypes";
import { runPython } from "../pythonRunner";
import type {
  ActionPlan,
  BrowserArtifact,
  LoadProgress,
  ModelPhase,
  RunPhase,
  RunStats,
  TraceEvent,
  UserInteraction,
  WorkerRequest,
  WorkerResponse,
} from "../types";
import { loadWebpage } from "../webpage";

const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  maximumAge: 300_000,
  timeout: 10_000,
};
const ELAPSED_TICK_MS = 500;

export interface AgentWorker {
  modelPhase: ModelPhase;
  runPhase: RunPhase;
  progress: LoadProgress | null;
  trace: TraceEvent[];
  error: string | null;
  stats: RunStats | null;
  plan: ActionPlan | null;
  interaction: UserInteraction | null;
  artifact: BrowserArtifact | null;
  elapsedMs: number;
  mcpConnection: McpConnection;
  load(): void;
  generate(prompt: string, allowedTools: string[]): void;
  submitInteraction(answer: string): void;
  stop(): void;
  configureMcp(configuration: McpConfiguration | undefined): void;
}

export function useAgentWorker(): AgentWorker {
  const workerRef = useRef<Worker | null>(null);
  const mcpRef = useRef(new McpConnection());
  const mcpConfigRef = useRef<McpConfiguration | undefined>(undefined);
  const controllersRef = useRef(new Map<string, AbortController>());
  const runStartRef = useRef<number | null>(null);

  const [modelPhase, setModelPhase] = useState<ModelPhase>("idle");
  const [runPhase, setRunPhase] = useState<RunPhase>("idle");
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<RunStats | null>(null);
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [interaction, setInteraction] = useState<UserInteraction | null>(null);
  const [artifact, setArtifact] = useState<BrowserArtifact | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const send = useCallback((message: WorkerRequest) => {
    workerRef.current?.postMessage(message);
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/agent.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    const controllers = controllersRef.current;
    const mcp = mcpRef.current;
    const reply = (message: WorkerRequest) => worker.postMessage(message);

    const track = (id: string) => {
      const controller = new AbortController();
      controllers.set(id, controller);
      return controller;
    };
    const cancel = (id: string) => {
      controllers.get(id)?.abort();
      controllers.delete(id);
    };

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      switch (message.type) {
        case "loading":
          setModelPhase("loading");
          setProgress(message.data);
          break;
        case "ready":
          setModelPhase("ready");
          break;
        case "start":
          setRunPhase("thinking");
          break;
        case "turn":
        case "tool": {
          const item = message.data;
          setTrace((current) => {
            const index = current.findIndex((entry) => entry.id === item.id);
            if (index === -1) return [...current, item];
            const next = current.slice();
            next[index] = item;
            return next;
          });
          break;
        }
        case "plan":
          setPlan(message.data);
          break;
        case "interaction":
          setInteraction(message.data);
          setRunPhase("waiting");
          break;
        case "artifact":
          setArtifact(message.data);
          break;
        case "metrics":
          setStats(message.data);
          break;
        case "complete":
          setRunPhase("complete");
          setStats(message.data);
          setElapsedMs(
            runStartRef.current === null
              ? message.data.elapsedMs
              : performance.now() - runStartRef.current
          );
          break;
        case "error":
          setModelPhase((phase) => (phase === "loading" ? "error" : phase));
          setRunPhase("error");
          if (runStartRef.current !== null) setElapsedMs(performance.now() - runStartRef.current);
          setError(message.message);
          break;

        case "location_request": {
          const { id } = message;
          if (!("geolocation" in navigator)) {
            reply({ type: "location_response", id, error: "Geolocation is not supported by this browser." });
            break;
          }
          navigator.geolocation.getCurrentPosition(
            ({ coords }) =>
              reply({
                type: "location_response",
                id,
                location: {
                  latitude: coords.latitude,
                  longitude: coords.longitude,
                  accuracy: coords.accuracy,
                },
              }),
            (positionError) => reply({ type: "location_response", id, error: positionError.message }),
            GEOLOCATION_OPTIONS
          );
          break;
        }
        case "webpage_request": {
          const { id, url } = message;
          const controller = track(id);
          loadWebpage(url, controller.signal).then(
            (page) => {
              if (!controller.signal.aborted) reply({ type: "webpage_response", id, page });
              controllers.delete(id);
            },
            (failure: unknown) => {
              if (!controller.signal.aborted)
                reply({
                  type: "webpage_response",
                  id,
                  error: (failure as Error)?.message || "Could not read webpage.",
                });
              controllers.delete(id);
            }
          );
          break;
        }
        case "webpage_cancel":
          cancel(message.id);
          break;
        case "python_request": {
          const { id, code, timeoutMs } = message;
          const controller = track(id);
          runPython(code, controller.signal, timeoutMs).then(
            (result) => {
              if (!controller.signal.aborted) reply({ type: "python_response", id, result });
              controllers.delete(id);
            },
            (failure: unknown) => {
              if (!controller.signal.aborted)
                reply({
                  type: "python_response",
                  id,
                  result: { ok: false, stdout: "", stderr: "", result: null, error: String(failure), elapsed_ms: 0 },
                });
              controllers.delete(id);
            }
          );
          break;
        }
        case "python_cancel":
          cancel(message.id);
          break;
        case "mcp_request": {
          const { id, url, name } = message;
          const controller = track(id);
          mcp.call(url, name, message.arguments, controller.signal).then(
            (compacted) => {
              if (!controller.signal.aborted)
                reply({ type: "mcp_response", id, result: { server_url: url, ...compacted } });
              controllers.delete(id);
            },
            (failure: unknown) => {
              if (!controller.signal.aborted)
                reply({
                  type: "mcp_response",
                  id,
                  result: { error: (failure as Error)?.message || String(failure), server_url: url },
                });
              controllers.delete(id);
            }
          );
          break;
        }
        case "mcp_cancel":
          cancel(message.id);
          break;
      }
    };

    return () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      void mcp.disconnect();
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Elapsed-time ticker while a run is active.
  useEffect(() => {
    if (runPhase !== "thinking" && runPhase !== "waiting") return;
    const timer = setInterval(() => {
      if (runStartRef.current !== null) setElapsedMs(performance.now() - runStartRef.current);
    }, ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [runPhase]);

  const load = useCallback(() => {
    setError(null);
    setModelPhase("loading");
    send({ type: "load" });
  }, [send]);

  const generate = useCallback(
    (prompt: string, allowedTools: string[]) => {
      runStartRef.current = performance.now();
      setElapsedMs(0);
      setError(null);
      setTrace([]);
      setStats(null);
      setPlan(null);
      setInteraction(null);
      setArtifact(null);
      setRunPhase("thinking");
      send({ type: "generate", prompt, allowedTools: [...allowedTools], mcp: mcpConfigRef.current });
    },
    [send]
  );

  const submitInteraction = useCallback(
    (answer: string) => {
      const trimmed = answer.trim();
      if (!trimmed || !interaction) return;
      send({ type: "interaction_response", id: interaction.id, answer: trimmed });
      setInteraction(null);
      setRunPhase("thinking");
    },
    [interaction, send]
  );

  const stop = useCallback(() => {
    send({ type: "stop" });
    setInteraction(null);
  }, [send]);

  const configureMcp = useCallback((configuration: McpConfiguration | undefined) => {
    mcpConfigRef.current = configuration;
  }, []);

  return {
    modelPhase,
    runPhase,
    progress,
    trace,
    error,
    stats,
    plan,
    interaction,
    artifact,
    elapsedMs,
    mcpConnection: mcpRef.current,
    load,
    generate,
    submitInteraction,
    stop,
    configureMcp,
  };
}
