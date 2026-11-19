// Page fetching for read_webpage on the public site, via Exa's hosted MCP
// server (web_fetch_exa). Browsers can't read arbitrary sites directly (CORS)
// and the public build has no page-reader server, so Exa does the download.
// Only the fetching changes: extraction limits and the analyst pass are the
// same as with the local /__webpage server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { WebpageDocument } from "./webpage";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const FETCH_TOOL = "web_fetch_exa";
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 30_000;

let clientPromise: Promise<Client> | null = null;

function connect(): Promise<Client> {
  clientPromise ??= (async () => {
    const client = new Client({ name: "website-agent-reader", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(EXA_MCP_URL), {
        // No server-to-client stream is needed for a single tool call.
        fetch: (input, init) =>
          String(init?.method ?? "GET").toUpperCase() === "GET"
            ? Promise.resolve(new Response(null, { status: 405 }))
            : fetch(input, init),
      }),
      { timeout: CONNECT_TIMEOUT_MS }
    );
    return client;
  })().catch((error) => {
    clientPromise = null;
    throw error;
  });
  return clientPromise;
}

export interface ExaPage {
  url: string;
  title: string;
  body: string;
}

/**
 * Exa returns Markdown like:
 *   # Title\nURL: https://…\nPublished: …\n\n<content>
 * Header lines are optional; everything after the header block is the body.
 */
export function parseExaPage(text: string, requestedUrl: string): ExaPage {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let title = "";
  let url = requestedUrl;
  let index = 0;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!title && /^#\s+/.test(line)) title = line.replace(/^#\s+/, "").trim();
    else if (/^URL:\s*/i.test(line)) url = line.replace(/^URL:\s*/i, "").trim() || url;
    else if (/^(Published|Author|Date):/i.test(line)) continue;
    else if (line.trim() === "") {
      if (title || url !== requestedUrl) {
        index++;
        break;
      }
    } else break;
  }
  return { url, title, body: lines.slice(index).join("\n").trim() };
}

export async function fetchPageViaExa(
  url: string,
  maxCharacters: number,
  signal: AbortSignal
): Promise<{ page: ExaPage; hitLimit: boolean }> {
  const client = await connect();
  signal.throwIfAborted();
  const response = await client.callTool(
    { name: FETCH_TOOL, arguments: { urls: [url], maxCharacters } },
    undefined,
    { signal, timeout: CALL_TIMEOUT_MS }
  );
  const text = ((response.content as { type: string; text?: string }[] | undefined) ?? [])
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text)
    .join("\n\n")
    .trim();
  if (response.isError || !text)
    throw new Error(text ? `Page reader error: ${text.slice(0, 300)}` : "Could not fetch webpage.");
  const page = parseExaPage(text, url);
  return { page, hitLimit: page.body.length >= maxCharacters };
}

/** Same document shape the local reader produces (title, 96k cap, truncation). */
export function toWebpageDocument(
  page: ExaPage,
  extract: (body: string, url: string, contentType: string) => WebpageDocument,
  hitLimit: boolean
): WebpageDocument {
  const document = extract(page.body, page.url, "text/plain");
  return {
    ...document,
    title: (page.title || document.title).slice(0, 300),
    truncated: document.truncated || hitLimit,
  };
}
