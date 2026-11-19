import { Download, Sparkles } from "lucide-react";
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
  return (
    <section className="card answer">
      <div className="answer__head">
        <h2 className="label">
          <Sparkles size={14} aria-hidden /> Answer
        </h2>
        {artifact && (
          <button type="button" className="button button--small" onClick={() => download(artifact)}>
            <Download size={13} aria-hidden /> {artifact.filename}
          </button>
        )}
      </div>
      <Markdown>{answer.content}</Markdown>
    </section>
  );
}
