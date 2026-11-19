/**
 * read_webpage proxy — Cloudflare Worker port of ../../webpageServer.ts.
 *
 * Same contract as the local /__webpage middleware:
 *   POST {"url": "..."}  (application/json)
 *   200 → {url, body, contentType, bytes}
 *   4xx → {error}
 *
 * Same rules: public http(s) only, no credentials, ports 80/443 only, no
 * localhost/private addresses (checked on the literal host and on its DNS
 * answers), up to 5 redirects each re-validated, HTML/XHTML/plain text only,
 * 2 MB cap, 20 s deadline.
 *
 * Extra, because it is public: only answers browsers on ALLOWED_ORIGINS, and
 * applies a per-IP rate limit when the RATE_LIMITER binding is configured.
 */

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  /** Comma-separated list of allowed origins. */
  ALLOWED_ORIGINS?: string;
  RATE_LIMITER?: RateLimiter;
}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20_000;
const DEFAULT_ORIGINS = "https://erfanshayegani.github.io";

class UserError extends Error {}

// ---------------------------------------------------------------- addresses

function ipv4Parts(address: string): number[] | null {
  const match = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

function isIPv6(address: string): boolean {
  return address.includes(":") && /^[0-9a-f:.]+$/i.test(address);
}

/** Same ranges as isPublicAddress() in webpageServer.ts. */
export function isPublicAddress(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b] = v4;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  // Permit global unicast IPv6 only; excludes loopback, mapped IPv4, link/local ranges.
  if (isIPv6(address))
    return /^[23][0-9a-f]{0,3}:/i.test(address) && !/^200[12]:/i.test(address);
  return false;
}

function isIpLiteral(host: string): boolean {
  return ipv4Parts(host) !== null || isIPv6(host);
}

/** Same checks and messages as validateWebUrl() in webpageServer.ts. */
export function validateWebUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UserError("Invalid URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new UserError(
      "Use a public HTTP or HTTPS URL without embedded credentials."
    );
  if (url.port && !["80", "443"].includes(url.port))
    throw new UserError("Only standard web ports are supported.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    (isIpLiteral(host) && !isPublicAddress(host))
  )
    throw new UserError("Local and private network addresses are not supported.");
  url.hash = "";
  return url;
}

/** Resolve A + AAAA through DNS-over-HTTPS (Workers have no DNS API). */
async function resolveHost(host: string, signal: AbortSignal): Promise<string[]> {
  if (isIpLiteral(host)) return [host];
  const answers: string[] = [];
  for (const type of ["A", "AAAA"]) {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      { headers: { Accept: "application/dns-json" }, signal }
    );
    if (!response.ok) continue;
    const data = (await response.json()) as {
      Answer?: { type: number; data: string }[];
    };
    for (const record of data.Answer ?? [])
      if (record.type === 1 || record.type === 28) answers.push(record.data);
  }
  return answers;
}

// ---------------------------------------------------------------- fetching

export async function fetchPublicPage(
  input: string,
  signal: AbortSignal
): Promise<{ url: string; body: string; contentType: string; bytes: number }> {
  let url = validateWebUrl(input);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    signal.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await resolveHost(host, signal);
    if (!addresses.length || addresses.some((address) => !isPublicAddress(address)))
      throw new UserError(
        "The URL resolves to a private or unsupported network address."
      );

    const response = await fetch(url.href, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": "LFM-Agent-Reader/1.0",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const destination = response.headers.get("location");
      await response.body?.cancel();
      if (!destination)
        throw new UserError("Redirect did not include a destination.");
      url = validateWebUrl(new URL(destination, url).href);
      continue;
    }
    if (response.status >= 400) {
      await response.body?.cancel();
      throw new UserError(`Website returned HTTP ${response.status}.`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^(text\/html|application\/xhtml\+xml|text\/plain)(;|$)/i.test(contentType)) {
      await response.body?.cancel();
      throw new UserError(
        "Only HTML and plain-text pages are supported; PDFs and other downloads are not supported."
      );
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) {
      await response.body?.cancel();
      throw new UserError("Page exceeds the 2 MB download limit.");
    }

    // Workers decompress transparently; count decoded bytes like the original.
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          throw new UserError("Page exceeds the 2 MB download limit.");
        }
        chunks.push(value);
      }
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const charset =
      contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] ?? "utf-8";
    let body: string;
    try {
      body = new TextDecoder(charset).decode(buffer);
    } catch {
      body = new TextDecoder("utf-8").decode(buffer);
    }
    return { url: url.href, body, contentType, bytes };
  }
  throw new UserError("Too many webpage redirects.");
}

// ---------------------------------------------------------------- handler

function isAllowedOrigin(origin: string, env: Env): boolean {
  const allowed = (env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (allowed.includes(origin)) return true;
  // Local development (vite dev / preview).
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function json(data: unknown, status: number, origin?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin") ?? "";
    if (!origin || !isAllowedOrigin(origin, env))
      return json({ error: "Origin not allowed" }, 403);

    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        },
      });

    if (
      request.method !== "POST" ||
      !request.headers.get("content-type")?.startsWith("application/json")
    )
      return json({ error: "Use a JSON POST request." }, 405, origin);

    if (env.RATE_LIMITER) {
      const key = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key });
      if (!success)
        return json(
          { error: "Too many webpage requests. Please wait a minute and try again." },
          429,
          origin
        );
    }

    try {
      const text = await request.text();
      if (text.length > 8192) throw new UserError("URL request is too large.");
      let parsed: { url?: unknown };
      try {
        parsed = JSON.parse(text) as { url?: unknown };
      } catch {
        throw new UserError("Use a JSON POST request.");
      }
      const { url } = parsed;
      if (typeof url !== "string" || url.length > 4096)
        throw new UserError("Provide a URL of at most 4096 characters.");
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      return json(await fetchPublicPage(url, signal), 200, origin);
    } catch (error) {
      const message =
        error instanceof UserError
          ? error.message
          : error instanceof Error && error.name === "TimeoutError"
            ? "Page fetch timed out or was cancelled."
            : error instanceof Error
              ? error.message
              : "Could not read webpage.";
      return json({ error: message }, 422, origin);
    }
  },
};
