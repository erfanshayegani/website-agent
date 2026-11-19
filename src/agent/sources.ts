// Source tracking, the "Source pages" footer and the Markdown report (SPEC §10).
import type { BrowserArtifact } from "../types";

export interface ResearchSource {
  title: string;
  url: string;
  pageId?: number;
}

/** §10.1 — valid {title,url} entries from a tool result's `sources`. */
export function extractSources(result: Record<string, unknown>): ResearchSource[] {
  if (!Array.isArray(result.sources)) return [];
  const sources: ResearchSource[] = [];
  for (const entry of result.sources) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const title = String(item.title ?? "").trim();
    const url = String(item.url ?? "").trim();
    if (!title || !url) continue;
    sources.push(
      typeof item.pageId === "number" ? { title, url, pageId: item.pageId } : { title, url }
    );
  }
  return sources;
}

export function appendSourcePages(response: string, sources: ResearchSource[]): string {
  if (!sources.length) return response.trim();
  return (
    response.trim() +
    "\n\n## Source pages\n\n" +
    sources.map((source) => `- [${source.title}](${source.url})`).join("\n")
  );
}

/** §10.2 */
export function createResearchPaper(
  responseWithSources: string,
  sources: ResearchSource[]
): BrowserArtifact {
  const title = responseWithSources.match(/^#\s+(.+)$/m)?.[1]?.trim() || "Local Research Paper";
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "research-paper";
  const content = `---\ntitle: "${title.replace(/"/g, '\\"')}"\ndate: "${new Date().toISOString()}"\nsource_count: ${sources.length}\n---\n\n${responseWithSources.trim()}\n`;
  return {
    id: crypto.randomUUID(),
    title,
    filename: `${base}.md`,
    mimeType: "text/markdown",
    content,
  };
}
