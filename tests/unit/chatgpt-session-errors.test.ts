import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyChatGptSessionError } from "../../open-sse/executors/chatgpt-session/errors.ts";
import { ChatGptSessionInputError } from "../../open-sse/executors/chatgpt-session/messages.ts";

test("a missing browser is a cooldown-hinted 503", () => {
  const result = classifyChatGptSessionError(
    new Error("No supported Chrome or Chromium executable was found")
  );
  assert.equal(result.status, 503);
  assert.equal(result.code, "browser_unavailable");
  assert.equal(result.fallbackHint, "connection_cooldown");
});

test("a playwright launch failure is also a cooldown-hinted 503", () => {
  const result = classifyChatGptSessionError(
    new Error("browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/x")
  );
  assert.equal(result.status, 503);
  assert.equal(result.fallbackHint, "connection_cooldown");
});

test("missing credentials are a 401", () => {
  assert.equal(
    classifyChatGptSessionError(new Error("ChatGPT browser credentials are missing")).status,
    401
  );
});

test("an expired session is a 401 session_expired", () => {
  const result = classifyChatGptSessionError(new Error("ChatGPT page is not authenticated"));
  assert.equal(result.status, 401);
  assert.equal(result.code, "session_expired");
});

test("a rate-limit dialog is a 429", () => {
  const result = classifyChatGptSessionError(new Error("ChatGPT reported a usage limit"));
  assert.equal(result.status, 429);
  assert.equal(result.code, "rate_limited");
});

test("an account-capability mismatch is a terminal 400", () => {
  const result = classifyChatGptSessionError(
    new Error("pro is not available for this non-Pro connection")
  );
  assert.equal(result.status, 400);
  assert.equal(result.code, "route_unavailable");
  assert.equal(result.fallbackHint, undefined);
});

test("a DOM timeout is a terminal 400, not a retryable 5xx", () => {
  const timeout = new Error("locator.waitForSelector: Timeout 30000ms exceeded");
  timeout.name = "TimeoutError";
  const result = classifyChatGptSessionError(timeout);
  assert.equal(result.status, 400);
  assert.equal(result.code, "browser_ui_timeout");
});

test("a TimeoutError naming a login selector is a UI timeout, not an expired session", () => {
  const timeout = new Error(
    'page.waitForSelector: Timeout 15000ms exceeded ... selector "button:has-text(\\"Log in\\")"'
  );
  timeout.name = "TimeoutError";
  const result = classifyChatGptSessionError(timeout);
  assert.equal(result.status, 400);
  assert.equal(result.code, "browser_ui_timeout");
});

test("input errors map to their own 400 codes", () => {
  const result = classifyChatGptSessionError(
    new ChatGptSessionInputError("vision_unsupported", "no images")
  );
  assert.equal(result.status, 400);
  assert.equal(result.code, "vision_unsupported");
});

test("an explicit upstream status is used when no message pattern matches", () => {
  const result = classifyChatGptSessionError({ message: "anything", status: 502, code: "x" });
  assert.equal(result.status, 502);
});

// CONTRACT CHANGE (deliberate inversion of the previous expectation). This test used to assert
// that a recognised message beat an explicit upstream status; the precedence is now the other way
// round. The vendor documents `AdapterEvent.error.status` as "Authoritative upstream/proxy status
// when known; avoids message-based classification", and honouring that is what stops a 503 whose
// prose happens to mention signing in from being reported as an expired session — which would
// mark a HEALTHY account's credentials dead and pull it out of rotation. Message matching still
// runs, just as the fallback for failures that carry no status at all (everything this executor
// throws itself).
test("an explicit upstream status wins over a matching message", () => {
  const result = classifyChatGptSessionError({
    message: "ChatGPT reported a usage limit",
    status: 500,
  });
  assert.equal(result.status, 500);
  assert.equal(result.code, "turn_failed");
});

test("a session-expired message cannot downgrade an explicit 503 to a 401", () => {
  const result = classifyChatGptSessionError({
    message: "Please sign in to continue",
    status: 503,
  });
  assert.equal(result.status, 503);
  assert.notEqual(result.code, "session_expired");
});

test("an explicit 503 carries the connection cooldown hint", () => {
  const result = classifyChatGptSessionError({ message: "upstream unavailable", status: 503 });
  assert.equal(result.status, 503);
  assert.equal(result.fallbackHint, "connection_cooldown");
});

test("an explicit 429 carries the connection cooldown hint", () => {
  const result = classifyChatGptSessionError({ message: "slow down", status: 429 });
  assert.equal(result.status, 429);
  assert.equal(result.fallbackHint, "connection_cooldown");
});

test("an explicit 400 carries no cooldown hint", () => {
  const result = classifyChatGptSessionError({ message: "bad request", status: 400 });
  assert.equal(result.status, 400);
  assert.equal(result.fallbackHint, undefined);
});

test("an explicit status keeps the event's own code when it carries one", () => {
  const result = classifyChatGptSessionError({
    message: "anything",
    status: 503,
    code: "upstream_unavailable",
  });
  assert.equal(result.code, "upstream_unavailable");
});

test("a TimeoutError still outranks an explicit upstream status", () => {
  const timeout = new Error("locator.waitForSelector: Timeout 30000ms exceeded") as Error & {
    status?: number;
  };
  timeout.name = "TimeoutError";
  timeout.status = 503;
  const result = classifyChatGptSessionError(timeout);
  assert.equal(result.status, 400);
  assert.equal(result.code, "browser_ui_timeout");
});

test("message patterns still classify failures that carry no status", () => {
  const result = classifyChatGptSessionError(new Error("ChatGPT reported a usage limit"));
  assert.equal(result.status, 429);
  assert.equal(result.code, "rate_limited");
});

test("an unrecognised failure is a retryable 502", () => {
  const result = classifyChatGptSessionError(new Error("something odd happened"));
  assert.equal(result.status, 502);
  assert.equal(result.code, "turn_failed");
});
