import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function load(file, dependencies = {}, globals = {}) {
  const source = await readFile(new URL("../" + file, import.meta.url), "utf8");
  const exports = {};
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
        if (!(name in dependencies)) throw Error("Unexpected import " + name);
        return dependencies[name];
      },
      structuredClone,
      setTimeout,
      clearTimeout,
      URL,
      URLSearchParams,
      Buffer,
      TextDecoder,
      AbortSignal,
      AbortController,
      crypto,
      performance,
      console,
      ...globals,
    }
  );
  return exports;
}
const webpage = await load("src/webpage.ts");

test("read_webpage rejects missing or blank questions before fetching and forwards an explicit question", async () => {
  const parsing = await load("src/agent/parsing.ts");
  const { AGENT_TOOLS } = await load("src/agentConfig.ts", {
    "./agent/parsing": parsing,
  });
  const tool = AGENT_TOOLS.find((entry) => entry.name === "read_webpage");
  assert.ok(tool.schema.function.parameters.required.includes("question"));
  const calls = [];
  const context = {
    readWebpage: async (...args) => {
      calls.push(args);
      return { synthesis: "Page evidence" };
    },
  };
  for (const question of [undefined, "", "   ", null, 123]) {
    const result = await tool.execute(
      { url: "https://example.com/article", question },
      context
    );
    assert.match(result.error, /focused question is required/);
  }
  assert.equal(calls.length, 0);
  await tool.execute(
    {
      url: "https://example.com/article",
      question: "  What is the warranty?  ",
    },
    context
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "What is the warranty?");
});

test("webpage reader retains one prefix of at most 8000 tokens without a 6000-character chunk cap", () => {
  const count = (text) => Math.ceil(text.length / 4);
  const short = "Evidence ".repeat(2800);
  const full = webpage.webpagePassage(short, count);
  assert.equal(full.text, short);
  assert.ok(full.text.length > 6000);
  assert.equal(full.truncated, false);
  const text = "Background. ".repeat(4000) + "Late warranty evidence";
  const prefix = webpage.webpagePassage(text, count);
  assert.equal(prefix.tokenCount, 8000);
  assert.equal(prefix.text, text.slice(0, 32000));
  assert.equal(prefix.truncated, true);
  assert.equal(prefix.start, 0);
  assert.ok(!prefix.text.includes("Late warranty evidence"));
  assert.equal(
    webpage.webpagePassage("x".repeat(32000), count).truncated,
    false
  );
  assert.ok(
    webpage
      .webpageExcerpt(
        "Other text.\nBattery warranty: ten years.",
        "battery warranty"
      )
      .includes("ten years")
  );
});

test("plain-text extraction reports truncation and rejects empty pages", () => {
  const page = webpage.extractWebpage(
    "Evidence ".repeat(14000),
    "https://example.com/article",
    "text/plain"
  );
  assert.equal(page.text.length, 96000);
  assert.equal(page.truncated, true);
  assert.ok(page.extractedChars > 96000);
  assert.throws(
    () => webpage.extractWebpage("", "https://example.com", "text/plain"),
    /too little readable/
  );
});

test("HTML extraction uses an inert template and keeps article text with paragraph boundaries", async () => {
  function text(value) {
    return { nodeType: 3, textContent: value, childNodes: [] };
  }
  function node(tag, children = []) {
    return { nodeType: 1, tagName: tag, childNodes: children };
  }
  const article = node("ARTICLE", [
    node("H1", [text("Battery guide")]),
    node("P", [
      text(
        "The warranty covers batteries for ten years. This is enough readable text."
      ),
    ]),
    node("P", [text("Replacement is free under the terms.")]),
  ]);
  let created = "";
  let removed = false;
  const htmlModule = await load(
    "src/webpage.ts",
    {},
    {
      document: {
        createElement(tag) {
          created = tag;
          return {
            set innerHTML(value) {
              assert.ok(value.includes("<article>"));
            },
            content: {
              querySelector(selector) {
                return selector === "title"
                  ? { textContent: "Battery guide" }
                  : selector === "article"
                    ? article
                    : null;
              },
              querySelectorAll() {
                return [
                  {
                    remove() {
                      removed = true;
                    },
                  },
                ];
              },
            },
          };
        },
      },
    }
  );
  const result = htmlModule.extractWebpage(
    "<article>test</article>",
    "https://example.com",
    "text/html"
  );
  assert.equal(created, "template");
  assert.ok(removed);
  assert.equal(result.title, "Battery guide");
  assert.ok(result.text.includes("ten years."));
  assert.ok(result.text.includes("\n"));
});

async function serverWith(resolutions, responses) {
  let calls = 0;
  const attempted = [];
  function request(_url, options, callback) {
    calls++;
    assert.equal(options.headers["Accept-Encoding"], "identity");
    options.lookup("example.com", { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.ok(addresses.length);
      attempted.push(addresses[0].address);
    });
    const req = new EventEmitter();
    req.end = () =>
      queueMicrotask(() => {
        const item = responses.shift();
        if (item.error) {
          req.emit(
            "error",
            Object.assign(new Error(item.error), { code: item.error })
          );
          return;
        }
        const response = Readable.from([Buffer.from(item.body ?? "")]);
        Object.assign(response, {
          statusCode: item.status ?? 200,
          headers: item.headers ?? {
            "content-type": "text/html; charset=utf-8",
          },
        });
        callback(response);
      });
    return req;
  }
  const module = await load("webpageServer.ts", {
    "node:dns/promises": {
      lookup: async () =>
        resolutions.shift() ?? [{ address: "93.184.216.34", family: 4 }],
    },
    "node:http": { request },
    "node:https": { request },
    "node:net": await import("node:net"),
    "node:zlib": await import("node:zlib"),
  });
  return { ...module, calls: () => calls, attempted };
}

test("reader retries other pinned DNS addresses when the first endpoint refuses a connection", async () => {
  const server = await serverWith(
    [
      [
        { address: "185.199.110.153", family: 4 },
        { address: "185.199.111.153", family: 4 },
      ],
    ],
    [
      { error: "ECONNREFUSED" },
      { body: "<article>GitHub Pages evidence</article>" },
    ]
  );
  const page = await server.fetchPublicPage(
    "https://erfanshayegani.github.io/"
  );
  assert.ok(page.body.includes("GitHub Pages evidence"));
  assert.deepEqual(server.attempted, ["185.199.110.153", "185.199.111.153"]);
  assert.equal(page.url, "https://erfanshayegani.github.io/");
});

test("reader reports all failed endpoints and keeps TLS errors and cancellation authoritative", async () => {
  const addresses = [
    { address: "185.199.110.153", family: 4 },
    { address: "185.199.111.153", family: 4 },
  ];
  const failed = await serverWith(
    [addresses],
    [{ error: "ECONNREFUSED" }, { error: "ENETUNREACH" }]
  );
  await assert.rejects(
    failed.fetchPublicPage("https://example.com"),
    /trying 2 validated DNS address.*ECONNREFUSED.*ENETUNREACH/
  );
  const tls = await serverWith([addresses], [{ error: "CERT_HAS_EXPIRED" }]);
  await assert.rejects(
    tls.fetchPublicPage("https://example.com"),
    /CERT_HAS_EXPIRED/
  );
  assert.equal(tls.calls(), 1);
  const cancelled = await serverWith([], []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    cancelled.fetchPublicPage("https://example.com", controller.signal),
    /abort/i
  );
  assert.equal(cancelled.calls(), 0);
});

test("public fetch pins DNS, follows redirects, and returns page bytes", async () => {
  const server = await serverWith(
    [],
    [
      { status: 302, headers: { location: "/article" } },
      { body: "<article>Public evidence</article>" },
    ]
  );
  const result = await server.fetchPublicPage("https://example.com");
  assert.equal(result.url, "https://example.com/article");
  assert.ok(result.body.includes("Public evidence"));
  assert.equal(server.calls(), 2);
});

test("reader handles compressed HTML while limiting decompressed size", async () => {
  const { gzipSync } = await import("node:zlib");
  const server = await serverWith(
    [],
    [
      {
        body: gzipSync("<article>Compressed evidence</article>"),
        headers: { "content-type": "text/html", "content-encoding": "gzip" },
      },
    ]
  );
  assert.ok(
    (await server.fetchPublicPage("https://example.com")).body.includes(
      "Compressed evidence"
    )
  );
  const large = await serverWith(
    [],
    [
      {
        body: gzipSync("x".repeat(2 * 1024 * 1024 + 1)),
        headers: { "content-type": "text/html", "content-encoding": "gzip" },
      },
    ]
  );
  await assert.rejects(large.fetchPublicPage("https://example.com"), /2 MB/);
});

test("reader blocks local addresses, unsafe redirects, private DNS, and unsupported downloads", async () => {
  const server = await serverWith([[{ address: "127.0.0.1", family: 4 }]], []);
  for (const url of [
    "file:///etc/passwd",
    "http://localhost",
    "http://127.0.0.1",
    "http://[::1]",
    "https://example.com:8080",
    "https://user:pass@example.com",
  ])
    assert.throws(() => server.validateWebUrl(url));
  await assert.rejects(
    server.fetchPublicPage("https://example.com"),
    /private/
  );
  assert.equal(server.calls(), 0);
  const redirect = await serverWith(
    [],
    [{ status: 302, headers: { location: "http://169.254.169.254/latest" } }]
  );
  await assert.rejects(
    redirect.fetchPublicPage("https://example.com"),
    /private/
  );
  assert.equal(redirect.calls(), 1);
  const pdf = await serverWith(
    [],
    [{ headers: { "content-type": "application/pdf" } }]
  );
  await assert.rejects(pdf.fetchPublicPage("https://example.com"), /PDF/);
  const large = await serverWith(
    [],
    [{ body: "x".repeat(2 * 1024 * 1024 + 1) }]
  );
  await assert.rejects(large.fetchPublicPage("https://example.com"), /2 MB/);
});

// Agent-loop tests for the new worker live in tests/agent.test.mjs.
