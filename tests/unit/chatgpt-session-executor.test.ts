import { test } from "node:test";
import assert from "node:assert/strict";

import { ChatGptSessionExecutor } from "../../open-sse/executors/chatgpt-session.ts";
import { __setChatGptSessionRuntimeForTesting } from "../../open-sse/executors/chatgpt-session/runtime.ts";
import type { AdapterEvent } from "../../open-sse/vendor/codex-chatgpt-web/types.ts";

const CREDENTIALS = {
  connectionId: "conn-1",
  apiKey: JSON.stringify({ version: 2, storageState: { cookies: [], origins: [] } }),
  providerSpecificData: { solAvailable: true, proAvailable: false, browserVerified: true },
};

function stubRuntime(events: AdapterEvent[], overrides: Record<string, unknown> = {}) {
  __setChatGptSessionRuntimeForTesting({
    detectChrome: () => "/usr/bin/chromium",
    ensureStorageState: () => "/tmp/state.json",
    readStorageState: () => ({ cookies: [], origins: [] }),
    loginStateExists: () => true,
    inspectLogin: async () => ({ solAvailable: true, proAvailable: false }),
    runTurn: async (_parsed, _incoming, emit) => {
      for (const event of events) emit(event);
    },
    ...overrides,
  });
}

function body(extra: Record<string, unknown> = {}) {
  return { messages: [{ role: "user", content: "Hi" }], ...extra };
}

test.afterEach(() => {
  __setChatGptSessionRuntimeForTesting(null);
});

test("returns a streaming completion for a normal turn", async () => {
  stubRuntime([{ type: "text_delta", text: "Hello" }, { type: "done" }]);
  const result = await new ChatGptSessionExecutor().execute({
    model: "high",
    body: body(),
    stream: true,
    credentials: CREDENTIALS,
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
  const text = await response.text();
  assert.match(text, /"content":"Hello"/);
});

test("returns a buffered completion when stream is false", async () => {
  stubRuntime([{ type: "text_delta", text: "Hello" }, { type: "done" }]);
  const result = await new ChatGptSessionExecutor().execute({
    model: "high",
    body: body(),
    stream: false,
    credentials: CREDENTIALS,
  });
  const response = "response" in result ? result.response : result;
  const json = (await response.json()) as Record<string, unknown>;
  assert.equal(json.object, "chat.completion");
  assert.equal(
    ((json.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>)
      .content,
    "Hello"
  );
});

test("answers 503 with a cooldown hint when no browser is installed", async () => {
  stubRuntime([], { detectChrome: () => undefined });
  const result = await new ChatGptSessionExecutor().execute({
    model: "high",
    body: body(),
    stream: true,
    credentials: CREDENTIALS,
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("X-Omni-Fallback-Hint"), "connection_cooldown");
});

test("answers 401 when the connection has no credentials", async () => {
  stubRuntime([]);
  const result = await new ChatGptSessionExecutor().execute({
    model: "high",
    body: body(),
    stream: true,
    credentials: { connectionId: "conn-1" },
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 401);
});

test("rejects a Pro route on a non-Pro account without touching the browser", async () => {
  let ran = false;
  stubRuntime([], {
    runTurn: async () => {
      ran = true;
    },
  });
  const result = await new ChatGptSessionExecutor().execute({
    model: "pro",
    body: body(),
    stream: true,
    credentials: CREDENTIALS,
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 400);
  assert.equal(ran, false);
});

test("an expired session before output becomes a 401, not a 200 stream", async () => {
  stubRuntime([{ type: "error", message: "ChatGPT page is not authenticated" }]);
  const result = await new ChatGptSessionExecutor().execute({
    model: "high",
    body: body(),
    stream: true,
    credentials: CREDENTIALS,
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 401);
  const json = (await response.json()) as { error: { message: string } };
  assert.doesNotMatch(json.error.message, /at \//);
});

test("persists rotated storage state through onCredentialsRefreshed", async () => {
  stubRuntime([{ type: "text_delta", text: "x" }, { type: "done" }], {
    readStorageState: () => ({ cookies: [{ name: "rotated" }], origins: [] }),
  });
  const patches: Array<Record<string, unknown>> = [];
  const result = await new ChatGptSessionExecutor().execute({
    model: "high",
    body: body(),
    stream: false,
    credentials: CREDENTIALS,
    onCredentialsRefreshed: async (patch) => {
      patches.push(patch);
    },
  });
  const response = "response" in result ? result.response : result;
  await response.text();
  const persisted = patches.find((patch) => typeof patch.apiKey === "string");
  assert.ok(persisted, "expected an apiKey patch");
  assert.match(String(persisted.apiKey), /rotated/);
});

test("emulated tool calls go through the shared web-tools contract", async () => {
  stubRuntime([
    { type: "text_delta", text: '<tool>{"name": "get_time", "arguments": {}}</tool>' },
    { type: "done" },
  ]);
  const result = await new ChatGptSessionExecutor().execute({
    model: "high",
    body: body({
      tools: [
        {
          type: "function",
          function: { name: "get_time", description: "time", parameters: { type: "object" } },
        },
      ],
    }),
    stream: false,
    credentials: CREDENTIALS,
  });
  const response = "response" in result ? result.response : result;
  const json = (await response.json()) as Record<string, unknown>;
  const choice = (json.choices as Array<Record<string, unknown>>)[0];
  assert.equal(choice.finish_reason, "tool_calls");
});

test("forwards the abort signal to the adapter", async () => {
  let seenSignal: AbortSignal | undefined;
  stubRuntime([{ type: "done" }], {
    runTurn: async (
      _parsed: unknown,
      incoming: { abortSignal?: AbortSignal },
      emit: (e: AdapterEvent) => void
    ) => {
      seenSignal = incoming.abortSignal;
      emit({ type: "done" });
    },
  });
  const controller = new AbortController();
  const result = await new ChatGptSessionExecutor().execute({
    model: "high",
    body: body(),
    stream: false,
    credentials: CREDENTIALS,
    signal: controller.signal,
  });
  const response = "response" in result ? result.response : result;
  await response.text();
  assert.equal(seenSignal, controller.signal);
});
