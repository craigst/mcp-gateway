/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional absolute gateway origin; defaults to same-origin (served from ui/dist). */
  readonly VITE_API_BASE_URL?: string;
  /** Optional absolute WebSocket origin for live log streaming. */
  readonly VITE_GATEWAY_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
