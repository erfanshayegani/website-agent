import { Copy, Download } from "lucide-react";
import { useState } from "react";
import type { AgentTurnTrace, BrowserArtifact } from "../types";
import Markdown from "./Markdown";

function download(artifact: BrowserArtifact) {
  const url = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = artifact.filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function AnswerCard({
  answer,
  artifact,
}: {
  answer: AgentTurnTrace;
  artifact: BrowserArtifact | null;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="answer">
      <div className="answer__inner">
        <div className="answer__head">
          <h2 className="answer__title">
            <span className="answer__sparkle" aria-hidden>
              ✨
            </span>{" "}
            Answer
          </h2>
          <div className="answer__actions">
            <button
              type="button"
              className="button button--small"
              onClick={() => {
                void navigator.clipboard?.writeText(answer.content).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <Copy size={13} aria-hidden /> {copied ? "Copied!" : "Copy"}
            </button>
            {artifact && (
              <button type="button" className="button button--small" onClick={() => download(artifact)}>
                <Download size={13} aria-hidden /> Report (.md)
              </button>
            )}
          </div>
        </div>
        <Markdown>{answer.content}</Markdown>
      </div>
    </section>
  );
}
