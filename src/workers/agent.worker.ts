/// <reference lib="webworker" />
// The agent loop (SPEC §2, §4, §6, §7, §10). Runs model inference in this
// worker; Python, webpages, MCP, location and user questions are round-trips
// to the main thread.
import {
  DynamicCache,
  InterruptableStoppingCriteria,
  TextStreamer,
  env,
  pipeline,
} from "@huggingface/transformers";
import { AGENT_TOOLS, type ToolExecutionContext, type ToolSchema } from "../agentConfig";
import { parseToolCalls, parseTurn, cleanGeneratedText, type ParsedToolCall } from "../agent/parsing";
import {
  LOCATION_ALREADY_RESOLVED_MESSAGE,
  MCP_SUFFIX,
  NO_EVIDENCE_MESSAGE,
  PLAN_FIRST_MESSAGE,
  REVIEW_EVIDENCE_MESSAGE,
  SYSTEM_PROMPT,
  WEBPAGE_ANALYST_SYSTEM,
  WEBPAGE_FULL_COVERAGE,
  WEBPAGE_PARTIAL_COVERAGE,
  WIKIPEDIA_RESEARCH_SYSTEM,
  webpageAnalystUser,
  wikipediaResearchUser,
  workflowControllerMessage,
} from "../agent/prompts";
import {
  appendSourcePages,
  createResearchPaper,
  extractSources,
  type ResearchSource,
} from "../agent/sources";
import type { McpConfiguration } from "../mcpTypes";
import { MODEL_ID, MODEL_OPTIONS, MODEL_TASK, configureTransformersEnv, normalizeChatTemplate } from "../model";
import type { PythonResult } from "../pythonRunner";
import type {
  ActionPlan,
  BrowserLocation,
  RunStats,
  UserInteraction,
  WorkerRequest,
  WorkerResponse,
} from "../types";
import { WEBPAGE_PASSAGE_TOKEN_LIMIT, webpageExcerpt, webpagePassage, type WebpageDocument } from "../webpage";

// ---------------------------------------------------------------- constants (§1.1)

const MAX_AGENT_TURNS = 100;
const MAX_NEW_TOKENS = 3000;
const MAX_RESEARCH_TOKENS = 600;
const MAX_WEBPAGE_RESEARCH_TOKENS = 4096;
const MAX_WEBPAGE_RESEARCH_INPUT_TOKENS = 12000;
const MAX_WEBPAGE_BRIEF_CHARS = 8000;
const WEBPAGE_BRIEF_CHARS = 1800;
const MAX_WIKIPEDIA_PAGES = 2;
const MAX_WIKIPEDIA_PAGE_CHARS = 8_000;
const MAX_WIKIPEDIA_CONTEXT_CHARS = 16_000;
const MAX_RESEARCH_BRIEF_CHARS = 4_500;
const TOOL_DELAY_MS = 280;
const METRICS_INTERVAL_MS = 200;
const MCP_TIMEOUT_MS = 65_000;
const PYTHON_TIMEOUT_MS = 75_000;
const WEBPAGE_TIMEOUT_MS = 25_000;
const MCP_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// ---------------------------------------------------------------- types

type JsonObject = Record<string, unknown>;

interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: { function: ParsedToolCall }[];
}

/* Loose views of the Transformers.js objects we touch. */
interface Tokenizer {
  chat_template: unknown;
  apply_chat_template(messages: AgentMessage[], options: JsonObject): unknown;
  (text: string, options: JsonObject): { input_ids: { tolist(): bigint[][]; dims: number[] } };
}
interface Generator {
  tokenizer: Tokenizer;
  (input: AgentMessage[], options: JsonObject): Promise<unknown>;
}
type Cache = InstanceType<typeof DynamicCache>;

// ---------------------------------------------------------------- state

configureTransformersEnv(env as unknown as { experimental_useCrossOriginStorage: boolean });

let generator: Generator | null = null;
let loadingPromise: Promise<Generator> | null = null;
let stoppingCriteria: InstanceType<typeof InterruptableStoppingCriteria> | null = null;
let stopRequested = false;
let runQueue: Promise<void> = Promise.resolve();

let activePlan: ActionPlan | null = null;
let activeMcp: McpConfiguration | undefined;
let runPrompt = "";
let resolvedLocationPromise: Promise<JsonObject> | null = null;

// Per-run counters shared by main turns and subagents (§4.6, §9.4).
let generatedTokens = 0;
let generationMs = 0;
let lastMetricsAt = 0;
let runStartedAt = 0;

interface Pending<T> {
  id: string;
  resolve(value: T): void;
  timer?: ReturnType<typeof setTimeout>;
}
let pendingInteraction: Pending<JsonObject> | null = null;
let pendingLocation: Pending<JsonObject> | null = null;
let pendingWebpage: Pending<WebpageDocument | { error: string }> | null = null;
let pendingPython: Pending<PythonResult | JsonObject> | null = null;
let pendingMcp: Pending<JsonObject> | null = null;

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown model runtime error";
}

function createStats(startedAt: number, generation: number, tokens: number): RunStats {
  return {
    elapsedMs: performance.now() - startedAt,
    generationMs: generation,
    tokens,
    tps: tokens / Math.max(generation / 1000, 0.001),
  };
}

/** Throttled streaming metrics (one shared timestamp, §1.1). */
function maybePostMetrics(callStartedAt: number): void {
  const now = performance.now();
  if (now - lastMetricsAt < METRICS_INTERVAL_MS) return;
  lastMetricsAt = now;
  post({
    type: "metrics",
    data: createStats(runStartedAt, generationMs + (now - callStartedAt), generatedTokens),
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- model (§2.3)

async function loadModel(): Promise<Generator> {
  if (generator) return generator;
  loadingPromise ??= pipeline(MODEL_TASK, MODEL_ID, {
    ...MODEL_OPTIONS,
    progress_callback: (event: JsonObject) => {
      if (event.status !== "progress_total") return;
      post({
        type: "loading",
        data: {
          progress: event.progress as number,
          loaded: event.loaded as number | undefined,
          total: event.total as number | undefined,
        },
      });
    },
  }) as unknown as Promise<Generator>;
  const pipe = await loadingPromise;
  generator = pipe;
  pipe.tokenizer.chat_template = normalizeChatTemplate(pipe.tokenizer.chat_template);
  post({ type: "ready" });
  return pipe;
}

// ---------------------------------------------------------------- tokenization (§4.3)

function tokenizeChatPrompt(pipe: Generator, messages: AgentMessage[], tools?: ToolSchema[]): bigint[] {
  const options: JsonObject = { tokenize: false, add_generation_prompt: true };
  if (tools) options.tools = tools;
  const prompt = pipe.tokenizer.apply_chat_template(messages, options);
  if (typeof prompt !== "string") throw new Error("The chat template did not return a text prompt.");
  return pipe.tokenizer(prompt, { add_special_tokens: false, padding: true, truncation: true }).input_ids.tolist()[0];
}

function countTokens(pipe: Generator, text: string): number {
  const ids = pipe.tokenizer(text, { add_special_tokens: false, truncation: false }).input_ids;
  return ids.dims[ids.dims.length - 1];
}

function isExactCachedPrefix(cacheLength: number, cachedIds: bigint[], promptIds: bigint[]): boolean {
  if (cacheLength <= 0 || cacheLength > promptIds.length || cachedIds.length !== cacheLength) return false;
  for (let i = 0; i < cacheLength; i++) if (cachedIds[i] !== promptIds[i]) return false;
  return true;
}

/** Runs one subagent generation (no tools, no shared cache). Returns raw text. */
async function runSubagent(
  pipe: Generator,
  messages: AgentMessage[],
  options: JsonObject,
  onToken?: (count: number) => void
): Promise<string> {
  let raw = "";
  const startedAt = performance.now();
  const streamer = new TextStreamer(pipe.tokenizer as never, {
    skip_prompt: true,
    skip_special_tokens: false,
    callback_function: (text: string) => {
      raw += text;
    },
    token_callback_function: (ids: bigint[]) => {
      generatedTokens += ids.length;
      onToken?.(ids.length);
      maybePostMetrics(startedAt);
    },
  });
  await pipe(messages, { ...options, use_cache: true, streamer, stopping_criteria: stoppingCriteria });
  generationMs += performance.now() - startedAt;
  return raw;
}

// ---------------------------------------------------------------- main-thread round trips

function requestUser(interaction: UserInteraction): Promise<JsonObject> {
  if (pendingInteraction) return Promise.resolve({ error: "Another user question is already pending." });
  return new Promise((resolve) => {
    pendingInteraction = { id: interaction.id, resolve };
    post({ type: "interaction", data: interaction });
  });
}

function requestLocation(): Promise<JsonObject> {
  if (pendingLocation) return Promise.resolve({ error: "Another location request is pending." });
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    pendingLocation = { id, resolve };
    post({ type: "location_request", id });
  });
}

async function reverseGeocode(location: BrowserLocation): Promise<JsonObject> {
  const { latitude, longitude, accuracy } = location;
  try {
    const url = new URL("https://api.bigdatacloud.net/data/reverse-geocode-client");
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set("localityLanguage", navigator.language.slice(0, 2) || "en");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Reverse geocoding returned HTTP ${response.status}`);
    const data = (await response.json()) as JsonObject;
    return {
      latitude,
      longitude,
      accuracy,
      lookupSource: data.lookupSource,
      countryName: data.countryName,
      countryCode: data.countryCode,
      principalSubdivision: data.principalSubdivision,
      city: data.city,
      locality: data.locality,
    };
  } catch (error) {
    return {
      latitude,
      longitude,
      accuracy,
      reverseGeocodingError: (error instanceof Error && error.message) || "Location resolution failed",
    };
  }
}

/** §7.6 — memoized per run. */
function getLocation(): Promise<JsonObject> {
  resolvedLocationPromise ??= requestLocation().then((result) =>
    "error" in result ? result : reverseGeocode(result as unknown as BrowserLocation)
  );
  return resolvedLocationPromise;
}

function requestWebpage(url: string): Promise<WebpageDocument | { error: string }> {
  if (pendingWebpage) return Promise.resolve({ error: "Another webpage request is pending." });
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (pendingWebpage?.id !== id) return;
      pendingWebpage = null;
      post({ type: "webpage_cancel", id });
      resolve({ error: "Webpage fetch timed out." });
    }, WEBPAGE_TIMEOUT_MS);
    pendingWebpage = { id, resolve, timer };
    post({ type: "webpage_request", id, url });
  });
}

function requestPython(code: string, timeoutMs: number): Promise<PythonResult | JsonObject> {
  if (pendingPython) return Promise.resolve({ ok: false, error: "Another Python call is pending." });
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (pendingPython?.id !== id) return;
      pendingPython = null;
      post({ type: "python_cancel", id });
      resolve({ ok: false, error: "Python runner did not respond in time.", timed_out: true });
    }, PYTHON_TIMEOUT_MS);
    pendingPython = { id, resolve, timer };
    post({ type: "python_request", id, code, timeoutMs });
  });
}

function requestMcp(call: ParsedToolCall): Promise<JsonObject> {
  if (stopRequested) return Promise.resolve({ cancelled: true });
  const mcp = activeMcp;
  if (!mcp) return Promise.resolve({ error: "No MCP tools enabled for this session." });
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (pendingMcp?.id !== id) return;
      pendingMcp = null;
      post({ type: "mcp_cancel", id });
      resolve({ error: "MCP request timed out.", server_url: mcp.url });
    }, MCP_TIMEOUT_MS);
    pendingMcp = { id, resolve, timer };
    post({ type: "mcp_request", id, url: mcp.url, name: call.name, arguments: call.arguments });
  });
}

// ---------------------------------------------------------------- research subagents

/** §7.7 */
async function researchWikipedia(question: string, language: string): Promise<JsonObject> {
  try {
    const pipe = await loadModel();
    const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
    url.search = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: question,
      gsrlimit: String(MAX_WIKIPEDIA_PAGES),
      prop: "extracts|info",
      explaintext: "1",
      inprop: "url",
      format: "json",
      origin: "*",
    }).toString();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Wikipedia returned HTTP ${response.status}`);
    const payload = (await response.json()) as {
      query?: { pages?: Record<string, { index?: number; pageid: number; title: string; fullurl?: string; extract?: string }> };
    };
    let remaining = MAX_WIKIPEDIA_CONTEXT_CHARS;
    const documents = Object.values(payload.query?.pages ?? {})
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((page) => {
        const extract = (page.extract ?? "").slice(0, Math.min(MAX_WIKIPEDIA_PAGE_CHARS, remaining));
        remaining -= extract.length;
        return { pageId: page.pageid, title: page.title, url: page.fullurl ?? "", extract };
      })
      .filter((document) => document.extract);
    if (!documents.length) return { error: "Wikipedia returned no readable pages for this question.", question };
    if (stopRequested) return { cancelled: true };

    const evidence = documents
      .map((document, i) => `[${i + 1}] ${document.title}\nURL: ${document.url}\n${document.extract}`)
      .join("\n\n---\n\n");
    const raw = await runSubagent(
      pipe,
      [
        { role: "system", content: WIKIPEDIA_RESEARCH_SYSTEM },
        { role: "user", content: wikipediaResearchUser(question, evidence) },
      ],
      { max_new_tokens: MAX_RESEARCH_TOKENS, do_sample: true, temperature: 0.15, top_k: 50, repetition_penalty: 1.05 }
    );
    if (stopRequested) return { cancelled: true };
    const synthesis = (parseTurn(raw).content || cleanGeneratedText(raw)).slice(0, MAX_RESEARCH_BRIEF_CHARS).trim();
    return {
      mode: "isolated_research_subagent",
      question,
      synthesis,
      sources: documents.map((document, i) => ({
        citation: `[${i + 1}]`,
        pageId: document.pageId,
        title: document.title,
        url: document.url,
      })),
    };
  } catch (error) {
    return { error: (error instanceof Error && error.message) || "Wikipedia research failed", question };
  }
}

/** §7.8 */
async function readWebpage(url: string, question: string): Promise<JsonObject> {
  try {
    const pipe = await loadModel();
    const page = await requestWebpage(url);
    if (stopRequested) return { cancelled: true };
    if ("error" in page) return page;

    const focus = question.trim().slice(0, 800);
    const passage = webpagePassage(page.text, (text) => countTokens(pipe, text));
    const coverage = {
      extracted_chars: page.extractedChars,
      retained_chars: page.text.length,
      analyzed_chars: passage.text.length,
      available_tokens: passage.totalTokens,
      passage_tokens: passage.tokenCount,
      passage_token_limit: WEBPAGE_PASSAGE_TOKEN_LIMIT,
      input_token_limit: MAX_WEBPAGE_RESEARCH_INPUT_TOKENS,
      page_truncated: page.truncated,
      token_truncated: passage.truncated,
      partial: page.truncated || passage.truncated,
    };
    if (stopRequested) return { cancelled: true };

    const messages: AgentMessage[] = [
      { role: "system", content: WEBPAGE_ANALYST_SYSTEM },
      {
        role: "user",
        content: webpageAnalystUser({
          focus,
          prompt: runPrompt,
          goal: activePlan?.goal ?? "",
          title: page.title,
          url: page.url,
          start: passage.start,
          end: passage.end,
          text: passage.text,
        }),
      },
    ];
    if (tokenizeChatPrompt(pipe, messages).length > MAX_WEBPAGE_RESEARCH_INPUT_TOKENS)
      throw new Error("Webpage research input exceeds the 12000-token budget; shorten your question.");

    let passTokens = 0;
    const raw = await runSubagent(
      pipe,
      messages,
      { max_new_tokens: MAX_WEBPAGE_RESEARCH_TOKENS, do_sample: false, repetition_penalty: 1.05 },
      (count) => {
        passTokens += count;
      }
    );
    const outputLimited = passTokens >= MAX_WEBPAGE_RESEARCH_TOKENS;
    const finishReason = stopRequested ? "cancelled" : outputLimited ? "length" : "eos_or_stop";
    if (stopRequested) return { cancelled: true };

    const brief = parseTurn(raw).content.trim();
    const useExcerpt = outputLimited || !brief;
    const generation = {
      passage: 1,
      generated_tokens: passTokens,
      max_new_tokens: MAX_WEBPAGE_RESEARCH_TOKENS,
      finish_reason: finishReason,
      brief_shortened: !useExcerpt && brief.length > WEBPAGE_BRIEF_CHARS,
      used_source_excerpt: useExcerpt,
    };
    const synthesis = (
      useExcerpt
        ? `Passage 1: ${
            outputLimited
              ? "Research output reached its 4096-token limit and may be incomplete."
              : "Summarizer did not produce a finished brief."
          } Verbatim source excerpt: ${webpageExcerpt(passage.text, focus)}`
        : `Passage 1: ${brief.slice(0, WEBPAGE_BRIEF_CHARS)}${
            brief.length > WEBPAGE_BRIEF_CHARS ? "\n[Brief shortened for parent context.]" : ""
          }`
    ).slice(0, MAX_WEBPAGE_BRIEF_CHARS);
    return {
      mode: "isolated_webpage_research",
      question: focus,
      synthesis,
      sources: [{ citation: "[1]", title: page.title, url: page.url }],
      coverage,
      research_generations: [generation],
      limitations: coverage.partial ? WEBPAGE_PARTIAL_COVERAGE : WEBPAGE_FULL_COVERAGE,
    };
  } catch (error) {
    return { error: getErrorMessage(error), url };
  }
}

// ---------------------------------------------------------------- tools (§7.0)

/** Read through a function: tool callbacks mutate the plan mid-loop, which
 *  TypeScript's narrowing inside generate() cannot see. */
function currentPlan(): ActionPlan | null {
  return activePlan;
}

const toolContext: ToolExecutionContext = {
  getActivePlan: () => activePlan,
  setActivePlan(plan) {
    activePlan = plan;
    post({ type: "plan", data: plan });
  },
  askUser: requestUser,
  getLocation,
  researchWikipedia,
  readWebpage,
  runPython: requestPython,
};

async function executeTool(call: ParsedToolCall): Promise<JsonObject> {
  if (stopRequested) return { cancelled: true };
  if (activeMcp?.tools.some((tool) => tool.name === call.name)) return requestMcp(call);
  await delay(TOOL_DELAY_MS);
  const definition = AGENT_TOOLS.find((tool) => tool.name === call.name);
  if (!definition) throw new Error(`Unknown tool: ${call.name}`);
  return definition.execute(call.arguments, toolContext);
}

// ---------------------------------------------------------------- final response (§6.6)

function completePlanWithFinalResponse(): void {
  if (!activePlan) return;
  const steps = activePlan.steps.map((step, i, all) =>
    i === all.length - 1
      ? { ...step, status: "completed" as const, note: "Final response and downloadable report completed." }
      : { ...step, status: "completed" as const }
  );
  activePlan = { ...activePlan, steps, currentStep: steps.length, status: "completed", updatedAt: Date.now() };
  post({ type: "plan", data: activePlan });
}

// ---------------------------------------------------------------- the loop (§6)

async function generate(prompt: string, allowedTools: string[], mcp?: McpConfiguration): Promise<void> {
  const pipe = await loadModel();
  runStartedAt = performance.now();
  generatedTokens = 0;
  generationMs = 0;
  lastMetricsAt = 0;
  stoppingCriteria = new InterruptableStoppingCriteria();
  stopRequested = false;
  activePlan = null;
  pendingInteraction = null;
  pendingLocation = null;
  resolvedLocationPromise = null;
  runPrompt = prompt;

  // §8 — tool availability for this run.
  const builtInNames = AGENT_TOOLS.map((tool) => tool.name);
  if (mcp) {
    const cloned = structuredClone(mcp);
    cloned.tools = cloned.tools.filter((tool) => MCP_NAME.test(tool.name) && !builtInNames.includes(tool.name));
    activeMcp = cloned;
  } else activeMcp = undefined;
  const mcpTools = activeMcp?.tools ?? [];
  const allowedToolNames = new Set<string>([
    "create_action_plan",
    "update_action_plan",
    ...allowedTools,
    ...mcpTools.map((tool) => tool.name),
  ]);
  const toolSchemas: ToolSchema[] = [
    ...AGENT_TOOLS.filter((tool) => allowedToolNames.has(tool.name)).map((tool) => tool.schema),
    ...mcpTools.map((tool) => ({
      type: "function" as const,
      function: { name: tool.name, description: tool.description, parameters: tool.parameters as JsonObject },
    })),
  ];
  const knownNames = [...builtInNames, ...mcpTools.map((tool) => tool.name)];

  const messages: AgentMessage[] = [
    { role: "system", content: SYSTEM_PROMPT + (mcpTools.length ? MCP_SUFFIX : "") },
    { role: "user", content: prompt },
  ];
  post({ type: "start" });

  let workflowFinished = false;
  let clarificationCompleted = false;
  let locationResolutionAttempted = false;
  const researchSources = new Map<string, ResearchSource>();
  let webpageReadAttempted = false;
  let pythonAttempted = false;
  let mcpAttempted = false;
  let conversationCache: Cache = new DynamicCache();
  let cachedTokenIds: bigint[] = [];

  try {
    for (let turn = 1; turn <= MAX_AGENT_TURNS && !stopRequested; turn++) {
      // §4.4 — reuse the KV cache only when it is an exact prefix of the new prompt.
      const turnStartedAt = performance.now();
      const promptTokenIds = tokenizeChatPrompt(pipe, messages, toolSchemas);
      const cacheLength = conversationCache.get_seq_length();
      if (cacheLength > 0 && !isExactCachedPrefix(cacheLength, cachedTokenIds, promptTokenIds)) {
        await conversationCache.dispose();
        conversationCache = new DynamicCache();
        cachedTokenIds = [];
      }

      let rawTurn = "";
      const turnTokenIds: bigint[] = [];
      const streamer = new TextStreamer(pipe.tokenizer as never, {
        skip_prompt: true,
        skip_special_tokens: false,
        callback_function: (text: string) => {
          rawTurn += text;
          post({ type: "turn", data: parseTurn(rawTurn, turn, false) });
        },
        token_callback_function: (ids: bigint[]) => {
          turnTokenIds.push(...ids);
          generatedTokens += ids.length;
          maybePostMetrics(turnStartedAt);
        },
      });
      await pipe(messages, {
        max_new_tokens: MAX_NEW_TOKENS,
        do_sample: true,
        temperature: 0.2,
        top_k: 80,
        repetition_penalty: 1.05,
        use_cache: true,
        past_key_values: conversationCache,
        tools: toolSchemas,
        streamer,
        stopping_criteria: stoppingCriteria,
      });
      generationMs += performance.now() - turnStartedAt;
      cachedTokenIds = [...promptTokenIds, ...turnTokenIds].slice(0, conversationCache.get_seq_length());
      post({ type: "turn", data: parseTurn(rawTurn, turn, false) });
      if (stopRequested) break;

      const parsed = parseTurn(rawTurn, turn);
      const toolCalls = parseToolCalls(rawTurn, knownNames);
      const rejectedTurn: AgentMessage = { role: "assistant", content: parsed.content, thinking: parsed.thinking };

      // §6.3 step 5 — no tool calls: accept a final answer or push a controller message.
      if (!toolCalls.length) {
        const finalResponse = parsed.content.trim();
        const hasEvidence = researchSources.size > 0 || webpageReadAttempted || pythonAttempted || mcpAttempted;
        if (currentPlan() && hasEvidence && finalResponse) {
          completePlanWithFinalResponse();
          workflowFinished = true;
          const sources = [...researchSources.values()];
          const responseWithSources = appendSourcePages(finalResponse, sources);
          post({ type: "turn", data: { ...parseTurn(rawTurn, turn, true), content: responseWithSources } });
          const paperTrace = {
            id: `paper-${turn}`,
            kind: "tool" as const,
            name: "create_research_paper",
            arguments: { format: "markdown", source_pages: sources.length },
            status: "running" as const,
          };
          post({ type: "tool", data: paperTrace });
          const paper = createResearchPaper(responseWithSources, sources);
          post({ type: "artifact", data: paper });
          post({
            type: "tool",
            data: {
              ...paperTrace,
              result: { filename: paper.filename, format: paper.mimeType, source_pages: sources.length },
              status: "complete",
            },
          });
          break;
        }
        messages.push(rejectedTurn);
        messages.push({
          role: "user",
          content:
            researchSources.size > 0
              ? REVIEW_EVIDENCE_MESSAGE
              : currentPlan()?.status === "completed"
                ? NO_EVIDENCE_MESSAGE
                : workflowControllerMessage(currentPlan()),
        });
        continue;
      }

      // §6.3 steps 6–7 — decide which calls run.
      let accepted: ParsedToolCall[];
      if (!currentPlan()) {
        const planCall = toolCalls.find((call) => call.name === "create_action_plan");
        if (!planCall) {
          messages.push(rejectedTurn, { role: "user", content: PLAN_FIRST_MESSAGE });
          continue;
        }
        accepted = [planCall];
      } else {
        const question = clarificationCompleted ? undefined : toolCalls.find((call) => call.name === "ask_user");
        if (question) accepted = [question];
        else {
          let locationCallAccepted = locationResolutionAttempted;
          accepted = toolCalls.filter((call) => {
            if (call.name === "create_action_plan" || call.name === "ask_user") return false;
            if (!allowedToolNames.has(call.name)) return false;
            if (call.name === "get_current_context" && call.arguments.include_location !== false) {
              if (locationCallAccepted) return false;
              locationCallAccepted = true;
            }
            return true;
          });
          if (!accepted.length) {
            const repeatedLocation =
              locationResolutionAttempted &&
              toolCalls.some(
                (call) => call.name === "get_current_context" && call.arguments.include_location !== false
              );
            messages.push(rejectedTurn, {
              role: "user",
              content: repeatedLocation ? LOCATION_ALREADY_RESOLVED_MESSAGE : workflowControllerMessage(currentPlan()),
            });
            continue;
          }
        }
      }

      // §6.3 step 8 — dispatch sequentially.
      messages.push({
        role: "assistant",
        content: parsed.content,
        thinking: parsed.thinking,
        tool_calls: accepted.map((call) => ({ function: call })),
      });
      for (const [i, call] of accepted.entries()) {
        if (stopRequested) break;
        const running = {
          id: `tool-${turn}-${i}`,
          kind: "tool" as const,
          name: call.name,
          arguments: call.arguments,
          status: "running" as const,
        };
        post({ type: "tool", data: running });
        if (call.name === "read_webpage") webpageReadAttempted = true;
        else if (call.name === "run_python") pythonAttempted = true;
        else if (mcpTools.some((tool) => tool.name === call.name)) mcpAttempted = true;

        const result = await executeTool(call);

        if (call.name === "get_current_context" && call.arguments.include_location !== false)
          locationResolutionAttempted = true;
        if (call.name === "ask_user" && typeof result.answer === "string")
          clarificationCompleted = result.answer.trim().length > 0;
        if (call.name === "search_wikipedia" || call.name === "read_webpage")
          for (const source of extractSources(result)) researchSources.set(source.url, source);

        post({ type: "tool", data: { ...running, result, status: "complete" } });
        messages.push({ role: "tool", content: JSON.stringify({ name: call.name, result }) });
      }
    }

    if (!stopRequested && !workflowFinished)
      throw new Error("The workflow reached its turn limit before every plan step was completed.");
    const stats = createStats(runStartedAt, generationMs, generatedTokens);
    post({ type: "metrics", data: stats });
    post({ type: "complete", data: stats });
  } finally {
    await conversationCache.dispose();
  }
}

// ---------------------------------------------------------------- stop (§6.7)

function stop(): void {
  stopRequested = true;
  stoppingCriteria?.interrupt();
  if (pendingMcp) {
    const { id, resolve, timer } = pendingMcp;
    pendingMcp = null;
    clearTimeout(timer);
    post({ type: "mcp_cancel", id });
    resolve({ cancelled: true, error: "MCP request cancelled. The remote server may already have received the call." });
  }
  if (pendingPython) {
    const { id, resolve, timer } = pendingPython;
    pendingPython = null;
    clearTimeout(timer);
    post({ type: "python_cancel", id });
    resolve({ ok: false, error: "Python execution cancelled.", cancelled: true });
  }
  if (pendingWebpage) {
    const { id, resolve, timer } = pendingWebpage;
    pendingWebpage = null;
    clearTimeout(timer);
    post({ type: "webpage_cancel", id });
    resolve({ error: "Webpage reading cancelled." });
  }
  if (pendingInteraction) {
    const { resolve } = pendingInteraction;
    pendingInteraction = null;
    resolve({ cancelled: true });
  }
  if (pendingLocation) {
    const { resolve } = pendingLocation;
    pendingLocation = null;
    resolve({ error: "Location request cancelled" });
  }
}

// ---------------------------------------------------------------- messages (§6.1, §9.1)

function settle<T>(slot: Pending<T> | null, id: string, value: T): boolean {
  if (!slot || slot.id !== id) return false;
  clearTimeout(slot.timer);
  slot.resolve(value);
  return true;
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  switch (request.type) {
    case "generate":
      runQueue = runQueue
        .then(() => generate(request.prompt, request.allowedTools, request.mcp))
        .catch((error) => post({ type: "error", message: getErrorMessage(error) }));
      return;
    case "interaction_response":
      if (settle(pendingInteraction, request.id, { answer: request.answer })) pendingInteraction = null;
      return;
    case "location_response":
      if (
        settle(
          pendingLocation,
          request.id,
          (request.location as unknown as JsonObject) ?? { error: request.error ?? "Location unavailable" }
        )
      )
        pendingLocation = null;
      return;
    case "webpage_response":
      if (settle(pendingWebpage, request.id, request.page ?? { error: request.error ?? "No webpage returned." }))
        pendingWebpage = null;
      return;
    case "python_response":
      if (settle(pendingPython, request.id, { ...request.result })) pendingPython = null;
      return;
    case "mcp_response":
      if (settle(pendingMcp, request.id, request.result)) pendingMcp = null;
      return;
    case "stop":
      stop();
      return;
    default:
      loadModel().catch((error) => {
        loadingPromise = null;
        post({ type: "error", message: getErrorMessage(error) });
      });
  }
});
