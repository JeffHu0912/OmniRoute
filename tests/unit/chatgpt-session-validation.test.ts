import { test } from "node:test";
import assert from "node:assert/strict";

import { WEB_COOKIE_PROVIDERS } from "../../src/shared/constants/providers/web-cookie.ts";
import { WEB_SESSION_CREDENTIAL_REQUIREMENTS } from "../../src/shared/providers/webSessionCredentials.ts";
import { usesChatGptBrowserSessionCredentials } from "../../src/shared/constants/chatgptWebCodex.ts";

test("the dashboard card describes the session provider", () => {
  const card = (WEB_COOKIE_PROVIDERS as Record<string, Record<string, unknown>>)["chatgpt-session"];
  assert.ok(card, "chatgpt-session must have a web-cookie card");
  assert.equal(card.alias, "cgpt-session");
  assert.equal(card.website, "https://chatgpt.com");
  assert.equal(card.subscriptionRisk, true);
  assert.equal(card.riskNoticeVariant, "webCookie");
  assert.equal(card.toolCalling, "emulated");
});

test("the credential requirement accepts a full cookie header", () => {
  const requirement = (
    WEB_SESSION_CREDENTIAL_REQUIREMENTS as Record<string, Record<string, unknown>>
  )["chatgpt-session"];
  assert.ok(requirement);
  assert.equal(requirement.kind, "cookie");
  assert.equal(requirement.acceptsFullCookieHeader, true);
});

test("validateProviderApiKey dispatch resolves chatgpt-session to its own validator", async () => {
  const { validateProviderApiKey } = await import("../../src/lib/providers/validation.ts");
  // "cookie:" decodes to an empty cookie (decodeChatGptWebCodexSecrets strips the
  // "cookie:" prefix), so validateChatGptSessionProvider returns its own
  // cookie-required rejection immediately — before any Chrome/CDP detection or
  // browser launch. A non-empty credential is required here: an empty apiKey is
  // intercepted by validateProviderApiKey's own "Provider and API key required"
  // gate before dispatch ever reaches the SPECIALTY_VALIDATORS map, which would
  // prove nothing about chatgpt-session's own registration.
  const result = await validateProviderApiKey({
    provider: "chatgpt-session",
    apiKey: "cookie:",
  });
  assert.equal(result.valid, false);
  assert.equal(result.error, "A ChatGPT cookie header or a stored browser session is required.");
});

test("validation rejects an empty credential without launching a browser", async () => {
  const { validateChatGptSessionProvider } =
    await import("../../src/lib/providers/validation/chatgptSession.ts");
  const result = await validateChatGptSessionProvider({ apiKey: "" });
  assert.equal(result.valid, false);
  assert.match(String(result.error), /cookie|credential/i);
});

test("usesChatGptBrowserSessionCredentials recognizes both browser-session providers", () => {
  assert.equal(usesChatGptBrowserSessionCredentials("chatgpt-web-codex"), true);
  assert.equal(usesChatGptBrowserSessionCredentials("chatgpt-session"), true);
  assert.equal(usesChatGptBrowserSessionCredentials("openai"), false);
  assert.equal(usesChatGptBrowserSessionCredentials(undefined), false);
});
