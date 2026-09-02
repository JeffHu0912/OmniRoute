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

/**
 * The synthesized `_rawBody` envelope. Without it the vendored adapter refuses every turn
 * ("ChatGPT web requires native Codex turn_id metadata for browser-session replay") before any
 * browser work, so these assertions guard a live-fatal defect that adapter mocking cannot see.
 */
function rawBody(parsed: { _rawBody?: unknown }): Record<string, unknown> {
  const body = parsed._rawBody;
  assert.ok(body && typeof body === "object" && !Array.isArray(body), "_rawBody must be an object");
  return body as Record<string, unknown>;
}

function turnMetadata(parsed: { _rawBody?: unknown }): Record<string, unknown> {
  const clientMetadata = rawBody(parsed).client_metadata;
  assert.ok(
    clientMetadata && typeof clientMetadata === "object" && !Array.isArray(clientMetadata),
    "client_metadata must be an object"
  );
  const raw = (clientMetadata as Record<string, unknown>)["x-codex-turn-metadata"];
  assert.equal(
    typeof raw,
    "string",
    "x-codex-turn-metadata must be the JSON string the client sends"
  );
  const decoded: unknown = JSON.parse(raw as string);
  assert.ok(decoded && typeof decoded === "object" && !Array.isArray(decoded));
  return decoded as Record<string, unknown>;
}

function inputItems(parsed: { _rawBody?: unknown }): Array<Record<string, unknown>> {
  const input = rawBody(parsed).input;
  assert.ok(Array.isArray(input), "_rawBody.input must be an array");
  return input.map((item) => {
    assert.ok(item && typeof item === "object" && !Array.isArray(item));
    return item as Record<string, unknown>;
  });
}

function passthroughTurnId(item: Record<string, unknown>): unknown {
  const passthrough = item.internal_chat_message_metadata_passthrough;
  if (passthrough === undefined) return undefined;
  assert.ok(passthrough && typeof passthrough === "object" && !Array.isArray(passthrough));
  return (passthrough as Record<string, unknown>).turn_id;
}

test("the turn metadata is a JSON string carrying a thread id and a turn id", () => {
  const parsed = buildParsedRequest({
    route,
    messages: [{ role: "user", content: "Hi" }],
    stream: true,
  });
  const metadata = turnMetadata(parsed);
  assert.equal(typeof metadata.thread_id, "string");
  assert.equal(typeof metadata.turn_id, "string");
  assert.match(String(metadata.thread_id), /^thread_omniroute_/);
  assert.match(String(metadata.turn_id), /^turn_omniroute_/);
});

test("_rawBody.input mirrors the parsed messages, in order and in Responses item shape", () => {
  const parsed = buildParsedRequest({
    route,
    messages: [
      { role: "system", content: "Be terse." },
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ],
    stream: true,
  });
  const items = inputItems(parsed);
  assert.equal(items.length, parsed.context.messages.length);
  assert.deepEqual(
    items.map((item) => item.role),
    ["user", "assistant", "user"]
  );
  assert.deepEqual(
    items.map((item) => item.type),
    ["message", "message", "message"]
  );
  assert.deepEqual(items[0].content, [{ type: "input_text", text: "one" }]);
  assert.deepEqual(items[1].content, [{ type: "output_text", text: "two" }]);
  assert.deepEqual(items[2].content, [{ type: "input_text", text: "three" }]);
  // System prompts stay out of `input`; the vendored parser reads them from `instructions`.
  assert.equal(rawBody(parsed).instructions, "Be terse.");
  assert.equal(rawBody(parsed).model, parsed.modelId);
});

test("only the last user item carries the current-turn passthrough id", () => {
  const parsed = buildParsedRequest({
    route,
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ],
    stream: true,
  });
  const items = inputItems(parsed);
  const turnId = turnMetadata(parsed).turn_id;
  assert.equal(passthroughTurnId(items[0]), undefined);
  assert.equal(passthroughTurnId(items[1]), undefined);
  assert.equal(passthroughTurnId(items[2]), turnId);
});

test("a trailing assistant turn leaves the marker on the last USER item", () => {
  const parsed = buildParsedRequest({
    route,
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ],
    stream: true,
  });
  const items = inputItems(parsed);
  const turnId = turnMetadata(parsed).turn_id;
  assert.equal(passthroughTurnId(items[0]), turnId);
  assert.equal(passthroughTurnId(items[1]), undefined);
});

test("every request gets its own thread id and turn id", () => {
  const first = turnMetadata(
    buildParsedRequest({ route, messages: [{ role: "user", content: "Hi" }], stream: true })
  );
  const second = turnMetadata(
    buildParsedRequest({ route, messages: [{ role: "user", content: "Hi" }], stream: true })
  );
  assert.notEqual(first.thread_id, second.thread_id);
  assert.notEqual(first.turn_id, second.turn_id);
});
