// Game state: model loading, turns, filter/guard passes and leak detection.
import { useCallback, useEffect, useRef, useState } from "react";
import { cleanGeneratedText, parseTurn } from "../agent/parsing";
import type { LoadProgress, ModelPhase } from "../types";
import type { ChatMessage, GameWorkerRequest, GameWorkerResponse } from "../workers/game.worker";
import { detectLeak, filterBlocks } from "./leak";
import { LEVELS, TURNS_PER_LEVEL, guardMessages, pickSecret } from "./levels";

const REPLY_TOKENS = 4096; // thinking + answer
const GUARD_TOKENS = 1024; // the guard thinks before its LEAK/SAFE verdict
const PROGRESS_KEY = "keep-the-secret-unlocked";

export type MessageStatus = "streaming" | "shown" | "filtered" | "guarded";
export interface GameMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  status?: MessageStatus;
  leakHow?: string;
  /** Tokens generated for this reply (live while streaming). */
  tokens?: number;
}
export type Outcome = "playing" | "won" | "lost";
export type Busy = "idle" | "replying" | "guarding";

function readUnlocked(): number {
  try {
    const value = Number(localStorage.getItem(PROGRESS_KEY));
    return Number.isFinite(value) && value >= 1 ? Math.min(value, LEVELS.length) : 1;
  } catch {
    return 1;
  }
}

export function useGame() {
  const workerRef = useRef<Worker | null>(null);
  const pending = useRef(
    new Map<string, { onDelta?(raw: string, tokens: number): void; resolve(raw: string): void; reject(error: Error): void }>()
  );

  const [modelPhase, setModelPhase] = useState<ModelPhase>("idle");
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(readUnlocked);
  const [levelIndex, setLevelIndex] = useState(() => readUnlocked() - 1);
  const [secret, setSecret] = useState(() => pickSecret());
  const [messages, setMessages] = useState<GameMessage[]>([]);
  const [outcome, setOutcome] = useState<Outcome>("playing");
  const [busy, setBusy] = useState<Busy>("idle");
  const [guardTokens, setGuardTokens] = useState(0);

  const level = LEVELS[levelIndex];
  const turnsUsed = messages.filter((message) => message.role === "user").length;

  useEffect(() => {
    const worker = new Worker(new URL("../workers/game.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    const jobs = pending.current;
    worker.onmessage = (event: MessageEvent<GameWorkerResponse>) => {
      const message = event.data;
      switch (message.type) {
        case "loading":
          setModelPhase("loading");
          setProgress(message.data);
          break;
        case "ready":
          setModelPhase("ready");
          break;
        case "delta":
          jobs.get(message.id)?.onDelta?.(message.raw, message.tokens);
          break;
        case "done":
          jobs.get(message.id)?.resolve(message.raw);
          jobs.delete(message.id);
          break;
        case "error":
          if (message.id) {
            jobs.get(message.id)?.reject(new Error(message.message));
            jobs.delete(message.id);
          } else {
            setModelPhase("error");
            setError(message.message);
          }
          break;
      }
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const send = (request: GameWorkerRequest) => workerRef.current?.postMessage(request);

  const run = (
    messages: ChatMessage[],
    maxNewTokens: number,
    sample: boolean,
    onDelta?: (raw: string, tokens: number) => void
  ) =>
    new Promise<string>((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.current.set(id, { onDelta, resolve, reject });
      send({ type: "generate", id, messages, maxNewTokens, sample });
    });

  const load = useCallback(() => {
    setError(null);
    setModelPhase("loading");
    send({ type: "load" });
  }, []);

  const newGame = useCallback(
    (index = levelIndex) => {
      setLevelIndex(index);
      setSecret((current) => pickSecret(current.word));
      setMessages([]);
      setOutcome("playing");
      setError(null);
    },
    [levelIndex]
  );

  const updateLast = (patch: Partial<GameMessage>) =>
    setMessages((current) => {
      const next = current.slice();
      next[next.length - 1] = { ...next[next.length - 1], ...patch };
      return next;
    });

  const sendMessage = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || busy !== "idle" || outcome !== "playing" || modelPhase !== "ready") return;
      if (turnsUsed >= TURNS_PER_LEVEL) return;

      const history: ChatMessage[] = [
        { role: "system", content: level.systemPrompt(secret.word) },
        // The model sees what it actually said, even if a filter hid it.
        ...messages.map((message) => ({ role: message.role, content: message.content })),
        { role: "user", content: prompt },
      ];
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: "user", content: prompt },
        { id: crypto.randomUUID(), role: "assistant", content: "", status: "streaming" },
      ]);
      setBusy("replying");
      setError(null);

      try {
        let replyTokens = 0;
        const raw = await run(history, REPLY_TOKENS, true, (partial, tokens) => {
          replyTokens = tokens;
          const turn = parseTurn(partial);
          updateLast({ content: turn.content, thinking: turn.thinking, tokens });
        });
        const turn = parseTurn(raw);
        const content = turn.content || "(…it got lost in thought and never answered.)";
        let status: MessageStatus = "shown";

        if (level.filter && filterBlocks(content, secret.word)) status = "filtered";
        else if (level.guard) {
          setBusy("guarding");
          setGuardTokens(0);
          const verdictRaw = await run(guardMessages(secret.word, content), GUARD_TOKENS, false, (_, tokens) =>
            setGuardTokens(tokens)
          );
          const verdict = (parseTurn(verdictRaw).content || cleanGeneratedText(verdictRaw)).toUpperCase();
          // An unclear verdict counts as LEAK: the guard errs on the side of caution.
          if (verdict.includes("LEAK") || !verdict.includes("SAFE")) status = "guarded";
        }

        const leak = status === "shown" ? detectLeak(content, secret.word) : { leaked: false };
        updateLast({ content, thinking: turn.thinking, status, leakHow: leak.how, tokens: replyTokens });

        if (leak.leaked) {
          setOutcome("won");
          const nextUnlocked = Math.max(unlocked, Math.min(level.id + 1, LEVELS.length));
          setUnlocked(nextUnlocked);
          try {
            localStorage.setItem(PROGRESS_KEY, String(nextUnlocked));
          } catch {
            /* progress just won't persist */
          }
        } else if (turnsUsed + 1 >= TURNS_PER_LEVEL) setOutcome("lost");
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        updateLast({ content: "(The model hit an error. Try again or reload the page.)", status: "shown" });
      } finally {
        setBusy("idle");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, outcome, modelPhase, turnsUsed, level, secret, messages, unlocked]
  );

  const stop = useCallback(() => send({ type: "stop" }), []);

  return {
    modelPhase,
    progress,
    error,
    level,
    levelIndex,
    unlocked,
    secret,
    messages,
    outcome,
    busy,
    guardTokens,
    turnsUsed,
    load,
    newGame,
    sendMessage,
    stop,
  };
}
