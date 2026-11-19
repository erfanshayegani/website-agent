// Output parsing: thinking/answer split and LFM tool-call syntax (SPEC §4.7, §4.8, §5, §7.2).
import type { AgentTurnTrace } from "../types";

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const THINK_TAG = /<\/?think>/g;
const CONTROL_TOKEN = /<\|(?:im_start|im_end|tool_call_start|tool_call_end)\|>/g;
const THINK_CLOSE = "</think>";
const TOOL_CALL_START = "<|tool_call_start|>";

/** §4.8 — drop think tags and chat control tokens, then trim. */
export function cleanGeneratedText(text: string): string {
  return text.replace(THINK_TAG, "").replace(CONTROL_TOKEN, "").trim();
}

/**
 * §4.7 — the generation prompt opens <think>, so raw output starts inside the
 * thinking block. Without </think> everything is thinking.
 */
export function parseTurn(
  raw: string,
  turn = 0,
  isFinal = false
): AgentTurnTrace {
  const close = raw.indexOf(THINK_CLOSE);
  const thinking = cleanGeneratedText(close === -1 ? raw : raw.slice(0, close));
  let answer = close === -1 ? "" : raw.slice(close + THINK_CLOSE.length);
  const callStart = answer.indexOf(TOOL_CALL_START);
  if (callStart !== -1) answer = answer.slice(0, callStart);
  return {
    id: `turn-${turn}`,
    kind: "turn",
    turn,
    thinking,
    content: cleanGeneratedText(answer),
    isFinal,
  };
}

// ---------------------------------------------------------------- arguments

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t" };

function unquote(value: string): string {
  return value
    .slice(1, -1)
    .replace(/\\(['"\\nrt])/g, (_, char: string) => ESCAPES[char] ?? char);
}

/** §5.2 */
export function parseArgumentValue(input: string): unknown {
  const value = input.trim();
  const quoted =
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'));
  if (quoted) return unquote(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const strings = [...value.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map(
      (match) => unquote(match[0])
    );
    if (strings.length) return strings;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** §5.1 — key=value pairs only; later duplicates win. */
export function parseArguments(source: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const pair =
    /(\w+)\s*=\s*('(?:\\.|[^'])*'|"(?:\\.|[^"])*"|true|false|null|-?\d+(?:\.\d+)?|\[[^\]]*\]|\{[^}]*\})/g;
  for (const match of source.matchAll(pair))
    args[match[1]] = parseArgumentValue(match[2]);
  return args;
}

/**
 * §5 — parse the first <|tool_call_start|>[...]<|tool_call_end|> block.
 * `knownNames` lists every built-in (enabled or not) then the run's MCP names.
 */
export function parseToolCalls(
  raw: string,
  knownNames: readonly string[]
): ParsedToolCall[] {
  const block = raw.match(
    /<\|tool_call_start\|>\s*\[([\s\S]*?)\]\s*<\|tool_call_end\|>/
  )?.[1];
  if (!block || !knownNames.length) return [];
  const names = knownNames.join("|");
  const call = new RegExp(
    `(${names})\\s*\\(([\\s\\S]*?)\\)(?=\\s*,\\s*(?:${names})\\s*\\(|\\s*$)`,
    "g"
  );
  return [...block.matchAll(call)].map((match) => ({
    name: match[1],
    arguments: parseArguments(match[2]),
  }));
}

/** §7.2 — tolerant list coercion for plan steps and ask_user options. */
export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  const quoted = [...value.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  if (quoted.length) return quoted;
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(/;|\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}
