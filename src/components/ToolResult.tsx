// Tool-specific result views. Everything falls back to raw JSON.
import type { ReactNode } from "react";
import Markdown from "./Markdown";

type Json = Record<string, unknown>;

const str = (value: unknown) => (typeof value === "string" ? value : "");

function Sources({ sources }: { sources: unknown }) {
  if (!Array.isArray(sources) || !sources.length) return null;
  return (
    <ul className="result__sources">
      {sources.map((source: Json, index) => (
        <li key={index}>
          {str(source.citation) && <span className="muted">{str(source.citation)} </span>}
          <a href={str(source.url)} target="_blank" rel="noreferrer noopener">
            {str(source.title) || str(source.url)}
          </a>
        </li>
      ))}
    </ul>
  );
}

function Pre({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="result__block">
      <span className="result__label">{label}</span>
      <pre>{children}</pre>
    </div>
  );
}

function RawJson({ value }: { value: unknown }) {
  return (
    <details className="result__raw">
      <summary>Raw result</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function ToolArguments({ name, args }: { name: string; args: Json }) {
  if (name === "run_python" && typeof args.code === "string")
    return <Pre label="Code">{args.code}</Pre>;
  if (name === "read_webpage")
    return (
      <p className="result__args">
        <a href={str(args.url)} target="_blank" rel="noreferrer noopener">
          {str(args.url)}
        </a>
        {str(args.question) && <span className="muted"> · {str(args.question)}</span>}
      </p>
    );
  if (name === "search_wikipedia") return <p className="result__args">“{str(args.query)}”</p>;
  if (name === "ask_user") return <p className="result__args">{str(args.question)}</p>;
  if (name === "create_action_plan" || name === "update_action_plan" || name === "create_research_paper")
    return null;
  const entries = Object.entries(args);
  if (!entries.length) return null;
  return (
    <p className="result__args mono small">
      {entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")}
    </p>
  );
}

export function ToolResult({ name, result }: { name: string; result: Json }) {
  if (result.cancelled) return <p className="muted small">Cancelled.</p>;
  if (typeof result.error === "string" && name !== "run_python")
    return (
      <>
        <p className="notice notice--danger small">{result.error}</p>
        <RawJson value={result} />
      </>
    );

  switch (name) {
    case "run_python":
      return (
        <>
          {str(result.stdout) && <Pre label="stdout">{str(result.stdout)}</Pre>}
          {result.result !== null && result.result !== undefined && (
            <Pre label="result">{String(result.result)}</Pre>
          )}
          {str(result.stderr) && <Pre label="stderr">{str(result.stderr)}</Pre>}
          {str(result.error) && <Pre label="error">{str(result.error)}</Pre>}
          <p className="muted small">
            {result.ok ? "✓ ran" : "✗ failed"}
            {typeof result.elapsed_ms === "number" && ` · ${Math.round(result.elapsed_ms)} ms`}
            {result.output_truncated ? " · output truncated" : ""}
          </p>
        </>
      );
    case "search_wikipedia":
    case "read_webpage": {
      const coverage = result.coverage as Json | undefined;
      return (
        <>
          {str(result.synthesis) && (
            <div className="result__brief">
              <Markdown>{str(result.synthesis)}</Markdown>
            </div>
          )}
          <Sources sources={result.sources} />
          {coverage && (
            <p className="muted small">
              {coverage.partial ? "Partial coverage" : "Full page analyzed"} ·{" "}
              {String(coverage.passage_tokens)} / {String(coverage.available_tokens)} tokens read
            </p>
          )}
          <RawJson value={result} />
        </>
      );
    }
    case "ask_user":
      return <p className="result__answer">↳ {str(result.answer)}</p>;
    case "get_current_context": {
      const location = result.location as Json | undefined;
      const place = location
        ? [location.locality, location.city, location.principalSubdivision, location.countryName]
            .filter((part, index, all) => part && all.indexOf(part) === index)
            .join(", ")
        : "";
      return (
        <>
          <p className="small">
            {str(result.local_datetime)} · {str(result.timezone)}
            {place && <> · 📍 {place}</>}
            {location && str(location.error) && <span className="muted"> · location: {str(location.error)}</span>}
          </p>
          <RawJson value={result} />
        </>
      );
    }
    case "create_action_plan":
    case "update_action_plan":
      return <p className="muted small">Plan updated (see the plan panel).</p>;
    case "create_research_paper":
      return <p className="muted small">Report ready: {str(result.filename)}</p>;
    default:
      return <RawJson value={result} />;
  }
}
