/// <reference lib="webworker" />
// Minimal chat worker for the "keep the secret" game: loads the same model as
// the agent and streams one generation at a time.
import { InterruptableStoppingCriteria, TextStreamer, env, pipeline } from "@huggingface/transformers";
import { MODEL_ID, MODEL_OPTIONS, MODEL_TASK, configureTransformersEnv, normalizeChatTemplate } from "../model";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type GameWorkerRequest =
  | { type: "load" }
  | { type: "generate"; id: string; messages: ChatMessage[]; maxNewTokens: number; sample: boolean }
  | { type: "stop" };

export type GameWorkerResponse =
  | { type: "loading"; data: { progress: number; loaded?: number; total?: number } }
  | { type: "ready" }
  | { type: "delta"; id: string; raw: string; tokens: number }
  | { type: "done"; id: string; raw: string; tokens: number }
  | { type: "error"; id?: string; message: string };

interface Tokenizer {
  chat_template: unknown;
}
interface Generator {
  tokenizer: Tokenizer;
  (input: ChatMessage[], options: Record<string, unknown>): Promise<unknown>;
}

configureTransformersEnv(env as unknown as { experimental_useCrossOriginStorage: boolean });

let generator: Generator | null = null;
let loading: Promise<Generator> | null = null;
let stopping: InstanceType<typeof InterruptableStoppingCriteria> | null = null;
let queue: Promise<void> = Promise.resolve();

const post = (message: GameWorkerResponse) => self.postMessage(message);
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Unknown model runtime error");

async function loadModel(): Promise<Generator> {
  if (generator) return generator;
  loading ??= pipeline(MODEL_TASK, MODEL_ID, {
    ...MODEL_OPTIONS,
    progress_callback: (event: Record<string, unknown>) => {
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
  const pipe = await loading;
  generator = pipe;
  pipe.tokenizer.chat_template = normalizeChatTemplate(pipe.tokenizer.chat_template);
  post({ type: "ready" });
  return pipe;
}

async function generate(id: string, messages: ChatMessage[], maxNewTokens: number, sample: boolean) {
  const pipe = await loadModel();
  stopping = new InterruptableStoppingCriteria();
  let raw = "";
  let tokens = 0;
  let lastTick = 0;
  const streamer = new TextStreamer(pipe.tokenizer as never, {
    skip_prompt: true,
    skip_special_tokens: false,
    callback_function: (text: string) => {
      raw += text;
      post({ type: "delta", id, raw, tokens });
    },
    token_callback_function: (ids: bigint[]) => {
      tokens += ids.length;
      // Thinking can produce tokens without visible text changes; tick the
      // counter at least every 150 ms so the UI never looks stuck.
      const now = performance.now();
      if (now - lastTick > 150) {
        lastTick = now;
        post({ type: "delta", id, raw, tokens });
      }
    },
  });
  await pipe(messages, {
    max_new_tokens: maxNewTokens,
    // Same sampling as the agent's main turns; greedy for the guard.
    ...(sample ? { do_sample: true, temperature: 0.2, top_k: 80 } : { do_sample: false }),
    repetition_penalty: 1.05,
    streamer,
    stopping_criteria: stopping,
  });
  post({ type: "done", id, raw, tokens });
}

self.addEventListener("message", (event: MessageEvent<GameWorkerRequest>) => {
  const request = event.data;
  if (request.type === "stop") {
    stopping?.interrupt();
    return;
  }
  if (request.type === "load") {
    loadModel().catch((error) => {
      loading = null;
      post({ type: "error", message: errorText(error) });
    });
    return;
  }
  queue = queue
    .then(() => generate(request.id, request.messages, request.maxNewTokens, request.sample))
    .catch((error) => post({ type: "error", id: request.id, message: errorText(error) }));
});
