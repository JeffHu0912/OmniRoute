import type { RegistryEntry } from "../../shared.ts";

const SESSION_CAPABILITIES = {
  toolCalling: true,
  supportsReasoning: true,
  supportsVision: false,
} as const;

export const chatgpt_sessionProvider: RegistryEntry = {
  id: "chatgpt-session",
  alias: "cgpt-session",
  format: "openai",
  executor: "chatgpt-session",
  baseUrl: "https://chatgpt.com",
  reasoningTransport: "opaque",
  authType: "apikey",
  authHeader: "cookie",
  models: [
    { id: "luna", name: "ChatGPT Session — Luna", ...SESSION_CAPABILITIES },
    { id: "think", name: "ChatGPT Session — Think", ...SESSION_CAPABILITIES },
    { id: "instant", name: "ChatGPT Session — Instant", ...SESSION_CAPABILITIES },
    { id: "medium", name: "ChatGPT Session — Medium", ...SESSION_CAPABILITIES },
    { id: "high", name: "ChatGPT Session — High", ...SESSION_CAPABILITIES },
    { id: "extra-high", name: "ChatGPT Session — Extra High", ...SESSION_CAPABILITIES },
    { id: "pro", name: "ChatGPT Session — Pro", ...SESSION_CAPABILITIES },
  ],
};
