/**
 * Maps every failure this provider can produce onto the HTTP contract the router expects.
 *
 * The distinction that matters: a 503 with `connection_cooldown` lets combo routing skip this
 * connection without opening the provider circuit breaker, while a 400 is terminal and must not
 * be retried (a changed ChatGPT DOM will not fix itself on a retry).
 */

import { ChatGptSessionInputError } from "./messages.ts";

export interface ChatGptSessionErrorClass {
  status: number;
  code: string;
  fallbackHint?: "connection_cooldown";
}

interface ErrorLike {
  message: string;
  name?: string;
  status?: number;
  code?: string;
}

function asErrorLike(error: unknown): ErrorLike {
  if (error instanceof Error) {
    const typed = error as Error & { status?: unknown; code?: unknown };
    return {
      message: error.message,
      name: error.name,
      ...(typeof typed.status === "number" ? { status: typed.status } : {}),
      ...(typeof typed.code === "string" ? { code: typed.code } : {}),
    };
  }
  if (error && typeof error === "object") {
    const typed = error as Record<string, unknown>;
    return {
      message: typeof typed.message === "string" ? typed.message : String(error),
      ...(typeof typed.name === "string" ? { name: typed.name } : {}),
      ...(typeof typed.status === "number" ? { status: typed.status } : {}),
      ...(typeof typed.code === "string" ? { code: typed.code } : {}),
    };
  }
  return { message: String(error ?? "") };
}

const BROWSER_UNAVAILABLE =
  /No supported Chrome|browserType\.launch|Executable doesn't exist|chromium.*not installed/i;
const MISSING_CREDENTIALS =
  /credentials are missing|Cookie or verified browser storage state is required|Cookie header is missing/i;
const SESSION_EXPIRED = /not authenticated|storage state is invalid|sign ?in|log ?in|logged out/i;
const RATE_LIMITED = /rate limit|usage limit|too many requests|message limit/i;
const ROUTE_UNAVAILABLE =
  /not available for this|not available while the account|is not supported/i;
const UI_TIMEOUT = /waitForSelector|Timeout \d+ms exceeded|actionability|interception/i;

export function classifyChatGptSessionError(error: unknown): ChatGptSessionErrorClass {
  if (error instanceof ChatGptSessionInputError) {
    return { status: 400, code: error.code };
  }

  const like = asErrorLike(error);

  if (BROWSER_UNAVAILABLE.test(like.message)) {
    return { status: 503, code: "browser_unavailable", fallbackHint: "connection_cooldown" };
  }
  if (MISSING_CREDENTIALS.test(like.message)) {
    return { status: 401, code: "missing_credentials" };
  }
  if (SESSION_EXPIRED.test(like.message)) {
    return { status: 401, code: "session_expired" };
  }
  if (RATE_LIMITED.test(like.message)) {
    return { status: 429, code: "rate_limited" };
  }
  if (ROUTE_UNAVAILABLE.test(like.message)) {
    return { status: 400, code: "route_unavailable" };
  }
  if (like.name === "TimeoutError" || UI_TIMEOUT.test(like.message)) {
    return { status: 400, code: "browser_ui_timeout" };
  }
  if (typeof like.status === "number" && like.status >= 400) {
    return { status: like.status, code: like.code ?? "turn_failed" };
  }
  return { status: 502, code: "turn_failed" };
}
