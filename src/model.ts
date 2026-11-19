// Model identity, Transformers.js environment and download metadata (SPEC §2).

export const MODEL_ID = "LiquidAI/LFM2.5-2.6B-ONNX";
export const MODEL_TASK = "text-generation";
export const MODEL_OPTIONS = { device: "webgpu", dtype: "q4f16" } as const;

interface TransformersEnvironment {
  experimental_useCrossOriginStorage: boolean;
}

const configured = new WeakSet<object>();

/**
 * SPEC §2.2. Only cross-origin storage is enabled. The original could also
 * inject a Hugging Face access token from a build-time variable; that is
 * deliberately not supported here, because this build is public and the token
 * would be embedded in the shipped JavaScript. The model repo is not gated.
 */
export function configureTransformersEnv(env: TransformersEnvironment): void {
  if (configured.has(env)) return;
  env.experimental_useCrossOriginStorage = true;
  configured.add(env);
}

export type ModelMetadata =
  | { status: "loading" }
  | { status: "ready"; totalBytes: number; isPipelineCached: boolean }
  | { status: "error" };

/** SPEC §2.5 — total download size and whether the files are already cached. */
export async function getModelMetadata(): Promise<ModelMetadata> {
  try {
    const { ModelRegistry, env } = await import("@huggingface/transformers");
    configureTransformersEnv(env as unknown as TransformersEnvironment);
    const [files, isPipelineCached] = await Promise.all([
      ModelRegistry.get_pipeline_files(MODEL_TASK, MODEL_ID, MODEL_OPTIONS),
      ModelRegistry.is_pipeline_cached(MODEL_TASK, MODEL_ID, MODEL_OPTIONS),
    ]);
    const sizes = await Promise.all(
      files.map(async (file: string) => {
        const metadata = await ModelRegistry.get_file_metadata(MODEL_ID, file);
        return (metadata as { size?: number }).size ?? 0;
      })
    );
    return {
      status: "ready",
      totalBytes: sizes.reduce((sum, size) => sum + size, 0),
      isPipelineCached: Boolean(isPipelineCached),
    };
  } catch {
    return { status: "error" };
  }
}

/** SPEC §2.5 — label for the load button. */
export function getModelLoadLabel(
  metadata: ModelMetadata,
  isLoading: boolean,
  modelSize: string
): string {
  if (isLoading) return "Initializing pipeline...";
  if (metadata.status === "loading") return "Initializing...";
  if (metadata.status === "error") return "Load model";
  if (metadata.isPipelineCached) return "Load model (already cached)";
  return `Download model (${modelSize})`;
}

/** SPEC §2.4 — strip HF {% generation %} tags the Jinja engine can't parse. */
const GENERATION_TAG = /{%-?\s*(?:endgeneration|generation)\s*-?%}/g;

export function normalizeChatTemplate(template: unknown): unknown {
  if (typeof template === "string") return template.replace(GENERATION_TAG, "");
  if (template && typeof template === "object") {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template))
      cleaned[key] =
        typeof value === "string" ? value.replace(GENERATION_TAG, "") : value;
    return cleaned;
  }
  return template;
}
