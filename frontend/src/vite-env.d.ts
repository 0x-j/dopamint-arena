/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
  // Warning: When set, the frontend calls Ollama directly and bypasses backend auth.
  // Leave unset in deployed stacks to keep chat behind the authenticated backend proxy.
  // Direct-to-Ollama chat (bypasses the authenticated backend /v1/sessions/:sessionId/chat proxy). Set
  // VITE_OLLAMA_URL to enable; empty = use the backend proxy, a full URL = direct
  // Ollama access (cross-origin, requires OLLAMA_ORIGINS on the Ollama side).
  readonly VITE_OLLAMA_URL?: string;
  readonly VITE_OLLAMA_MODEL?: string;
  readonly VITE_OLLAMA_MAX_TOKENS?: string;
  readonly VITE_QUANTUM_POKER_SERVER_URL?: string;
  readonly VITE_TUNNEL_PACKAGE_ID?: string;
  // zkLogin (Enoki + Google) sign-in. Public client identifiers; both required to enable it.
  readonly VITE_ENOKI_API_KEY?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  // MTPS free-faucet stake token (ADR-0010). All three required to stake MTPS.
  readonly VITE_MTPS_PACKAGE_ID?: string;
  readonly VITE_MTPS_FAUCET_ID?: string;
  readonly VITE_MTPS_COIN_TYPE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
