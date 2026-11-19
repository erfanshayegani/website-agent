import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function load(file, deps = {}, globals = {}) {
  const exports = {};
  const source = await readFile(new URL("../" + file, import.meta.url), "utf8");
  vm.runInNewContext(
    ts.transpileModule(source.replace(/import\.meta\.env/g, "({})"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    {
      exports,
      require: (name) => {
        if (!(name in deps)) throw Error("Unexpected import " + name);
        return deps[name];
      },
      URL,
      URLSearchParams,
      crypto,
      performance,
      structuredClone,
      setTimeout,
      clearTimeout,
      console,
      ...globals,
    }
  );
  return exports;
}
const python = await load("src/pythonRunner.ts");
function execute(code) {
  const bootstrap =
    'import ast, json, sys\np = json.load(sys.stdin)\nscope = {"__agent_source": p["code"]}\ntree = ast.parse(p["wrapper"])\nlast = tree.body.pop()\nexec(compile(tree, "<wrapper>", "exec"), scope)\nprint(eval(compile(ast.Expression(last.value), "<wrapper>", "eval"), scope))';
  return JSON.parse(
    execFileSync("python3", ["-c", bootstrap], {
      input: JSON.stringify({ wrapper: python.PYTHON_EXECUTION_WRAPPER, code }),
      encoding: "utf8",
      timeout: 5000,
    })
  );
}

test("actual Python wrapper computes sorting, statistics, arithmetic and distances", () => {
  const result = execute(
    'import math, statistics, json\nvalues = [42, 7, 19, 7, 100, -3]\nprint(json.dumps({"sorted": sorted(values), "mean": statistics.mean(values), "median": statistics.median(values)}))\nmath.dist((1, 2), (4, 6))'
  );
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.stdout), {
    sorted: [-3, 7, 7, 19, 42, 100],
    mean: 172 / 6,
    median: 13,
  });
  assert.equal(result.result, "5.0");
  assert.equal(result.error, null);
  const decimal = execute(
    'from decimal import Decimal\nDecimal("0.1") + Decimal("0.2")'
  );
  assert.equal(decimal.result, "Decimal('0.3')");
});

test("actual Python wrapper returns exceptions, syntax errors, bounded output, and fresh variables", () => {
  const failed = execute('print("before")\n1/0');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /ZeroDivisionError/);
  assert.equal(failed.stdout, "before\n");
  assert.match(execute("if :").error, /SyntaxError/);
  const large = execute('print("x" * 9000)');
  assert.equal(large.ok, false);
  assert.equal(large.stdout.length, 8000);
  assert.equal(large.output_truncated, true);
  const expression = execute('"x" * 5000');
  assert.equal(expression.result.length, 2000);
  assert.equal(expression.output_truncated, true);
  execute("secret_value = 42");
  assert.match(execute("secret_value").error, /NameError/);
});

async function browserHarness() {
  const frames = [];
  const timers = new Map();
  let next = 0;
  let listener;
  const win = {
    addEventListener(type, callback) {
      if (type === "message") listener = callback;
    },
    removeEventListener(type, callback) {
      if (type === "message" && listener === callback) listener = null;
    },
  };
  const document = {
    createElement(tag) {
      assert.equal(tag, "iframe");
      const frame = {
        attributes: {},
        removed: false,
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        contentWindow: {
          postMessage(message) {
            frame.request = message;
          },
        },
        remove() {
          this.removed = true;
        },
      };
      frames.push(frame);
      return frame;
    },
    body: {
      appendChild(frame) {
        frame.onload();
      },
    },
  };
  const module = await load(
    "src/pythonRunner.ts",
    {},
    {
      window: win,
      document,
      setTimeout(callback, delay) {
        const id = ++next;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    }
  );
  return {
    module,
    frames,
    timers,
    send(data, source = frames.at(-1).contentWindow) {
      listener?.({ source, data: { id: frames.at(-1).request.id, ...data } });
    },
  };
}

test("Python controller uses an opaque sandbox, returns results, and removes runtime", async () => {
  const h = await browserHarness();
  const promise = h.module.runPython("print(5)", new AbortController().signal);
  const frame = h.frames[0];
  assert.equal(frame.attributes.sandbox, "allow-scripts");
  assert.ok(!frame.attributes.sandbox.includes("allow-same-origin"));
  assert.match(frame.srcdoc, /default-src 'none'/);
  assert.match(frame.srcdoc, /await import\(url\)/);
  assert.match(
    frame.srcdoc,
    /connect-src https:\/\/cdn.jsdelivr.net\/pyodide\/v314.0.7\/full\//
  );
  assert.equal(frame.request.code, "print(5)");
  h.send({ type: "python-ready" });
  assert.equal([...h.timers.values()][0].delay, 5000);
  h.send({
    type: "python-finished",
    result: {
      ok: true,
      stdout: "5\n",
      stderr: "",
      result: null,
      error: null,
      elapsed_ms: 1,
    },
  });
  assert.equal((await promise).stdout, "5\n");
  assert.equal(frame.removed, true);
  assert.equal(h.timers.size, 0);
});

test("sandbox uses a classic worker bootstrap and reports CDN HTTP failures inside its handler", async () => {
  const listeners = new Map();
  const parent = { postMessage() {} };
  let sourceBlob, options;
  class Worker {
    constructor(_url, configuration) {
      options = configuration;
    }
  }
  const html = python.pythonSandboxHtml();
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    window: {
      parent,
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
    },
    Blob,
    URL: {
      createObjectURL(blob) {
        sourceBlob = blob;
        return "blob:opaque";
      },
      revokeObjectURL() {},
    },
    Worker,
  });
  listeners.get("message")({
    source: parent,
    data: { type: "python-start", id: "probe", code: "print(5)" },
  });
  assert.equal(options.type, "classic");
  const source = await sourceBlob.text();
  assert.equal(
    ts.createSourceFile(
      "python-worker.js",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    ).parseDiagnostics.length,
    0
  );
  const messages = [];
  await vm.runInNewContext(source, {
    fetch: async () => ({ ok: false, status: 404, statusText: "Not Found" }),
    self: {
      postMessage(message) {
        messages.push(message);
      },
    },
  });
  assert.match(messages[0].error, /download.*HTTP 404.*pyodide.mjs/);
});

test("Python controller times out infinite execution, startup failure, and responds to cancellation", async () => {
  for (const phase of ["load", "execute", "cancel"]) {
    const h = await browserHarness();
    const controller = new AbortController();
    const promise = h.module.runPython("while True: pass", controller.signal);
    if (phase === "execute") h.send({ type: "python-ready" });
    if (phase === "cancel") controller.abort();
    else [...h.timers.values()][0].callback();
    const result = await promise;
    assert.equal(result.ok, false);
    assert.equal(h.frames[0].removed, true);
    assert.equal(h.timers.size, 0);
    if (phase === "cancel") assert.equal(result.cancelled, true);
    else assert.equal(result.timed_out, true);
  }
  const h = await browserHarness();
  const result = await h.module.runPython("", new AbortController().signal);
  assert.equal(result.ok, false);
  assert.equal(h.frames.length, 0);
});

// Agent-loop tests for the new worker live in tests/agent.test.mjs.
