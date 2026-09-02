export const CHATGPT_WEB_CODEX_CONNECTOR_NAME = "OmniRoute Codex v2";
export const CHATGPT_WEB_CODEX_PROVIDER_ID = "chatgpt-web-codex";
export const CHATGPT_WEB_CODEX_MODEL_PREFIX = `${CHATGPT_WEB_CODEX_PROVIDER_ID}/`;

export function isChatGptWebCodexModel(model: unknown): boolean {
  return typeof model === "string" && model.startsWith(CHATGPT_WEB_CODEX_MODEL_PREFIX);
}

// ChatGPT's Cloudflare challenge rejects the true-headless Chrome shape even when the
// persisted account session is valid. Keep runtime turns aligned with the headed browser
// used to verify that same storage state.
export const CHATGPT_WEB_CODEX_RUNTIME_HEADED = true;

// Both "chatgpt-web-codex" and "chatgpt-session" store a verified Playwright storage
// state produced from a pasted ChatGPT cookie header — the browser-session credential
// lifecycle (decode -> ensure storage state -> inspect -> finalize) is shared between
// them. The finalize step is what discards the raw pasted cookie in favor of the
// verified storage state, so any dashboard route that gates on that lifecycle must
// recognize both provider ids, not just the codex one.
export const CHATGPT_BROWSER_SESSION_PROVIDER_IDS = [
  CHATGPT_WEB_CODEX_PROVIDER_ID,
  "chatgpt-session",
] as const;

export function usesChatGptBrowserSessionCredentials(provider: unknown): boolean {
  return (
    typeof provider === "string" &&
    (CHATGPT_BROWSER_SESSION_PROVIDER_IDS as readonly string[]).includes(provider)
  );
}
