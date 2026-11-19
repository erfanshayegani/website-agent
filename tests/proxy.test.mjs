// Tests for the Cloudflare Worker read_webpage proxy (proxy/src/index.ts).
// Node strips the TypeScript types on import; network calls use a fake fetch.
import assert from "node:assert/strict";
import test from "node:test";

const worker = await import("../proxy/src/index.ts");
const handler = worker.default;
const ORIGIN = "https://erfanshayegani.github.io";

function dnsAnswer(type, data) {
  return new Response(JSON.stringify({ Answer: [{ type, data }] }), {
    headers: { "content-type": "application/dns-json" },
  });
}

/** Install a fake fetch: DoH answers from `dns`, pages from `pages`. */
function fakeNetwork({ dns = {}, pages = {} }) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name");
      const type = url.searchParams.get("type");
      const address = dns[name];
      if (!address) return new Response(JSON.stringify({}));
      const isV6 = address.includes(":");
      if ((type === "A" && !isV6) || (type === "AAAA" && isV6))
        return dnsAnswer(isV6 ? 28 : 1, address);
      return new Response(JSON.stringify({}));
    }
    const page = pages[url.href];
    if (!page) return new Response("not found", { status: 404 });
    return page();
  };
  return () => {
    globalThis.fetch = original;
  };
}

function post(body, origin = ORIGIN) {
  return new Request("https://proxy.example/", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

test("isPublicAddress matches the local server's ranges", () => {
  for (const address of ["10.0.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1", "100.64.0.1", "198.18.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "2001:db8::1"])
    assert.equal(worker.isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"])
    assert.equal(worker.isPublicAddress(address), true, address);
});

test("validateWebUrl rejects unsafe URLs with the original messages", () => {
  assert.throws(() => worker.validateWebUrl("ftp://example.com"), /public HTTP or HTTPS URL/);
  assert.throws(() => worker.validateWebUrl("https://user:pw@example.com"), /embedded credentials/);
  assert.throws(() => worker.validateWebUrl("https://example.com:8080/"), /standard web ports/);
  assert.throws(() => worker.validateWebUrl("http://localhost/"), /Local and private/);
  assert.throws(() => worker.validateWebUrl("http://192.168.0.1/"), /Local and private/);
  assert.equal(worker.validateWebUrl("https://example.com/a#frag").href, "https://example.com/a");
});

test("requests from other origins or without an origin are refused", async () => {
  assert.equal((await handler.fetch(post({ url: "https://example.com" }, "https://evil.example"), {})).status, 403);
  assert.equal((await handler.fetch(post({ url: "https://example.com" }, null), {})).status, 403);
});

test("CORS preflight is answered for the site and for localhost dev", async () => {
  for (const origin of [ORIGIN, "http://localhost:5173", "http://127.0.0.1:4173"]) {
    const response = await handler.fetch(new Request("https://proxy.example/", { method: "OPTIONS", headers: { origin } }), {});
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  }
});

test("fetches an HTML page and follows a validated redirect", async () => {
  const restore = fakeNetwork({
    dns: { "example.com": "93.184.216.34", "www.example.com": "93.184.216.34" },
    pages: {
      "https://example.com/": () => new Response(null, { status: 301, headers: { location: "https://www.example.com/" } }),
      "https://www.example.com/": () => new Response("<html><body>Hello</body></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    },
  });
  try {
    const response = await handler.fetch(post({ url: "https://example.com/" }), {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
    const data = await response.json();
    assert.equal(data.url, "https://www.example.com/");
    assert.match(data.body, /Hello/);
    assert.match(data.contentType, /text\/html/);
  } finally {
    restore();
  }
});

test("a redirect to a private address is refused", async () => {
  const restore = fakeNetwork({
    dns: { "example.com": "93.184.216.34" },
    pages: { "https://example.com/": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }) },
  });
  try {
    const data = await (await handler.fetch(post({ url: "https://example.com/" }), {})).json();
    assert.match(data.error, /Local and private/);
  } finally {
    restore();
  }
});

test("hostnames resolving to private addresses are refused", async () => {
  const restore = fakeNetwork({ dns: { "internal.example": "10.1.2.3" } });
  try {
    const data = await (await handler.fetch(post({ url: "https://internal.example/" }), {})).json();
    assert.match(data.error, /private or unsupported network address/);
  } finally {
    restore();
  }
});

test("non-HTML content and oversized pages are refused", async () => {
  const big = "x".repeat(2 * 1024 * 1024 + 1);
  const restore = fakeNetwork({
    dns: { "example.com": "93.184.216.34" },
    pages: {
      "https://example.com/file.pdf": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
      "https://example.com/big": () => new Response(big, { headers: { "content-type": "text/plain" } }),
    },
  });
  try {
    let data = await (await handler.fetch(post({ url: "https://example.com/file.pdf" }), {})).json();
    assert.match(data.error, /Only HTML and plain-text pages/);
    data = await (await handler.fetch(post({ url: "https://example.com/big" }), {})).json();
    assert.match(data.error, /2 MB download limit/);
  } finally {
    restore();
  }
});

test("the rate limiter blocks when it says so", async () => {
  const env = { RATE_LIMITER: { limit: async () => ({ success: false }) } };
  const response = await handler.fetch(post({ url: "https://example.com/" }), env);
  assert.equal(response.status, 429);
});
