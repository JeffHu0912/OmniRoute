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

test("keeps the bridge's own status when a first-event error is not message-classifiable", async () => {
  // A Playwright TimeoutError is classified by `name`/`status`, not by its message. Re-deriving
  // the class from the message alone would fall through to 502 and trip the provider breaker.
  stubRuntime([
    {
      type: "error",
      message: "locator.click: Target closed",
      status: 400,
      code: "browser_ui_timeout",
    } as AdapterEvent,
  ]);
  const result = await new ChatGptSessionExecutor().execute({
    model: "high",
    body: body(),
    stream: true,
    credentials: CREDENTIALS,
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 400);
  const json = (await response.json()) as { error: { code: string } };
  assert.equal(json.error.code, "browser_ui_timeout");
});

test(
  "closes the event queue even when persisting state and its logger both throw",
  { timeout: 5000 },
  async () => {
    stubRuntime([{ type: "text_delta", text: "Hello" }, { type: "done" }], {
      readStorageState: () => {
        throw new Error("storage state is unreadable");
      },
    });
    const result = await new ChatGptSessionExecutor().execute({
      model: "high",
      body: body(),
      stream: false,
      credentials: CREDENTIALS,
      log: {
        warn: () => {
          throw new Error("logger exploded");
        },
      },
    });
    const response = "response" in result ? result.response : result;
    assert.ok(response instanceof Response);
    assert.equal(typeof response.status, "number");
  }
);

test("replays emulated tool calls as an SSE stream when the client asked to stream", async () => {
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
    stream: true,
    credentials: CREDENTIALS,
  });
  const response = "response" in result ? result.response : result;
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /"tool_calls"/);
  assert.match(text, /get_time/);
  assert.match(text, /"finish_reason":"tool_calls"/);
});

test("skips the tool-mode replay when the buffered turn did not return 200", async () => {
  stubRuntime([{ type: "error", message: "ChatGPT page is not authenticated" }]);
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
  assert.equal(response.status, 401);
  const json = (await response.json()) as Record<string, unknown>;
  assert.ok(json.error, "expected the error body to survive the tool-mode path");
  assert.equal(json.choices, undefined);
});
