import { AlertTriangle, CheckCircle2, Cpu, Power } from "lucide-react";
import { useEffect, useState } from "react";
import { MODEL_ID, getModelLoadLabel, getModelMetadata, type ModelMetadata } from "../model";
import type { LoadProgress, ModelPhase } from "../types";
import { formatBytes } from "../utils/format";

const hasWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;

export default function ModelCard({
  phase,
  progress,
  onLoad,
}: {
  phase: ModelPhase;
  progress: LoadProgress | null;
  onLoad(): void;
}) {
  const [metadata, setMetadata] = useState<ModelMetadata>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    void getModelMetadata().then((value) => alive && setMetadata(value));
    return () => {
      alive = false;
    };
  }, []);

  const size = metadata.status === "ready" ? formatBytes(metadata.totalBytes) : "about 1.5 GB";
  const cached = metadata.status === "ready" && metadata.isPipelineCached;
  const percent = Math.max(0, Math.min(100, progress?.progress ?? 0));

  if (phase === "ready")
    return (
      <section className="card power power--ready" aria-live="polite">
        <span className="power__dot" aria-hidden />
        <CheckCircle2 size={18} aria-hidden className="power__ok" />
        <div>
          <strong>Agent is awake</strong>
          <span className="muted small"> · {MODEL_ID} · q4f16 · running on your GPU</span>
        </div>
      </section>
    );

  return (
    <section className="card power" aria-live="polite">
      <div className="power__chip" aria-hidden>
        <Cpu size={26} />
      </div>
      <div className="power__body">
        <h2 className="power__title">Wake up the agent</h2>
        <p className="muted small">
          {cached
            ? "The model is already in your browser cache, so this only takes a few seconds."
            : `First, your browser downloads the model once (${size}). After that it's cached, and everything runs locally.`}
        </p>

        {!hasWebGpu ? (
          <p className="notice notice--warning">
            <AlertTriangle size={16} aria-hidden /> Your browser doesn't expose WebGPU, so the
            model can't run here. Try a recent desktop Chrome or Edge, or Safari 26+.
          </p>
        ) : phase === "loading" ? (
          <div className="progress" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress__track">
              <div className="progress__bar" style={{ width: `${percent}%` }} />
            </div>
            <div className="progress__meta">
              <span className="progress__percent">{percent.toFixed(0)}%</span>
              <span className="muted small">
                {progress?.total
                  ? `${formatBytes(progress.loaded ?? 0)} of ${formatBytes(progress.total)}`
                  : getModelLoadLabel(metadata, true, size)}
              </span>
            </div>
          </div>
        ) : (
          <>
            {phase === "error" && (
              <p className="notice notice--danger">
                <AlertTriangle size={16} aria-hidden /> The model failed to load. You can try again.
              </p>
            )}
            <button type="button" className="button button--glow" onClick={onLoad}>
              <Power size={16} aria-hidden /> {getModelLoadLabel(metadata, false, size)}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
