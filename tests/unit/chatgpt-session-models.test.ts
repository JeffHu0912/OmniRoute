import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHATGPT_SESSION_ROUTE_IDS,
  requireChatGptSessionRoute,
} from "../../open-sse/executors/chatgpt-session/models.ts";

test("exposes the seven public routes", () => {
  assert.deepEqual(
    [...CHATGPT_SESSION_ROUTE_IDS],
    ["luna", "think", "instant", "medium", "high", "extra-high", "pro"]
  );
});

test("maps a slug to its backend model and effort", () => {
  assert.deepEqual(requireChatGptSessionRoute("high"), {
    id: "high",
    backendModel: "gpt-5.6-sol",
    effort: "high",
    pro: false,
    sol: true,
  });
});

test("strips the provider prefix from a qualified model id", () => {
  assert.equal(requireChatGptSessionRoute("chatgpt-session/pro").id, "pro");
  assert.equal(requireChatGptSessionRoute("cgpt-session/pro").id, "pro");
});

test("luna routes target the luna backend and never require sol", () => {
  const luna = requireChatGptSessionRoute("luna");
  assert.equal(luna.backendModel, "gpt-5.6-luna");
  assert.equal(luna.sol, false);
  assert.equal(requireChatGptSessionRoute("think").effort, "medium");
});

test("pro routes are flagged pro", () => {
  assert.equal(requireChatGptSessionRoute("pro").pro, true);
  assert.equal(requireChatGptSessionRoute("extra-high").pro, true);
});

test("rejects an unknown slug", () => {
  assert.throws(
    () => requireChatGptSessionRoute("gpt-4"),
    /Unsupported ChatGPT Session model: gpt-4/
  );
});
