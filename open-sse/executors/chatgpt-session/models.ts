/**
 * Public model routes for the ChatGPT Session provider.
 *
 * Each public slug pins one backend model plus one reasoning effort. The vendored browser
 * adapter accepts only the two backend ids and reads the effort from
 * `CodexParsedRequest.options.reasoning`, so the slug is the only knob a client turns.
 */

export type ChatGptSessionEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatGptSessionRoute {
  id: string;
  backendModel: "gpt-5.6-sol" | "gpt-5.6-luna";
  effort: ChatGptSessionEffort;
  /** Requires an account whose browser probe reported Pro. */
  pro: boolean;
  /** Requires the Sol model selector; Luna-only accounts get the luna/think routes. */
  sol: boolean;
}

const ROUTES: ReadonlyMap<string, ChatGptSessionRoute> = new Map([
  ["luna", { id: "luna", backendModel: "gpt-5.6-luna", effort: "low", pro: false, sol: false }],
  [
    "think",
    { id: "think", backendModel: "gpt-5.6-luna", effort: "medium", pro: false, sol: false },
  ],
  ["instant", { id: "instant", backendModel: "gpt-5.6-sol", effort: "low", pro: false, sol: true }],
  [
    "medium",
    { id: "medium", backendModel: "gpt-5.6-sol", effort: "medium", pro: false, sol: true },
  ],
  ["high", { id: "high", backendModel: "gpt-5.6-sol", effort: "high", pro: false, sol: true }],
  [
    "extra-high",
    { id: "extra-high", backendModel: "gpt-5.6-sol", effort: "xhigh", pro: true, sol: true },
  ],
  ["pro", { id: "pro", backendModel: "gpt-5.6-sol", effort: "max", pro: true, sol: true }],
] as const);

export const CHATGPT_SESSION_ROUTE_IDS: readonly string[] = [...ROUTES.keys()];

export function requireChatGptSessionRoute(model: string): ChatGptSessionRoute {
  const normalized = model.trim().replace(/^(?:chatgpt-session|cgpt-session)\//, "");
  const route = ROUTES.get(normalized);
  if (!route) throw new Error(`Unsupported ChatGPT Session model: ${model}`);
  return route;
}
