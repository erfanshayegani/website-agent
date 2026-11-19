import { AlertTriangle, CheckCircle2, Cpu, Download, Loader2 } from "lucide-react";
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
  const percent = Math.max(0, Math.min(100, progress?.progress ?? 0));

  if (phase === "ready")
    return (
      <section className="card model model--ready" aria-live="polite">
        <CheckCircle2 size={18} className="model__icon" aria-hidden />
        <div>
          <strong>Model ready</strong>
          <span className="muted"> · {MODEL_ID} · q4f16 · WebGPU</span>
        </div>
      </section>
    );

  return (
    <section className="card model" aria-live="polite">
      <div className="model__head">
        <Cpu size={18} className="model__icon" aria-hidden />
        <div>
          <strong>{MODEL_ID}</strong>
          <p className="muted small">
            q4f16 · {size} one-time download, cached by your browser · runs on your GPU
          </p>
        </div>
      </div>

      {!hasWebGpu ? (
        <p className="notice notice--warning">
          <AlertTriangle size={16} aria-hidden /> Your browser doesn't expose WebGPU, so the model
          can't run here. Try a recent desktop Chrome or Edge, or Safari 26+.
        </p>
      ) : phase === "loading" ? (
        <div className="progress" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress__bar" style={{ width: `${percent}%` }} />
          <span className="progress__label">
            <Loader2 size={14} className="spin" aria-hidden />
            {progress && progress.total
              ? `${formatBytes(progress.loaded ?? 0)} / ${formatBytes(progress.total)} · ${percent.toFixed(0)}%`
              : getModelLoadLabel(metadata, true, size)}
          </span>
        </div>
      ) : (
        <>
          {phase === "error" && (
            <p className="notice notice--danger">
              <AlertTriangle size={16} aria-hidden /> The model failed to load. You can try again.
            </p>
          )}
          <button type="button" className="button button--primary" onClick={onLoad}>
            <Download size={16} aria-hidden /> {getModelLoadLabel(metadata, false, size)}
          </button>
        </>
      )}
    </section>
  );
}
