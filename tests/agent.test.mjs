// Agent-loop tests: the real worker (src/workers/agent.worker.ts) driven by a
// scripted fake model. No GPU or model download. Behaviors follow docs/SPEC.md.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

/** Values from the vm realm have foreign prototypes; compare plain copies. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Load a TS module and its relative imports; bare imports come from `externals`. */
async function loadGraph(entry, externals, globals) {
  const cache = new Map();
  const sources = new Map();
  // Pre-read every reachable file (sync require needs the text up front).
  async function collect(file) {
    if (sources.has(file)) return;
    const source = await readFile(file, "utf8");
    sources.set(file, source);
    for (const match of source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g))
      await collect(resolve(file, match[1]));
  }
  function resolve(from, specifier) {
    const base = path.resolve(path.dirname(from), specifier);
    for (const candidate of [base + ".ts", base + ".tsx", base])
      if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) return candidate;
    return base;
  }
  function run(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const code = ts.transpileModule(sources.get(file).replace(/import\.meta\.env/g, "({})"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(code, {
      exports,
      require: (name) => {
        if (name.startsWith(".")) return run(resolve(file, name));
        if (name in externals) return externals[name];
        throw new Error("Unexpected import " + name);
      },
      structuredClone,
      setTimeout,
      clearTimeout,
      URL,
      URLSearchParams,
      AbortController,
      AbortSignal,
      crypto,
      performance,
      console,
      Intl,
      navigator: { language: "en-US", onLine: true },
      ...globals,
    });
    return exports;
  }
  await collect(path.join(ROOT, entry));
  return run(path.join(ROOT, entry));
}

/**
 * Start the worker with a scripted main agent. `script` is an array of raw
 * outputs (one per main turn); `subagent(messages)` answers research calls;
 * `onPost(message, reply)` lets a test answer main-thread requests.
 */
async function startWorker({ script, subagent, onPost, fetch }) {
  let receive;
  const sent = [];
  const mainInputs = [];
  let done;
  const finished = new Promise((resolve) => (done = resolve));
  let mainTurn = 0;
  let interrupted = false;

  class Streamer {
    constructor(_tokenizer, options) {
      Object.assign(this, options);
    }
  }
  class Cache {
    get_seq_length() {
      return 0;
    }
    async dispose() {}
  }
  class Stop {
    interrupt() {
      interrupted = true;
    }
  }
  const pipe = Object.assign(
    async (messages, options) => {
      const isMain = Array.isArray(options.tools);
      let raw;
      if (isMain) {
        mainInputs.push({ messages: structuredClone(messages), options });
        raw = script[Math.min(mainTurn++, script.length - 1)];
        if (typeof raw === "function") raw = raw(messages);
      } else raw = subagent ? subagent(messages, options) : "<think></think>brief";
      options.streamer.token_callback_function([1n, 2n]);
      if (!interrupted) options.streamer.callback_function(raw);
    },
    {
      tokenizer: Object.assign(
        (text) => ({ input_ids: { tolist: () => [[1n]], dims: [1, Math.ceil(String(text).length / 4)] } }),
        {
          chat_template: "{% generation %}x{% endgeneration %}",
          apply_chat_template: (messages, options) => JSON.stringify({ messages, tools: options.tools }),
        }
      ),
    }
  );

  await loadGraph(
    "src/workers/agent.worker.ts",
    {
      "@huggingface/transformers": {
        DynamicCache: Cache,
        InterruptableStoppingCriteria: Stop,
        TextStreamer: Streamer,
        env: {},
        pipeline: async () => pipe,
      },
    },
    {
      setTimeout: (fn, delay) => setTimeout(fn, delay === 280 ? 0 : delay),
      fetch: fetch ?? (() => Promise.reject(new Error("unexpected fetch"))),
      self: {
        addEventListener(_type, callback) {
          receive = callback;
        },
        postMessage(message) {
          sent.push(message);
          if (message.type === "complete" || message.type === "error") done(message);
          onPost?.(message, (data) => queueMicrotask(() => receive({ data })));
        },
      },
    }
  );
  return {
    sent,
    mainInputs,
    pipe,
    finished,
    send: (data) => receive({ data }),
  };
}

const PLAN =
  "<think>Plan first.</think><|tool_call_start|>[create_action_plan(goal='Compute a distance', steps=['Run Python','Explain result'], priority='medium')]<|tool_call_end|>";
const python = (code) =>
  `<think></think><|tool_call_start|>[run_python(code=${JSON.stringify(code)})]<|tool_call_end|>`;
const ANSWER = "<think>Done.</think>The Euclidean distance is 5.";

const pythonReply = (handler) => (message, reply) => {
  if (message.type === "python_request")
    reply({ type: "python_response", id: message.id, result: handler(message.code) });
};
const ok = (stdout) => ({ ok: true, stdout, stderr: "", result: null, error: null, elapsed_ms: 1 });
const toolResults = (inputs, name) =>
  inputs
    .at(-1)
    .messages.filter((m) => m.role === "tool")
    .map((m) => JSON.parse(m.content))
    .filter((m) => m.name === name)
    .map((m) => m.result);

// ---------------------------------------------------------------- tests

test("Python run: plan → tool → accepted answer, with the spec's end-of-run order", async () => {
  const w = await startWorker({ script: [PLAN, python("print(5.0)"), ANSWER], onPost: pythonReply(() => ok("5.0\n")) });
  w.send({ type: "generate", prompt: "Distance between (1,2) and (4,6)?", allowedTools: ["run_python"] });
  const done = await w.finished;
  assert.equal(done.type, "complete", done.message);

  // Model saw the verbatim system prompt and the normalized chat template.
  assert.match(w.mainInputs[0].messages[0].content, /call run_python rather than guessing/);
  assert.equal(w.pipe.tokenizer.chat_template, "x");
  // Sampling parameters for main turns (§4.5).
  const opts = w.mainInputs[0].options;
  assert.deepEqual(
    [opts.max_new_tokens, opts.do_sample, opts.temperature, opts.top_k, opts.repetition_penalty],
    [3000, true, 0.2, 80, 1.05]
  );
  // Only enabled built-ins + plan tools are offered.
  assert.deepEqual(
    plain(opts.tools.map((t) => t.function.name)),
    ["run_python", "create_action_plan", "update_action_plan"]
  );
  assert.equal(toolResults(w.mainInputs, "run_python")[0].stdout, "5.0\n");

  const tail = w.sent.slice(-8).map((m) => (m.type === "tool" ? `tool:${m.data.status}` : m.type));
  assert.deepEqual(tail, ["turn", "plan", "turn", "tool:running", "artifact", "tool:complete", "metrics", "complete"]);
  const final = w.sent.find((m) => m.type === "turn" && m.data.isFinal);
  assert.equal(final.data.content, "The Euclidean distance is 5.");
  const plan = w.sent.filter((m) => m.type === "plan").at(-1).data;
  assert.equal(plan.status, "completed");
  assert.equal(plan.steps.at(-1).note, "Final response and downloadable report completed.");
});

test("Python repair: a failed run is returned to the model, which retries", async () => {
  let call = 0;
  const w = await startWorker({
    script: [PLAN, python("print(1/0)"), python("print(5.0)"), ANSWER],
    onPost: pythonReply(() =>
      call++ === 0
        ? { ok: false, stdout: "", stderr: "", result: null, error: "ZeroDivisionError: division by zero", elapsed_ms: 1 }
        : ok("5.0\n")
    ),
  });
  w.send({ type: "generate", prompt: "Compute it", allowedTools: ["run_python"] });
  assert.equal((await w.finished).type, "complete");
  const results = toolResults(w.mainInputs, "run_python");
  assert.match(results[0].error, /ZeroDivisionError/);
  assert.equal(results[1].stdout, "5.0\n");
});

test("an attempted (failed) Python call still satisfies the evidence gate", async () => {
  const w = await startWorker({
    script: [PLAN, python("print(1)"), "<think></think>Python was unavailable, so I could not compute it."],
    onPost: pythonReply(() => ({ ok: false, stdout: "", stderr: "", result: null, error: "Could not load Python runtime", elapsed_ms: 0 })),
  });
  w.send({ type: "generate", prompt: "Compute it", allowedTools: ["run_python"] });
  assert.equal((await w.finished).type, "complete");
  assert.ok(w.sent.some((m) => m.type === "turn" && m.data.isFinal));
});

test("Stop during a Python call cancels it and the run ends with complete", async () => {
  const w = await startWorker({
    script: [PLAN, python("while True: pass"), ANSWER],
    onPost: (message, reply) => {
      if (message.type === "python_request") reply({ type: "stop" });
    },
  });
  w.send({ type: "generate", prompt: "Loop forever", allowedTools: ["run_python"] });
  assert.equal((await w.finished).type, "complete");
  assert.ok(w.sent.some((m) => m.type === "python_cancel"));
  const tool = w.sent.filter((m) => m.type === "tool" && m.data.name === "run_python").at(-1);
  assert.equal(tool.data.status, "complete");
  assert.equal(tool.data.result.cancelled, true);
  assert.ok(!w.sent.some((m) => m.type === "turn" && m.data.isFinal));
});

test("workflow controller: answer before a plan, and tools before a plan, are rejected", async () => {
  const w = await startWorker({
    script: ["<think></think>Here is an answer without a plan.", python("print(1)"), PLAN, python("print(5)"), ANSWER],
    onPost: pythonReply(() => ok("5\n")),
  });
  w.send({ type: "generate", prompt: "Compute", allowedTools: ["run_python"] });
  assert.equal((await w.finished).type, "complete");
  const second = w.mainInputs[1].messages;
  assert.match(second.at(-1).content, /^WORKFLOW CONTROLLER: No action plan exists/);
  const third = w.mainInputs[2].messages;
  assert.match(third.at(-1).content, /must be the first tool call of every conversation/);
  // Rejected calls vanish from the context: the assistant turn has no tool_calls.
  assert.equal(third.at(-2).role, "assistant");
  assert.equal(third.at(-2).tool_calls, undefined);
});

test("an answer with a plan but no evidence gets the unfinished-agenda message (W2)", async () => {
  const w = await startWorker({
    script: [PLAN, "<think></think>I think it is 5.", python("print(5)"), ANSWER],
    onPost: pythonReply(() => ok("5\n")),
  });
  w.send({ type: "generate", prompt: "Compute", allowedTools: ["run_python"] });
  assert.equal((await w.finished).type, "complete");
  const w2 = w.mainInputs[2].messages.at(-1).content;
  assert.match(w2, /^WORKFLOW CONTROLLER: The response was not delivered because the agenda is unfinished/);
  assert.match(w2, /\nCurrent step: Run Python\nAgenda:\n1\. Run Python: in_progress\n2\. Explain result: pending$/);
});

test("without any evidence the run hits the 100-turn limit", async () => {
  const w = await startWorker({ script: [PLAN, "<think></think>Answer."] });
  w.send({ type: "generate", prompt: "Hi", allowedTools: [] });
  const done = await w.finished;
  assert.equal(done.type, "error");
  assert.equal(done.message, "The workflow reached its turn limit before every plan step was completed.");
  assert.equal(w.mainInputs.length, 100);
});

test("ask_user pre-empts other calls until answered; answers reach the model", async () => {
  const w = await startWorker({
    script: [
      PLAN,
      "<think></think><|tool_call_start|>[ask_user(question='Which era?', response_type='select', options=['Ancient','Modern']), run_python(code='print(1)')]<|tool_call_end|>",
      python("print(5)"),
      ANSWER,
    ],
    onPost: (message, reply) => {
      if (message.type === "interaction") reply({ type: "interaction_response", id: message.data.id, answer: "Modern" });
      pythonReply(() => ok("5\n"))(message, reply);
    },
  });
  w.send({ type: "generate", prompt: "History?", allowedTools: ["ask_user", "run_python"] });
  assert.equal((await w.finished).type, "complete");
  const interaction = w.sent.find((m) => m.type === "interaction").data;
  assert.deepEqual(plain([interaction.responseType, interaction.options]), ["select", ["Ancient", "Modern"]]);
  assert.deepEqual(plain(toolResults(w.mainInputs, "ask_user")), [{ answer: "Modern" }]);
  // The python call in the ask_user turn was dropped; only the later one ran.
  assert.equal(w.sent.filter((m) => m.type === "python_request").length, 1);
});

test("Wikipedia research: API params, subagent brief, and appended source pages", async () => {
  let requested;
  const w = await startWorker({
    script: [
      PLAN,
      "<think></think><|tool_call_start|>[search_wikipedia(query='What is WebGPU?')]<|tool_call_end|>",
      "<think></think>WebGPU is a graphics and compute API [1].",
    ],
    subagent: (messages, options) => {
      assert.match(messages[0].content, /^You are an isolated Wikipedia research subagent/);
      assert.match(messages[1].content, /^Research question: What is WebGPU\?\n\nWikipedia evidence:\n\[1\] WebGPU\nURL: https:\/\/en\.wikipedia\.org\/wiki\/WebGPU\n/);
      assert.deepEqual([options.max_new_tokens, options.temperature, options.top_k], [600, 0.15, 50]);
      return "<think>reading</think>WebGPU is a web API [1].";
    },
    fetch: async (url) => {
      requested = new URL(String(url));
      return new Response(
        JSON.stringify({
          query: {
            pages: {
              1: { index: 1, pageid: 7, title: "WebGPU", fullurl: "https://en.wikipedia.org/wiki/WebGPU", extract: "WebGPU is an API." },
            },
          },
        })
      );
    },
  });
  w.send({ type: "generate", prompt: "What is WebGPU?", allowedTools: ["search_wikipedia"] });
  assert.equal((await w.finished).type, "complete");
  assert.equal(requested.hostname, "en.wikipedia.org");
  assert.equal(
    requested.search,
    "?action=query&generator=search&gsrsearch=What+is+WebGPU%3F&gsrlimit=2&prop=extracts%7Cinfo&explaintext=1&inprop=url&format=json&origin=*"
  );
  const [result] = toolResults(w.mainInputs, "search_wikipedia");
  assert.equal(result.mode, "isolated_research_subagent");
  assert.equal(result.synthesis, "WebGPU is a web API [1].");
  const final = w.sent.find((m) => m.type === "turn" && m.data.isFinal).data.content;
  assert.equal(
    final,
    "WebGPU is a graphics and compute API [1].\n\n## Source pages\n\n- [WebGPU](https://en.wikipedia.org/wiki/WebGPU)"
  );
  const artifact = w.sent.find((m) => m.type === "artifact").data;
  assert.equal(artifact.filename, "local-research-paper.md");
  assert.match(artifact.content, /^---\ntitle: "Local Research Paper"\n/);
});

test("read_webpage: page request round-trip, greedy analyst pass, coverage and sources", async () => {
  const w = await startWorker({
    script: [
      PLAN,
      "<think></think><|tool_call_start|>[read_webpage(url='https://example.com/a', question='What is it?')]<|tool_call_end|>",
      "<think></think>It is an example page.",
    ],
    subagent: (messages, options) => {
      assert.match(messages[0].content, /^You are an isolated webpage evidence analyst/);
      assert.match(messages[1].content, /Background only — not additional tasks:\nOriginal user request: Summarize it\n/);
      assert.equal(options.do_sample, false);
      assert.equal(options.max_new_tokens, 4096);
      return "<think>ok</think>The page says it is an example [1].";
    },
    onPost: (message, reply) => {
      if (message.type === "webpage_request")
        reply({
          type: "webpage_response",
          id: message.id,
          page: { url: "https://example.com/a", title: "Example", text: "An example page with some text.", extractedChars: 31, truncated: false },
        });
    },
  });
  w.send({ type: "generate", prompt: "Summarize it", allowedTools: ["read_webpage"] });
  assert.equal((await w.finished).type, "complete");
  const [result] = toolResults(w.mainInputs, "read_webpage");
  assert.equal(result.mode, "isolated_webpage_research");
  assert.equal(result.synthesis, "Passage 1: The page says it is an example [1].");
  assert.equal(result.coverage.partial, false);
  assert.match(result.limitations, /^The entire extracted page fit/);
  assert.deepEqual(plain(Object.keys(result)), ["mode", "question", "synthesis", "sources", "coverage", "research_generations", "limitations"]);
});

test("only the first location-resolving get_current_context runs; repeats get the context controller", async () => {
  const w = await startWorker({
    script: [
      PLAN,
      "<think></think><|tool_call_start|>[get_current_context(include_location=true)]<|tool_call_end|>",
      "<think></think><|tool_call_start|>[get_current_context()]<|tool_call_end|>",
      python("print(1)"),
      ANSWER,
    ],
    onPost: (message, reply) => {
      if (message.type === "location_request") reply({ type: "location_response", id: message.id, error: "User denied Geolocation" });
      pythonReply(() => ok("1\n"))(message, reply);
    },
  });
  w.send({ type: "generate", prompt: "Where am I?", allowedTools: ["get_current_context", "run_python"] });
  assert.equal((await w.finished).type, "complete");
  assert.equal(w.sent.filter((m) => m.type === "location_request").length, 1);
  assert.match(w.mainInputs[3].messages.at(-1).content, /^CONTEXT CONTROLLER:/);
  assert.deepEqual(plain(toolResults(w.mainInputs, "get_current_context")[0].location), { error: "User denied Geolocation" });
});

test("parser: first block only, multiple calls, typed arguments, list coercion", async () => {
  const parsing = await loadGraph("src/agent/parsing.ts", {}, {});
  const names = ["run_python", "read_webpage", "create_action_plan", "update_action_plan", "ask_user", "search_wikipedia", "get_current_context"];
  const calls = parsing.parseToolCalls(
    "<|tool_call_start|>[update_action_plan(step_index=2, status='completed', note=\"it's done\\n\"), search_wikipedia(query='x (y)')]<|tool_call_end|> <|tool_call_start|>[run_python(code='1')]<|tool_call_end|>",
    names
  );
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { name: "update_action_plan", arguments: { step_index: 2, status: "completed", note: "it's done\n" } },
    { name: "search_wikipedia", arguments: { query: "x (y)" } },
  ]);
  assert.deepEqual(plain(parsing.parseArgumentValue("['a', \"b\"]")), ["a", "b"]);
  assert.deepEqual(plain(parsing.parseArgumentValue("[1, 2]")), [1, 2]);
  assert.deepEqual(plain(parsing.toStringArray("Step one; Step two")), ["Step one", "Step two"]);
  const turn = parsing.parseTurn("thinking only, no close", 3);
  assert.deepEqual([turn.thinking, turn.content, turn.id], ["thinking only, no close", "", "turn-3"]);
});

test("Exa page parsing: title and URL header lines, then the body", async () => {
  const exa = await loadGraph("src/exaReader.ts", {
    "@modelcontextprotocol/sdk/client/index.js": {},
    "@modelcontextprotocol/sdk/client/streamableHttp.js": {},
  }, {});
  const page = exa.parseExaPage(
    "# WebGPU\nURL: https://en.wikipedia.org/wiki/WebGPU\nPublished: 2026-11-09\n\nWebGPU\n\nWebGPU API is a JavaScript API, standardized by the W3C.",
    "https://en.wikipedia.org/wiki/WebGPU"
  );
  assert.equal(page.title, "WebGPU");
  assert.equal(page.url, "https://en.wikipedia.org/wiki/WebGPU");
  assert.equal(page.body, "WebGPU\n\nWebGPU API is a JavaScript API, standardized by the W3C.");
  const bare = exa.parseExaPage("Just some text without any header lines at all, long enough.", "https://x.example/");
  assert.deepEqual([bare.title, bare.url], ["", "https://x.example/"]);
  assert.match(bare.body, /^Just some text/);
});
