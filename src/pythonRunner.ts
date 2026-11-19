export interface PythonResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  result: string | null;
  error: string | null;
  elapsed_ms: number;
  output_truncated?: boolean;
  timed_out?: boolean;
  cancelled?: boolean;
}

export const PYODIDE_INDEX_URL =
  "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
export const PYTHON_MAX_CODE_CHARS = 20_000;

// Standard Python so the same execution semantics can be tested with CPython.
export const PYTHON_EXECUTION_WRAPPER = `
import ast as _ast
import contextlib as _contextlib
import io as _io
import json as _json
import traceback as _traceback

class _AgentOutputLimit(Exception):
    pass

class _AgentOutput(_io.TextIOBase):
    def __init__(self, limit):
        self.limit = limit
        self.parts = []
        self.count = 0
        self.truncated = False
    def write(self, value):
        value = str(value)
        available = max(0, self.limit - self.count)
        self.parts.append(value[:available])
        self.count += min(len(value), available)
        if len(value) > available:
            self.truncated = True
            raise _AgentOutputLimit("Output limit reached; print a smaller result.")
        return len(value)
    def flush(self):
        pass
    def value(self):
        return "".join(self.parts)

def _agent_execute(source):
    stdout = _AgentOutput(8000)
    stderr = _AgentOutput(2000)
    result = None
    error = None
    shortened = False
    namespace = {"__name__": "__main__"}
    try:
        tree = _ast.parse(source, filename="<agent>", mode="exec")
        last = tree.body.pop() if tree.body and isinstance(tree.body[-1], _ast.Expr) else None
        with _contextlib.redirect_stdout(stdout), _contextlib.redirect_stderr(stderr):
            exec(compile(tree, "<agent>", "exec"), namespace)
            if last is not None:
                value = eval(compile(_ast.Expression(last.value), "<agent>", "eval"), namespace)
                if value is not None:
                    result = repr(value)
                    shortened = len(result) > 2000
                    result = result[:2000]
    except BaseException:
        error = _traceback.format_exc(limit=4)[-3000:]
    return _json.dumps({"ok": error is None, "stdout": stdout.value(), "stderr": stderr.value(), "result": result, "error": error, "output_truncated": stdout.truncated or stderr.truncated or shortened})

_agent_execute(__agent_source)
`;

// Embedded in a Worker. No app globals, model, or DOM are shared.
async function pythonWorker(
  indexURL: string,
  wrapper: string,
  loadPyodide: (options: {
    indexURL: string;
    jsglobals: object;
    stdin: () => undefined;
    stdout: () => undefined;
    stderr: () => undefined;
  }) => Promise<{
    globals: { set: (key: string, value: string) => void };
    runPython: (source: string) => string;
  }>
) {
  const send = (data: unknown) => self.postMessage(data);
  try {
    const runtime = await loadPyodide({
      indexURL,
      jsglobals: Object.create(null),
      stdin: () => undefined,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    self.addEventListener(
      "message",
      (event) => {
        const started = performance.now();
        try {
          runtime.globals.set("__agent_source", event.data.code);
          const result = JSON.parse(runtime.runPython(wrapper));
          send({
            type: "result",
            result: { ...result, elapsed_ms: performance.now() - started },
          });
        } catch (error) {
          send({ type: "error", error: String(error) });
        }
      },
      { once: true }
    );
    send({ type: "ready" });
  } catch (error) {
    send({
      type: "error",
      error: `Could not load Python from the Pyodide CDN: ${String(error)}`,
    });
  }
}

// Runs inside an opaque-origin iframe. The iframe owns and terminates the worker.
function pythonSandbox(workerSource: string) {
  let worker: Worker | null = null;
  window.addEventListener(
    "message",
    (event) => {
      if (
        event.source !== window.parent ||
        event.data?.type !== "python-start" ||
        worker
      )
        return;
      const { id, code } = event.data;
      window.addEventListener("securitypolicyviolation", (violation) => {
        window.parent.postMessage(
          {
            type: "python-finished",
            id,
            error: `Python sandbox policy blocked ${violation.blockedURI || "a resource"} (${violation.effectiveDirective}).`,
          },
          "*"
        );
        worker?.terminate();
      });
      const sourceURL = URL.createObjectURL(
        new Blob([workerSource], { type: "text/javascript" })
      );
      try {
        // Chromium can reject module blob workers created by opaque-origin
        // frames before any code executes. Bootstrap a classic worker and use
        // dynamic import for the Pyodide ES modules (not importScripts).
        worker = new Worker(sourceURL, { type: "classic" });
        worker.onmessage = (message) => {
          const data = message.data;
          if (data.type === "ready") {
            URL.revokeObjectURL(sourceURL);
            window.parent.postMessage({ type: "python-ready", id }, "*");
            worker!.postMessage({ code });
          } else if (data.type === "result" || data.type === "error") {
            window.parent.postMessage(
              {
                type: "python-finished",
                id,
                result: data.result,
                error: data.error,
              },
              "*"
            );
            worker!.terminate();
          }
        };
        worker.onerror = (error) => {
          URL.revokeObjectURL(sourceURL);
          window.parent.postMessage(
            {
              type: "python-finished",
              id,
              error:
                error.message ||
                `Python worker could not start. Check browser worker support and access to the runtime CDN.${error.filename ? ` Source: ${error.filename}:${error.lineno}:${error.colno}` : ""}`,
            },
            "*"
          );
          worker?.terminate();
        };
      } catch (error) {
        URL.revokeObjectURL(sourceURL);
        window.parent.postMessage(
          { type: "python-finished", id, error: String(error) },
          "*"
        );
      }
    },
    { once: true }
  );
}

export function pythonSandboxHtml(): string {
  // A static import fails before the worker's error handler can run. Probe and
  // import inside a try/catch; keep it in a string to avoid Vite preload helpers.
  const source = `(async () => { const url = ${JSON.stringify(`${PYODIDE_INDEX_URL}pyodide.mjs`)}; let stage = "download"; try { const response = await fetch(url, { credentials: "omit" }); if (!response.ok) throw new Error("HTTP " + response.status + " " + response.statusText); stage = "module import"; const { loadPyodide } = await import(url); await (${pythonWorker.toString()})(${JSON.stringify(PYODIDE_INDEX_URL)}, ${JSON.stringify(PYTHON_EXECUTION_WRAPPER)}, loadPyodide); } catch (error) { self.postMessage({ type: "error", error: "Python startup failed during " + stage + ": " + String(error) + ". Runtime: " + url }); } })();`;
  const data = JSON.stringify(source).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' ${PYODIDE_INDEX_URL}; connect-src ${PYODIDE_INDEX_URL}; worker-src blob:; child-src blob:; base-uri 'none'; form-action 'none'"></head><body><script type="module">(${pythonSandbox.toString()})(${data});</script></body></html>`;
}

export function runPython(
  code: string,
  signal: AbortSignal,
  timeoutMs = 5000
): Promise<PythonResult> {
  const failure = (
    error: string,
    extra: Partial<PythonResult> = {}
  ): PythonResult => ({
    ok: false,
    stdout: "",
    stderr: "",
    result: null,
    error,
    elapsed_ms: 0,
    ...extra,
  });
  if (!code.trim() || code.length > PYTHON_MAX_CODE_CHARS)
    return Promise.resolve(
      failure(`Provide 1–${PYTHON_MAX_CODE_CHARS} characters of Python code.`)
    );
  if (signal.aborted)
    return Promise.resolve(
      failure("Python execution cancelled.", { cancelled: true })
    );
  const limit = Number.isFinite(timeoutMs)
    ? Math.max(100, Math.min(10_000, timeoutMs))
    : 5000;
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.title = "Isolated Python runner";
    const id = crypto.randomUUID();
    let settled = false;
    let ready = false;
    let timer: ReturnType<typeof setTimeout>;
    function finish(result: PythonResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      signal.removeEventListener("abort", cancel);
      // Removing the iframe destroys its worker, including infinite Python loops.
      frame.remove();
      resolve(result);
    }
    function cancel() {
      finish(failure("Python execution cancelled.", { cancelled: true }));
    }
    function receive(event: MessageEvent) {
      if (event.source !== frame.contentWindow || event.data?.id !== id) return;
      if (event.data.type === "python-ready" && !ready) {
        ready = true;
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            finish(
              failure(`Python exceeded its ${limit} ms execution limit.`, {
                timed_out: true,
                elapsed_ms: limit,
              })
            ),
          limit
        );
      } else if (event.data.type === "python-finished") {
        const result = event.data.result as PythonResult | undefined;
        finish(
          result && typeof result.ok === "boolean"
            ? result
            : failure(event.data.error || "Python worker failed.")
        );
      }
    }
    window.addEventListener("message", receive);
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(
      () =>
        finish(
          failure(
            "Python runtime did not load within 60 seconds. Check access to cdn.jsdelivr.net.",
            { timed_out: true }
          )
        ),
      60_000
    );
    frame.onload = () =>
      frame.contentWindow?.postMessage({ type: "python-start", id, code }, "*");
    frame.srcdoc = pythonSandboxHtml();
    document.body.appendChild(frame);
  });
}
