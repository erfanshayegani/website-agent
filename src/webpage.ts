export interface WebpageDocument {
  url: string;
  title: string;
  text: string;
  extractedChars: number;
  truncated: boolean;
}
export const MAX_PAGE_CHARS = 96_000;

// Template content is inert: never mount fetched markup or run its scripts.
export function extractWebpage(
  body: string,
  url: string,
  contentType: string
): WebpageDocument {
  let title = new URL(url).hostname;
  let text = body;
  if (!contentType.toLowerCase().startsWith("text/plain")) {
    const template = document.createElement("template");
    template.innerHTML = body;
    const root = template.content;
    title =
      root.querySelector("title")?.textContent?.trim() ||
      root.querySelector("h1")?.textContent?.trim() ||
      title;
    root
      .querySelectorAll(
        "script,style,noscript,template,nav,footer,aside,form,svg,iframe,canvas,video,audio,[hidden],[aria-hidden='true']"
      )
      .forEach((node) => node.remove());
    const article =
      root.querySelector("article") ??
      root.querySelector("main") ??
      root.querySelector("[role=main]") ??
      root;
    const blocks = new Set([
      "P",
      "DIV",
      "SECTION",
      "ARTICLE",
      "MAIN",
      "BR",
      "LI",
      "H1",
      "H2",
      "H3",
      "H4",
      "TR",
      "PRE",
      "BLOCKQUOTE",
    ]);
    const parts: string[] = [];
    function visit(node: Node) {
      if (node.nodeType === 3) {
        parts.push(node.textContent ?? "");
        return;
      }
      const element = node as Element;
      if (blocks.has(element.tagName)) parts.push("\n");
      for (const child of node.childNodes) visit(child);
      if (blocks.has(element.tagName)) parts.push("\n");
    }
    visit(article);
    text = parts.join("");
  }
  text = text
    .replace(/[\t \r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length < 40)
    throw new Error(
      "This page has too little readable text. It may require JavaScript, login, or browser interaction."
    );
  return {
    url,
    title: title.slice(0, 300),
    text: text.slice(0, MAX_PAGE_CHARS),
    extractedChars: text.length,
    truncated: text.length > MAX_PAGE_CHARS,
  };
}

export async function loadWebpage(
  url: string,
  signal: AbortSignal
): Promise<WebpageDocument> {
  // Production: the Cloudflare Worker in proxy/ (same contract as /__webpage).
  // Dev/preview: the local /__webpage middleware from webpageServer.ts.
  const endpoint = import.meta.env.VITE_WEBPAGE_PROXY_URL || "/__webpage";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    signal,
  });
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "Webpage reading is unavailable: the page-reader service did not respond."
    );
  const result = (await response.json()) as {
    url: string;
    body: string;
    contentType: string;
    error?: string;
  };
  if (!response.ok || result.error)
    throw new Error(result.error ?? "Could not fetch webpage.");
  return extractWebpage(result.body, result.url, result.contentType);
}

export const WEBPAGE_PASSAGE_TOKEN_LIMIT = 8000;
export interface WebpagePassage {
  index: 1;
  start: 0;
  end: number;
  text: string;
  tokenCount: number;
  totalTokens: number;
  truncated: boolean;
}

// One contiguous prefix, measured with the loaded model's tokenizer.
export function webpagePassage(
  text: string,
  countTokens: (text: string) => number
): WebpagePassage {
  const totalTokens = countTokens(text);
  let end = text.length;
  if (totalTokens > WEBPAGE_PASSAGE_TOKEN_LIMIT) {
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (countTokens(text.slice(0, middle)) <= WEBPAGE_PASSAGE_TOKEN_LIMIT)
        low = middle;
      else high = middle - 1;
    }
    end = low;
    // Avoid cutting a UTF-16 surrogate pair in half.
    if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  }
  // Recheck after the Unicode boundary adjustment; token counts can change at
  // a prefix boundary because the tokenizer may merge adjacent characters.
  while (
    end > 0 &&
    countTokens(text.slice(0, end)) > WEBPAGE_PASSAGE_TOKEN_LIMIT
  ) {
    end--;
    if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  }
  const passage = text.slice(0, end);
  return {
    index: 1,
    start: 0,
    end,
    text: passage,
    tokenCount: countTokens(passage),
    totalTokens,
    truncated: end < text.length,
  };
}

export function webpageExcerpt(
  text: string,
  question: string,
  limit = 900
): string {
  const terms = (
    question.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []
  ).filter(
    (term) =>
      ![
        "what",
        "this",
        "that",
        "page",
        "read",
        "does",
        "which",
        "please",
      ].includes(term)
  );
  const passages = text.split(/\n+/).filter((part) => part.trim());
  const best =
    passages
      .map((part) => ({
        part,
        score: terms.reduce(
          (sum, term) => sum + (part.toLowerCase().includes(term) ? 1 : 0),
          0
        ),
      }))
      .sort((a, b) => b.score - a.score)[0]?.part ?? text;
  const offset =
    terms
      .map((term) => best.toLowerCase().indexOf(term))
      .find((index) => index >= 0) ?? 0;
  const start = Math.max(0, offset - 100);
  return `${start > 0 ? "…" : ""}${best.slice(start, start + limit)}${best.length > start + limit ? "…" : ""}`;
}
