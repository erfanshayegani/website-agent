// Shared data shapes and the UI <-> worker protocol (SPEC §9).
import type { McpConfiguration } from "./mcpTypes";
import type { PythonResult } from "./pythonRunner";
import type { WebpageDocument } from "./webpage";

export type ModelPhase = "idle" | "loading" | "ready" | "error";
export type RunPhase = "idle" | "thinking" | "waiting" | "complete" | "error";

export interface LoadProgress {
  progress: number;
  loaded?: number;
  total?: number;
}

export interface AgentTurnTrace {
  id: string;
  kind: "turn";
  turn: number;
  thinking: string;
  content: string;
  isFinal: boolean;
}

export interface ToolTrace {
  id: string;
  kind: "tool";
  name: string;
  arguments: Record<string, unknown>;
  result?: Record<string, unknown>;
  status: "running" | "complete";
}

export type TraceEvent = AgentTurnTrace | ToolTrace;

export type StepStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface ActionPlanStep {
  id: string;
  title: string;
  status: StepStatus;
  note?: string;
}

export interface ActionPlan {
  id: string;
  goal: string;
  priority: "low" | "medium" | "high";
  status: "active" | "completed" | "blocked";
  currentStep: number;
  steps: ActionPlanStep[];
  updatedAt: number;
}

export interface UserInteraction {
  id: string;
  question: string;
  responseType: "text" | "select";
  options: string[];
  placeholder?: string;
  allowCustom: boolean;
}

export interface BrowserLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
  countryName?: string;
  countryCode?: string;
  principalSubdivision?: string;
  city?: string;
  locality?: string;
  lookupSource?: string;
  reverseGeocodingError?: string;
}

export interface BrowserArtifact {
  id: string;
  title: string;
  filename: string;
  mimeType: "text/markdown";
  content: string;
}

export interface RunStats {
  elapsedMs: number;
  generationMs: number;
  tokens: number;
  tps: number;
}

/** UI -> worker. */
export type WorkerRequest =
  | { type: "load" }
  | {
      type: "generate";
      prompt: string;
      allowedTools: string[];
      mcp?: McpConfiguration;
    }
  | { type: "interaction_response"; id: string; answer: string }
  | {
      type: "location_response";
      id: string;
      location?: BrowserLocation;
      error?: string;
    }
  | {
      type: "webpage_response";
      id: string;
      page?: WebpageDocument;
      error?: string;
    }
  | { type: "python_response"; id: string; result: PythonResult }
  | { type: "mcp_response"; id: string; result: Record<string, unknown> }
  | { type: "stop" };

/** Worker -> UI. */
export type WorkerResponse =
  | { type: "loading"; data: LoadProgress }
  | { type: "ready" }
  | { type: "start" }
  | { type: "turn"; data: AgentTurnTrace }
  | { type: "tool"; data: ToolTrace }
  | { type: "plan"; data: ActionPlan }
  | { type: "interaction"; data: UserInteraction }
  | { type: "location_request"; id: string }
  | { type: "webpage_request"; id: string; url: string }
  | { type: "webpage_cancel"; id: string }
  | { type: "python_request"; id: string; code: string; timeoutMs: number }
  | { type: "python_cancel"; id: string }
  | {
      type: "mcp_request";
      id: string;
      url: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { type: "mcp_cancel"; id: string }
  | { type: "artifact"; data: BrowserArtifact }
  | { type: "metrics"; data: RunStats }
  | { type: "complete"; data: RunStats }
  | { type: "error"; message: string };
