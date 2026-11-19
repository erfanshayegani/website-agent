import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Plugin } from "vite";

const MAX_BYTES = 2 * 1024 * 1024;
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
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
  if (isIP(address) === 6)
    return /^[23][0-9a-f]{0,3}:/i.test(address) && !/^200[12]:/i.test(address);
  return false;
}

export function validateWebUrl(input: string): URL {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Use a public HTTP or HTTPS URL without embedded credentials."
    );
  if (url.port && !["80", "443"].includes(url.port))
    throw new Error("Only standard web ports are supported.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    (isIP(host) && !isPublicAddress(host))
  )
    throw new Error("Local and private network addresses are not supported.");
  url.hash = "";
  return url;
}

export async function fetchPublicPage(
  input: string,
  signal = AbortSignal.timeout(20_000)
): Promise<{ url: string; body: string; contentType: string; bytes: number }> {
  let url = validateWebUrl(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new Error("Page fetch timed out or was cancelled.")),
          { once: true }
        )
      ),
    ]);
    if (
      !addresses.length ||
      addresses.some((item) => !isPublicAddress(item.address))
    )
      throw new Error(
        "The URL resolves to a private or unsupported network address."
      );
    let response: IncomingMessage | undefined;
    const failures: string[] = [];
    // A hostname may have several valid endpoints. Pin each attempt, rather
    // than permanently selecting the first DNS result or doing a second lookup.
    const uniqueAddresses = addresses.filter(
      (item, index) =>
        addresses.findIndex(
          (candidate) => candidate.address === item.address
        ) === index
    );
    for (const address of uniqueAddresses) {
      signal.throwIfAborted();
      const pinnedLookup: LookupFunction = (_host, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      };
      const attempt = new AbortController();
      const connectionTimeout = setTimeout(() => attempt.abort(), 4000);
      try {
        response = await new Promise<IncomingMessage>((resolve, reject) => {
          const request = (
            url.protocol === "https:" ? httpsRequest : httpRequest
          )(
            url,
            {
              method: "GET",
              lookup: pinnedLookup,
              agent: false,
              // Bound a stalled endpoint while retaining the overall request deadline.
              signal: AbortSignal.any([signal, attempt.signal]),
              headers: {
                "User-Agent": "LFM-Local-Reader/1.0",
                Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
                "Accept-Encoding": "identity",
              },
            },
            resolve
          );
          request.on("error", reject);
          request.end();
        });
        break;
      } catch (error) {
        signal.throwIfAborted();
        const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
        if (
          ![
            "ECONNREFUSED",
            "ECONNRESET",
            "EHOSTUNREACH",
            "ENETUNREACH",
            "ETIMEDOUT",
            "ABORT_ERR",
          ].includes(code)
        )
          throw error;
        failures.push(
          `${address.address}: ${code === "ABORT_ERR" ? "connection timed out" : code}`
        );
      } finally {
        clearTimeout(connectionTimeout);
      }
    }
    if (!response)
      throw new Error(
        `Could not connect to ${host} after trying ${uniqueAddresses.length} validated DNS address(es). ${failures.join("; ")}`
      );
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      const destination = response.headers.location;
      response.destroy();
      if (!destination)
        throw new Error("Redirect did not include a destination.");
      url = validateWebUrl(new URL(destination, url).href);
      continue;
    }
    if ((response.statusCode ?? 500) >= 400) {
      const status = response.statusCode;
      response.destroy();
      throw new Error(`Website returned HTTP ${status}.`);
    }
    const contentType = response.headers["content-type"] ?? "";
    if (
      !/^(text\/html|application\/xhtml\+xml|text\/plain)(;|$)/i.test(
        contentType
      )
    ) {
      response.destroy();
      throw new Error(
        "Only HTML and plain-text pages are supported; PDFs and other downloads are not supported."
      );
    }
    const encoding = response.headers["content-encoding"]?.toLowerCase();
    const decoder =
      encoding === "gzip"
        ? createGunzip()
        : encoding === "br"
          ? createBrotliDecompress()
          : encoding === "deflate"
            ? createInflate()
            : null;
    if (encoding && encoding !== "identity" && !decoder) {
      response.destroy();
      throw new Error("Website returned unsupported compressed content.");
    }
    let wireBytes = 0;
    response.on("data", (chunk) => {
      wireBytes += chunk.length;
      if (wireBytes > MAX_BYTES)
        response.destroy(new Error("Page exceeds the 2 MB download limit."));
    });
    if (decoder) response.on("error", (error) => decoder.destroy(error));
    const stream = decoder ? response.pipe(decoder) : response;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        response.destroy();
        decoder?.destroy();
        throw new Error("Page exceeds the 2 MB download limit.");
      }
      chunks.push(Buffer.from(chunk));
    }
    const charset =
      contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] ?? "utf-8";
    let body: string;
    try {
      body = new TextDecoder(charset).decode(Buffer.concat(chunks));
    } catch {
      body = Buffer.concat(chunks).toString("utf8");
    }
    return { url: url.href, body, contentType, bytes };
  }
  throw new Error("Too many webpage redirects.");
}

export function webpageServerPlugin(): Plugin {
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    try {
      if (
        request.method !== "POST" ||
        !request.headers["content-type"]?.startsWith("application/json")
      ) {
        response.statusCode = 405;
        response.end(JSON.stringify({ error: "Use a JSON POST request." }));
        return;
      }
      if (
        request.headers["sec-fetch-site"] === "cross-site" ||
        (request.headers.origin &&
          new URL(request.headers.origin).host !== request.headers.host)
      ) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: "Origin mismatch" }));
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 8192) throw new Error("URL request is too large.");
      }
      const { url } = JSON.parse(body) as { url: string };
      if (typeof url !== "string" || url.length > 4096)
        throw new Error("Provide a URL of at most 4096 characters.");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      response.on("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      try {
        response.end(
          JSON.stringify(await fetchPublicPage(url, controller.signal))
        );
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      response.statusCode = 422;
      response.end(
        JSON.stringify({
          error:
            error instanceof Error ? error.message : "Could not read webpage.",
        })
      );
    }
  };
  return {
    name: "local-webpage-reader",
    configureServer(server) {
      server.middlewares.use("/__webpage", (req, res) => {
        void serve(req, res);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__webpage", (req, res) => {
        void serve(req, res);
      });
    },
  };
}
