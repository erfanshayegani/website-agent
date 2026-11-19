import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const calls = [];
let hanging = false;
let failCall = false;
let observedAbort = false;
const fetch = async (_input, init = {}) => {
  if (init.method === "DELETE") return new Response(null, { status: 200 });
  const request = JSON.parse(init.body);
  calls.push(request);
  if (request.method === "notifications/initialized")
    return new Response(null, { status: 202 });
  if (request.method === "tools/call" && hanging)
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => {
          observedAbort = true;
          reject(init.signal.reason);
        },
        { once: true }
      );
    });
  if (request.method === "tools/call" && failCall)
    throw new Error("Network unavailable");
  const result =
    request.method === "initialize"
      ? {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1" },
        }
      : request.method === "tools/list"
        ? request.params?.cursor
          ? {
              tools: [
                {
                  name: "fetch_page",
                  description: "Read URL",
                  inputSchema: {
                    type: "object",
                    properties: { url: { type: "string" } },
                  },
                },
              ],
            }
          : {
              tools: [
                {
                  name: "web_search_exa",
                  description: "Search",
                  inputSchema: {
                    type: "object",
                    properties: { query: { type: "string" } },
                    required: ["query"],
                  },
                },
                { name: "run_python", inputSchema: { type: "object" } },
                { name: "invalid-name", inputSchema: { type: "object" } },
              ],
              nextCursor: "next",
            }
        : { content: [{ type: "text", text: "Search evidence" }] };
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
    { headers: { "content-type": "application/json" } }
  );
};
const source = await readFile(
  new URL("../src/mcpClient.ts", import.meta.url),
  "utf8"
);
const exports = {};
vm.runInNewContext(
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
  {
    exports,
    require: (name) =>
      name === "./agentConfig"
        ? { AGENT_TOOLS: [{ name: "run_python" }] }
        : require(name),
    URL,
    Response,
    fetch,
    structuredClone,
    AbortSignal,
    AbortController,
  }
);
const {
  McpConnection,
  compactMcpResult,
  validateMcpUrl,
  MCP_RESULT_CHAR_LIMIT,
} = exports;

test("real MCP SDK negotiates HTTP, discovers paginated tools, and calls by advertised schema", async () => {
  const client = new McpConnection();
  try {
    const config = await client.connect("https://mcp.exa.ai/mcp");
    assert.deepEqual(
      Array.from(config.tools, (tool) => tool.name),
      ["web_search_exa", "fetch_page"]
    );
    assert.equal(
      calls.filter((call) => call.method === "tools/list").length,
      2
    );
    const result = await client.call(
      config.url,
      "web_search_exa",
      { query: "agent safety" },
      new AbortController().signal
    );
    assert.equal(result.data.content[0].text, "Search evidence");
    assert.deepEqual(
      calls.filter((call) => call.method === "tools/call").at(-1).params,
      { name: "web_search_exa", arguments: { query: "agent safety" } }
    );
    await assert.rejects(
      client.call(
        "https://other.example/mcp",
        "web_search_exa",
        {},
        new AbortController().signal
      ),
      /Connect to this session/
    );
    await assert.rejects(
      client.call(config.url, "unknown", {}, new AbortController().signal),
      /not advertised/
    );
    failCall = true;
    await assert.rejects(
      client.call(
        config.url,
        "web_search_exa",
        {},
        new AbortController().signal
      ),
      /Network unavailable/
    );
    failCall = false;
    hanging = true;
    const controller = new AbortController();
    const pending = client.call(
      config.url,
      "web_search_exa",
      {},
      controller.signal
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending);
    assert.equal(observedAbort, true);
  } finally {
    hanging = false;
    failCall = false;
    await client.disconnect();
  }
  await assert.rejects(
    client.call(
      "https://mcp.exa.ai/mcp",
      "web_search_exa",
      {},
      new AbortController().signal
    ),
    /Connect to this session/
  );
});

test("MCP result compaction retains errors and marks bounded evidence explicitly", () => {
  const result = compactMcpResult({
    isError: true,
    content: [{ type: "text", text: "x".repeat(20000) }],
  });
  assert.equal(result.isError, true);
  assert.equal(result.truncated, true);
  assert.equal(result.text.length, MCP_RESULT_CHAR_LIMIT);
  assert.ok(result.original_characters > MCP_RESULT_CHAR_LIMIT);
  const structured = compactMcpResult({ structuredContent: { answer: 42 } });
  assert.equal(structured.data.answer, 42);
});

test("MCP URL validation supports HTTPS and local HTTP only", () => {
  assert.equal(validateMcpUrl("http://localhost:8000/mcp").protocol, "http:");
  for (const url of [
    "file:///tmp/tool",
    "http://example.com/mcp",
    "https://user:password@example.com/mcp",
  ])
    assert.throws(() => validateMcpUrl(url));
});
