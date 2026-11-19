// Built-in tool definitions (SPEC §7). Schemas are model-visible: keep text,
// key order and tool order exactly as specified.
import { toStringArray } from "./agent/parsing";
import type { PythonResult } from "./pythonRunner";
import type { ActionPlan, ActionPlanStep, UserInteraction } from "./types";

type JsonObject = Record<string, unknown>;

export interface ToolExecutionContext {
  getActivePlan(): ActionPlan | null;
  setActivePlan(plan: ActionPlan): void;
  askUser(interaction: UserInteraction): Promise<JsonObject>;
  getLocation(): Promise<JsonObject>;
  researchWikipedia(question: string, language: string): Promise<JsonObject>;
  readWebpage(url: string, question: string): Promise<JsonObject>;
  runPython(code: string, timeoutMs: number): Promise<PythonResult | JsonObject>;
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: JsonObject };
}

export interface AgentToolDefinition {
  name: string;
  /** UI-only metadata (§7.11) — never shown to the model. */
  label: string;
  summary: string;
  description: string;
  returns: string;
  schema: ToolSchema;
  execute(args: JsonObject, context: ToolExecutionContext): Promise<JsonObject>;
}

const PLAN_STATUSES = ["pending", "in_progress", "completed", "blocked"] as const;
const DEFAULT_STEPS = [
  "Clarify the research scope",
  "Gather reliable evidence",
  "Synthesize the cited research answer",
];

function schema(name: string, description: string, parameters: JsonObject): ToolSchema {
  return { type: "function", function: { name, description, parameters } };
}

const runPython: AgentToolDefinition = {
  name: "run_python",
  label: "Run Python",
  summary: "Execute Python for calculations, sorting, and small algorithms.",
  description:
    "Runs Python in an isolated browser WebAssembly worker with an ephemeral filesystem. Supports standard-library modules such as math, statistics, decimal, and json. Returns stdout, stderr, the last expression, and errors. No local Python installation, package installation, or host filesystem access is needed. Default execution limit is 5 seconds, excluding runtime loading.",
  returns:
    "Execution success, stdout, stderr, last-expression repr, error/traceback, timing, and truncation flags.",
  schema: schema(
    "run_python",
    "Execute Python rather than guessing arithmetic, sorting, distances, statistics, and algorithms. Send a complete script using only Python's standard library. Print the desired answer or end with an expression. Calls are independent: variables and files do not persist. State units and assumptions; execution checks the code, not its assumptions. On errors, correct the code and retry. Do not invent successful execution or use Python for web access.",
    {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Python source code, with escaped newlines inside the tool-call string",
        },
        timeout_ms: {
          type: "integer",
          minimum: 100,
          maximum: 10000,
          description:
            "Execution limit, 5000 ms by default; first-use runtime loading has a separate deadline",
        },
      },
      required: ["code"],
    }
  ),
  async execute(args, context) {
    const code = typeof args.code === "string" ? args.code : "";
    if (!code.trim() || code.length > 20000)
      return { ok: false, error: "Provide 1–20000 characters of Python code." };
    const requested = args.timeout_ms;
    const timeout =
      typeof requested === "number" && Number.isFinite(requested)
        ? Math.min(10000, Math.max(100, requested))
        : 5000;
    return { ...(await context.runPython(code, timeout)) };
  },
};

const readWebpage: AgentToolDefinition = {
  name: "read_webpage",
  label: "Read webpage",
  summary: "Read a supplied public URL and extract evidence relevant to the request.",
  description:
    "Downloads a public HTML or text page (on this site, through Exa's page reader, so the URL is sent to Exa). One isolated local research pass analyzes the beginning of the extracted page, up to 8000 tokens, and returns a brief, source URL, and truncation information. Later text is not read when this limit is exceeded. Does not search the web or execute page JavaScript.",
  returns: "A focused brief, source URL, relevant excerpts, and explicit partial-coverage information.",
  schema: schema(
    "read_webpage",
    "Read an exact URL supplied by the user or found in evidence. Use this first for a user-provided URL. You must supply a focused question describing the evidence needed from this page. The original user request and plan goal are included as background only; the researcher answers this focused question, not the entire task. The reader analyzes one prefix of at most 8000 tokens; changing the question does not retrieve later sections. Never invent URLs. This reads a page, not a search engine.",
    {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http:// or https:// page URL" },
        question: {
          type: "string",
          description: "What evidence to extract from this page for the current task",
        },
      },
      required: ["url", "question"],
    }
  ),
  async execute(args, context) {
    const url = String(args.url ?? "").trim();
    let valid = false;
    try {
      valid = ["http:", "https:"].includes(new URL(url).protocol);
    } catch {
      valid = false;
    }
    if (!valid) return { error: "Provide a complete public HTTP or HTTPS URL." };
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (!question)
      return {
        error:
          "A non-empty focused question is required. Retry read_webpage with the specific evidence you need from this URL.",
      };
    return context.readWebpage(url, question);
  },
};

const createActionPlan: AgentToolDefinition = {
  name: "create_action_plan",
  label: "Create action plan",
  summary: "Create the ordered agenda that controls the mission workflow.",
  description:
    "Creates one to five execution steps based on the request and starts the first step before any other tool can run.",
  returns: "The session plan, current step, priority, and plan ID.",
  schema: schema(
    "create_action_plan",
    "Create the source-of-truth execution agenda before doing any other work. Steps must be agent actions that can finish in this conversation.",
    {
      type: "object",
      properties: {
        goal: { type: "string", description: "Mission goal" },
        steps: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["goal", "steps", "priority"],
    }
  ),
  async execute(args, context) {
    const goal = String(args.goal ?? "Complete the current mission");
    let titles = toStringArray(args.steps).slice(0, 5);
    if (!titles.length) titles = DEFAULT_STEPS;
    const rawPriority = String(args.priority ?? "medium");
    const priority = (["low", "medium", "high"].includes(rawPriority)
      ? rawPriority
      : "medium") as ActionPlan["priority"];
    const plan: ActionPlan = {
      id: "local-plan-" + crypto.randomUUID().slice(0, 8),
      goal,
      priority,
      status: "active",
      currentStep: 1,
      steps: titles.map((title, index) => ({
        id: `step-${index + 1}`,
        title,
        status: index === 0 ? "in_progress" : "pending",
      })),
      updatedAt: Date.now(),
    };
    context.setActivePlan(plan);
    return { stored_in: "conversation memory", plan };
  },
};

const updateActionPlan: AgentToolDefinition = {
  name: "update_action_plan",
  label: "Update action plan",
  summary: "Advance the current step as evidence arrives.",
  description:
    "Records evidence and step status. Starting a later step automatically completes all previous steps.",
  returns: "The complete updated plan and current workflow position.",
  schema: schema(
    "update_action_plan",
    "Update the action plan after starting or completing a workflow step.",
    {
      type: "object",
      properties: {
        step_index: { type: "integer", description: "One-based step index" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
        note: { type: "string", description: "Evidence or progress note" },
      },
      required: ["step_index", "status", "note"],
    }
  ),
  async execute(args, context) {
    const plan = context.getActivePlan();
    if (!plan) return { error: "No active plan. Call create_action_plan first." };
    const index = Math.max(0, Number(args.step_index ?? 1) - 1);
    if (!plan.steps[index]) return { error: `Step ${index + 1} does not exist`, plan };
    const rawStatus = String(args.status ?? "in_progress");
    const status = ((PLAN_STATUSES as readonly string[]).includes(rawStatus)
      ? rawStatus
      : "in_progress") as ActionPlanStep["status"];

    let steps: ActionPlanStep[] = plan.steps.map((step, i) => {
      let next: ActionPlanStep["status"] = step.status;
      if (status !== "in_progress") {
        if (i === index) next = status;
      } else if (i < index) next = "completed";
      else if (i === index) next = "in_progress";
      else if (step.status === "in_progress") next = "pending";
      const updated: ActionPlanStep = { id: step.id, title: step.title, status: next };
      const note = i === index && args.note ? String(args.note) : step.note;
      if (note !== undefined) updated.note = note;
      return updated;
    });

    if (status === "completed") {
      steps = steps.map((step) =>
        step.status === "in_progress" ? { ...step, status: "pending" } : step
      );
      const firstPending = steps.findIndex((step) => step.status === "pending");
      if (firstPending !== -1)
        steps[firstPending] = { ...steps[firstPending], status: "in_progress" };
    }

    const active = steps.findIndex((step) => step.status === "in_progress");
    const updatedPlan: ActionPlan = {
      id: plan.id,
      goal: plan.goal,
      priority: plan.priority,
      status: steps.every((step) => step.status === "completed")
        ? "completed"
        : status === "blocked"
          ? "blocked"
          : "active",
      currentStep: active === -1 ? index + 1 : active + 1,
      steps,
      updatedAt: Date.now(),
    };
    context.setActivePlan(updatedPlan);
    return { stored_in: "conversation memory", plan: updatedPlan };
  },
};

const askUser: AgentToolDefinition = {
  name: "ask_user",
  label: "Ask user",
  summary: "Narrow a broad request by asking about the user's preferred scope or perspective.",
  description:
    "Use after objective context is known when the request still permits meaningfully different answers. Ask about preferences such as time period, theme, audience, perspective, or depth. For a broad country-history question, for example, clarify whether to focus on an era or aspect rather than choosing one silently.",
  returns: "The user's selected or written answer.",
  schema: schema(
    "ask_user",
    "Ask one focused question to narrow the user's preferred scope, perspective, audience, time period, theme, or level of detail. Use this even after factual context such as location is known when the research question remains broad. Prefer select when a short set of meaningful choices exists.",
    {
      type: "object",
      properties: {
        question: { type: "string" },
        response_type: { type: "string", enum: ["text", "select"] },
        options: { type: "array", items: { type: "string" }, maxItems: 6 },
        placeholder: { type: "string" },
        allow_custom: { type: "boolean" },
      },
      required: ["question", "response_type"],
    }
  ),
  async execute(args, context) {
    const options = toStringArray(args.options).slice(0, 6);
    const responseType =
      args.response_type === "select" && options.length > 0 ? "select" : "text";
    return context.askUser({
      question: String(args.question ?? "What should I know?"),
      responseType,
      options: responseType === "select" ? options : [],
      placeholder: args.placeholder ? String(args.placeholder) : undefined,
      allowCustom: Boolean(args.allow_custom),
      id: crypto.randomUUID(),
    });
  },
};

const searchWikipedia: AgentToolDefinition = {
  name: "search_wikipedia",
  label: "Wikipedia research agent",
  summary: "Delegate focused, cited research to an isolated local agent.",
  description:
    "Searches and reads a bounded set of Wikipedia pages, then uses an isolated model turn to return only distilled evidence and canonical sources.",
  returns: "A concise research brief, caveats, and source URLs without raw page text.",
  schema: schema(
    "search_wikipedia",
    "Delegate a focused research question to an isolated Wikipedia research agent. It searches and reads relevant pages, then returns a concise cited brief. Ask a complete question; raw articles are not added to your context.",
    {
      type: "object",
      properties: {
        query: { type: "string", description: "The complete research question to investigate" },
        language: { type: "string", description: "Wikipedia language code" },
      },
      required: ["query"],
    }
  ),
  async execute(args, context) {
    const question = String(args.query ?? "").trim();
    if (!question) return { error: "A research question is required." };
    const requested = String(args.language ?? "en").toLowerCase();
    const language = /^[a-z]{2,3}$/.test(requested) ? requested : "en";
    return context.researchWikipedia(question, language);
  },
};

const getCurrentContext: AgentToolDefinition = {
  name: "get_current_context",
  label: "Get current context",
  summary:
    "Read the user's current device context, including permission-gated physical location.",
  description:
    "Uses browser APIs to read current date, time, timezone, language, connectivity, and device coordinates. With location permission, coordinates are reverse geocoded into country, region, city, and locality. For questions that depend on where the user currently is, call this tool with include_location=true instead of asking the user to select a location.",
  returns:
    "Current device context and, when permission is granted, coordinates plus resolved country, country code, region, city, and locality.",
  schema: schema(
    "get_current_context",
    "Get the user's current device context. When a request depends on the user's present physical location, set include_location=true to request and resolve the device location into country, region, city, and locality instead of asking the user where they are. Repeated calls return the same cached result for this run.",
    {
      type: "object",
      properties: {
        include_location: {
          type: "boolean",
          description:
            "Whether to resolve the user's current physical location. Defaults to true when omitted; set false only when date and time context is sufficient.",
        },
      },
      required: [],
    }
  ),
  async execute(args, context) {
    const now = new Date();
    const result: JsonObject = {
      iso_datetime: now.toISOString(),
      local_datetime: now.toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      online: navigator.onLine,
    };
    if (args.include_location !== false) result.location = await context.getLocation();
    return result;
  },
};

/** Definition order matters: schema order and the parser's name alternation. */
export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  runPython,
  readWebpage,
  createActionPlan,
  updateActionPlan,
  askUser,
  searchWikipedia,
  getCurrentContext,
];

export type ToolName = (typeof AGENT_TOOLS)[number]["name"];

/** Optional built-ins the UI can switch on and off (plan tools are always on). */
export const OPTIONAL_TOOLS = [
  "ask_user",
  "get_current_context",
  "search_wikipedia",
  "read_webpage",
  "run_python",
] as const;
