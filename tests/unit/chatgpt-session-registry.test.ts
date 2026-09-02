import { test } from "node:test";
import assert from "node:assert/strict";

import { REGISTRY } from "../../open-sse/config/providerRegistry.ts";
import { CHATGPT_SESSION_ROUTE_IDS } from "../../open-sse/executors/chatgpt-session/models.ts";
import {
  RETIRED_COMMON_CHATGPT_WEB_PROVIDER_IDS,
  isCommonChatGptWebRetiredProviderId,
} from "../../src/shared/constants/chatgptWebRetirement.ts";

test("the registry exposes chatgpt-session with its seven routes", () => {
  const entry = REGISTRY["chatgpt-session"];
  assert.ok(entry, "chatgpt-session must be registered");
  assert.equal(entry.alias, "cgpt-session");
  assert.equal(entry.format, "openai");
  assert.equal(entry.executor, "chatgpt-session");
  assert.deepEqual(
    entry.models.map((model) => model.id),
    [...CHATGPT_SESSION_ROUTE_IDS]
  );
});

test("the new ids are not the retired ones", () => {
  assert.equal(isCommonChatGptWebRetiredProviderId("chatgpt-session"), false);
  assert.equal(isCommonChatGptWebRetiredProviderId("cgpt-session"), false);
  assert.deepEqual([...RETIRED_COMMON_CHATGPT_WEB_PROVIDER_IDS], ["chatgpt-web", "cgpt-web"]);
});

test("both executor aliases resolve to the session executor", async () => {
  const { getExecutor } = await import("../../open-sse/executors/index.ts");
  for (const id of ["chatgpt-session", "cgpt-session"]) {
    const executor = await getExecutor(id);
    assert.equal(executor.getProvider(), "chatgpt-session");
  }
});
