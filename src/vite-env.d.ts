/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL of the deployed read_webpage proxy (proxy/). Empty = local /__webpage. */
  readonly VITE_WEBPAGE_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
