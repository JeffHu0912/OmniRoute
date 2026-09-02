import { test } from "node:test";
import assert from "node:assert/strict";

import { WEB_COOKIE_PROVIDERS } from "../../src/shared/constants/providers/web-cookie.ts";
import { WEB_SESSION_CREDENTIAL_REQUIREMENTS } from "../../src/shared/providers/webSessionCredentials.ts";

test("the dashboard card describes the session provider", () => {
  const card = (WEB_COOKIE_PROVIDERS as Record<string, Record<string, unknown>>)[
    "chatgpt-session"
  ];
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

test("validation is registered for the provider id", async () => {
  const module = await import("../../src/lib/providers/validation.ts");
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(
      new URL("../../src/lib/providers/validation.ts", import.meta.url),
      "utf8"
    )
  );
  assert.match(source, /"chatgpt-session":\s*validateChatGptSessionProvider/);
  assert.ok(module);
});

test("validation rejects an empty credential without launching a browser", async () => {
  const { validateChatGptSessionProvider } = await import(
    "../../src/lib/providers/validation/chatgptSession.ts"
  );
  const result = await validateChatGptSessionProvider({ apiKey: "" });
  assert.equal(result.valid, false);
  assert.match(String(result.error), /cookie|credential/i);
});
