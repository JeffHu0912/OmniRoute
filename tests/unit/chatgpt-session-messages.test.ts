import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ChatGptSessionInputError,
  buildParsedRequest,
} from "../../open-sse/executors/chatgpt-session/messages.ts";
import { requireChatGptSessionRoute } from "../../open-sse/executors/chatgpt-session/models.ts";

const route = requireChatGptSessionRoute("high");

test("system messages become the system prompt, not conversation turns", () => {
  const parsed = buildParsedRequest({
    route,
    messages: [
      { role: "system", content: "Be terse." },
      { role: "user", content: "Hi" },
    ],
    stream: true,
  });
  assert.deepEqual(parsed.context.systemPrompt, ["Be terse."]);
  assert.equal(parsed.context.messages.length, 1);
  assert.equal(parsed.context.messages[0].role, "user");
});

test("developer messages join the system prompt in order", () => {
  const parsed = buildParsedRequest({
    route,
    messages: [
      { role: "system", content: "A" },
      { role: "developer", content: "B" },
      { role: "user", content: "Hi" },
    ],
    stream: false,
  });
  assert.deepEqual(parsed.context.systemPrompt, ["A", "B"]);
});

test("pins the backend model and the route effort", () => {
  const parsed = buildParsedRequest({
    route: requireChatGptSessionRoute("luna"),
    messages: [{ role: "user", content: "Hi" }],
    stream: true,
  });
  assert.equal(parsed.modelId, "gpt-5.6-luna");
  assert.equal(parsed.options.reasoning, "low");
  assert.equal(parsed.stream, true);
});

test("preserves multi-turn history with assistant text parts", () => {
  const parsed = buildParsedRequest({
    route,
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ],
    stream: true,
  });
  assert.equal(parsed.context.messages.length, 3);
  assert.deepEqual(parsed.context.messages[1], {
    role: "assistant",
    content: [{ type: "text", text: "two" }],
    timestamp: parsed.context.messages[1].timestamp,
  });
});

test("flattens OpenAI text content parts into one string", () => {
  const parsed = buildParsedRequest({
    route,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ],
    stream: true,
  });
  assert.equal(parsed.context.messages[0].content, "a\nb");
});

test("rejects image parts in phase 1", () => {
  assert.throws(
    () =>
      buildParsedRequest({
        route,
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }],
          },
        ],
        stream: true,
      }),
    (error: unknown) =>
      error instanceof ChatGptSessionInputError && error.code === "vision_unsupported"
  );
});

test("rejects a request with no user turn", () => {
  assert.throws(
    () => buildParsedRequest({ route, messages: [{ role: "system", content: "x" }], stream: true }),
    (error: unknown) =>
      error instanceof ChatGptSessionInputError && error.code === "no_user_message"
  );
});

test("never carries tools into the parsed context", () => {
  const parsed = buildParsedRequest({
    route,
    messages: [{ role: "user", content: "Hi" }],
    stream: true,
  });
  assert.equal(parsed.context.tools, undefined);
});

test("rejects any content part that is neither text nor an image", () => {
  for (const part of [
    { type: "file", file: { file_id: "f-1" } },
    { type: "input_audio", input_audio: { data: "AA", format: "wav" } },
  ]) {
    assert.throws(
      () =>
        buildParsedRequest({
          route,
          messages: [{ role: "user", content: [part] }],
          stream: false,
        }),
      (error: unknown) =>
        error instanceof ChatGptSessionInputError && error.code === "unsupported_content_part"
    );
  }
});

test("an assistant refusal part is folded into the mapped content as text", () => {
  const parsed = buildParsedRequest({
    route,
    messages: [
      { role: "user", content: "one" },
      {
        role: "assistant",
        content: [
          { type: "refusal", refusal: "I can't help with that." },
          { type: "text", text: "Here is something else." },
        ],
      },
      { role: "user", content: "three" },
    ],
    stream: true,
  });
  assert.equal(parsed.context.messages.length, 3);
  assert.deepEqual(parsed.context.messages[1], {
    role: "assistant",
    content: [{ type: "text", text: "I can't help with that.\nHere is something else." }],
    timestamp: parsed.context.messages[1].timestamp,
  });
});

test("a refusal part whose refusal field is not a string is still rejected", () => {
  for (const part of [
    { type: "refusal" },
    { type: "refusal", refusal: null },
    { type: "refusal", refusal: { text: "nope" } },
    { type: "refusal", text: "wrong field" },
  ]) {
    assert.throws(
      () =>
        buildParsedRequest({
          route,
          messages: [
            { role: "user", content: "one" },
            { role: "assistant", content: [part] },
          ],
          stream: false,
        }),
      (error: unknown) =>
        error instanceof ChatGptSessionInputError && error.code === "unsupported_content_part"
    );
  }
});
