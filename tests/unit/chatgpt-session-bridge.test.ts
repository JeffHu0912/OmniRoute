import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHATGPT_SESSION_STREAM_OPEN_TIMEOUT_MS,
  buildChatGptSessionCompletion,
  openChatGptSessionStream,
  resolveChatGptSessionStreamOpenTimeoutMs,
} from "../../open-sse/executors/chatgpt-session/bridge.ts";
import type { AdapterEvent } from "../../open-sse/vendor/codex-chatgpt-web/types.ts";

const META = { cid: "chatcmpl-test", created: 1_700_000_000, model: "chatgpt-session/high" };

async function* iterate(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    out += decoder.decode(chunk, { stream: true });
  }
  return out + decoder.decode();
}

test("streams role, content and a terminal stop chunk", async () => {
  const opened = await openChatGptSessionStream(
    iterate([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 2 } },
    ]),
    META
  );
  assert.equal(opened.kind, "stream");
  const text = await readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  assert.match(text, /"delta":\{"role":"assistant"\}/);
  assert.match(text, /"content":"Hel"/);
  assert.match(text, /"content":"lo"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /"prompt_tokens":10/);
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
});

test("thinking deltas surface as reasoning_content", async () => {
  const opened = await openChatGptSessionStream(
    iterate([
      { type: "thinking_delta", thinking: "hmm" },
      { type: "text_delta", text: "ok" },
      { type: "done" },
    ]),
    META
  );
  const text = await readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  assert.match(text, /"reasoning_content":"hmm"/);
});

test("heartbeats become SSE comments, never data chunks", async () => {
  const opened = await openChatGptSessionStream(
    iterate([{ type: "text_delta", text: "x" }, { type: "heartbeat" }, { type: "done" }]),
    META
  );
  const text = await readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  assert.match(text, /^: keepalive$/m);
  assert.doesNotMatch(text, /"heartbeat"/);
});

test("an error before any output returns an error verdict instead of a stream", async () => {
  const opened = await openChatGptSessionStream(
    iterate([{ type: "error", message: "ChatGPT page is not authenticated" }]),
    META
  );
  assert.equal(opened.kind, "error");
  assert.equal((opened as { status: number }).status, 401);
  assert.equal((opened as { code: string }).code, "session_expired");
});

test("an error verdict message is sanitized before it leaves the bridge", async () => {
  const opened = await openChatGptSessionStream(
    iterate([
      {
        type: "error",
        message: "not authenticated\n    at /app/open-sse/x.ts:1:1",
      },
    ]),
    META
  );
  assert.equal(opened.kind, "error");
  assert.doesNotMatch((opened as { message: string }).message, /at \//);
});

test("an error mid-stream terminates the stream after the emitted text", async () => {
  const opened = await openChatGptSessionStream(
    iterate([
      { type: "text_delta", text: "partial" },
      { type: "error", message: "boom", status: 502 },
    ]),
    META
  );
  assert.equal(opened.kind, "stream");
  const text = await readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  assert.match(text, /"content":"partial"/);
  assert.match(text, /"error"/);
  assert.match(text, /"message":"boom"/);
  assert.match(text, /"code":"turn_failed"/);
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
  const doneCount = text.split("data: [DONE]").length - 1;
  assert.equal(doneCount, 1);
});

test("incomplete maps to a length finish reason", async () => {
  const opened = await openChatGptSessionStream(
    iterate([
      { type: "text_delta", text: "x" },
      { type: "incomplete", reason: "max_output" },
    ]),
    META
  );
  const text = await readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  assert.match(text, /"finish_reason":"length"/);
});

test("a terminal event as the first meaningful event is replayed, not dropped", async () => {
  const opened = await openChatGptSessionStream(
    iterate([{ type: "done", usage: { inputTokens: 1, outputTokens: 1 } }]),
    META
  );
  assert.equal(opened.kind, "stream");
  const text = await readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  assert.match(text, /"delta":\{"role":"assistant"\}/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
});

test("a source that ends with no terminal event still emits a synthetic stop", async () => {
  const opened = await openChatGptSessionStream(iterate([{ type: "text_delta", text: "x" }]), META);
  assert.equal(opened.kind, "stream");
  const text = await readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  assert.match(text, /"content":"x"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
});

test("an empty source still opens a stream with role and a synthetic stop", async () => {
  const opened = await openChatGptSessionStream(iterate([]), META);
  assert.equal(opened.kind, "stream");
  const text = await readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  assert.match(text, /"delta":\{"role":"assistant"\}/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
});

test("a heartbeat-only source still opens a stream and never leaks the heartbeat type", async () => {
  const opened = await openChatGptSessionStream(
    iterate([{ type: "heartbeat" }, { type: "heartbeat" }]),
    META
  );
  assert.equal(opened.kind, "stream");
  const text = await readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  assert.match(text, /"delta":\{"role":"assistant"\}/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
  assert.doesNotMatch(text, /"heartbeat"/);
});

test("incomplete with endTurn true maps to a stop finish reason", async () => {
  const opened = await openChatGptSessionStream(
    iterate([
      { type: "text_delta", text: "x" },
      { type: "incomplete", reason: "x", endTurn: true },
    ]),
    META
  );
  const text = await readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  assert.match(text, /"finish_reason":"stop"/);
  assert.doesNotMatch(text, /"finish_reason":"length"/);
});

test("buffered completion collects content, reasoning and usage", () => {
  const result = buildChatGptSessionCompletion(
    [
      { type: "thinking_delta", thinking: "think" },
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "done", usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } },
    ],
    META
  );
  assert.equal(result.status, 200);
  const choice = (result.body.choices as Array<Record<string, unknown>>)[0];
  const message = choice.message as Record<string, unknown>;
  assert.equal(message.content, "Hello world");
  assert.equal(message.reasoning_content, "think");
  assert.equal(choice.finish_reason, "stop");
  assert.deepEqual(result.body.usage, {
    prompt_tokens: 7,
    completion_tokens: 3,
    total_tokens: 10,
  });
});

test("buffered completion surfaces an error event as a classified status", () => {
  const result = buildChatGptSessionCompletion(
    [{ type: "error", message: "ChatGPT reported a usage limit" }],
    META
  );
  assert.equal(result.status, 429);
});

test("buffered error bodies never leak a stack trace", () => {
  const result = buildChatGptSessionCompletion(
    [{ type: "error", message: "failure\n    at /app/open-sse/x.ts:1:1" }],
    META
  );
  const error = result.body.error as Record<string, unknown>;
  assert.doesNotMatch(String(error.message), /at \//);
  assert.match(String(error.message), /failure/);
});

test("the commentary read-only banner never reaches streamed content", async () => {
  const opened = await openChatGptSessionStream(
    iterate([
      { type: "assistant_boundary" },
      {
        type: "text_delta",
        text: "⚠️ The local Codex computer is unavailable, so this turn is read-only.",
        phase: "commentary",
      },
      { type: "assistant_boundary" },
      { type: "text_delta", text: "real answer" },
      { type: "done" },
    ]),
    META
  );
  assert.equal(opened.kind, "stream");
  const text = await readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  const content = [...text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => JSON.parse(`"${match[1]}"`) as string)
    .join("");
  assert.equal(content, "real answer");
  assert.doesNotMatch(text, /read-only/);
  assert.doesNotMatch(text, /Codex computer/);
  // Commentary must not be laundered into reasoning either — it is transport chatter.
  assert.doesNotMatch(text, /"reasoning_content"/);
});

test("the commentary read-only banner never reaches buffered content", () => {
  const result = buildChatGptSessionCompletion(
    [
      { type: "assistant_boundary" },
      {
        type: "text_delta",
        text: "⚠️ The local Codex computer is unavailable, so this turn is read-only.",
        phase: "commentary",
      },
      { type: "assistant_boundary" },
      { type: "text_delta", text: "real answer" },
      { type: "done" },
    ],
    META
  );
  assert.equal(result.status, 200);
  const message = (result.body.choices as Array<Record<string, unknown>>)[0].message as Record<
    string,
    unknown
  >;
  assert.equal(message.content, "real answer");
  assert.equal("reasoning_content" in message, false);
  assert.doesNotMatch(JSON.stringify(result.body), /read-only/);
});

// I1 — the streaming gate and the buffered failover must agree on what counts as committed
// output. Reasoning alone commits neither, so a failure right after a thinking delta is a real
// HTTP status on BOTH paths instead of a 200 stream carrying an in-band error chunk.
test("reasoning before an error does not commit a 200 on the streaming path", async () => {
  const opened = await openChatGptSessionStream(
    iterate([
      { type: "thinking_delta", thinking: "weighing options" },
      { type: "error", message: "ChatGPT reported a usage limit", status: 429 },
    ]),
    META
  );
  assert.equal(opened.kind, "error");
  assert.equal((opened as { status: number }).status, 429);
});

test("the buffered path returns the same status for reasoning followed by an error", () => {
  const result = buildChatGptSessionCompletion(
    [
      { type: "thinking_delta", thinking: "weighing options" },
      { type: "error", message: "ChatGPT reported a usage limit", status: 429 },
    ],
    META
  );
  assert.equal(result.status, 429);
});

test("reasoning buffered behind the gate is still streamed once the gate opens", async () => {
  const opened = await openChatGptSessionStream(
    iterate([
      { type: "thinking_delta", thinking: "first" },
      { type: "thinking_delta", thinking: "second" },
      { type: "text_delta", text: "answer" },
      { type: "done" },
    ]),
    META
  );
  assert.equal(opened.kind, "stream");
  const text = await readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  assert.match(text, /"reasoning_content":"first"/);
  assert.match(text, /"reasoning_content":"second"/);
  assert.match(text, /"content":"answer"/);
});

test("an empty text delta does not commit a 200 ahead of an error", async () => {
  const opened = await openChatGptSessionStream(
    iterate([
      { type: "text_delta", text: "" },
      { type: "error", message: "ChatGPT reported a usage limit" },
    ]),
    META
  );
  assert.equal(opened.kind, "error");
  assert.equal((opened as { status: number }).status, 429);
});

test("a cooldown-hinted classification reaches the stream-open error verdict", async () => {
  const opened = await openChatGptSessionStream(
    iterate([{ type: "error", message: "upstream unavailable", status: 503 }]),
    META
  );
  assert.equal(opened.kind, "error");
  assert.equal((opened as { fallbackHint?: string }).fallbackHint, "connection_cooldown");
});

// I2 — the gate must be bounded: while it is closed the client receives nothing at all (any byte
// commits the 200), so a healthy turn that thinks for a long time in the browser would otherwise
// look dead to a client with an idle timeout.
interface ControllableSource {
  events: AsyncIterable<AdapterEvent>;
  push(event: AdapterEvent): void;
  end(): void;
}

function controllable(): ControllableSource {
  const queued: AdapterEvent[] = [];
  const waiting: Array<(result: IteratorResult<AdapterEvent>) => void> = [];
  let ended = false;
  const iterator: AsyncIterator<AdapterEvent> = {
    next() {
      const event = queued.shift();
      if (event) return Promise.resolve({ value: event, done: false });
      if (ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
  return {
    events: { [Symbol.asyncIterator]: () => iterator },
    push(event) {
      const waiter = waiting.shift();
      if (waiter) waiter({ value: event, done: false });
      else queued.push(event);
    },
    end() {
      ended = true;
      for (const waiter of waiting.splice(0)) waiter({ value: undefined, done: true });
    },
  };
}

test("the default stream-open deadline stays at 30s", () => {
  assert.equal(CHATGPT_SESSION_STREAM_OPEN_TIMEOUT_MS, 30_000);
});

test("a silent turn opens the stream once the gate deadline elapses", async () => {
  const source = controllable();
  const opened = await openChatGptSessionStream(source.events, META, {
    streamOpenTimeoutMs: 5,
  });
  assert.equal(opened.kind, "stream");
  const reading = readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  source.push({ type: "heartbeat" });
  source.push({ type: "text_delta", text: "late answer" });
  source.push({ type: "done" });
  source.end();
  const text = await reading;
  assert.match(text, /"delta":\{"role":"assistant"\}/);
  assert.match(text, /"content":"late answer"/);
  assert.match(text, /"finish_reason":"stop"/);
  // The role chunk still leads, and heartbeats keep flowing as SSE comments once the gate opened.
  assert.ok(text.indexOf('"role":"assistant"') < text.indexOf('"content":"late answer"'));
  assert.match(text, /^: keepalive$/m);
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
});

test("reasoning buffered before the deadline is replayed in order after the gate opens", async () => {
  const source = controllable();
  source.push({ type: "thinking_delta", thinking: "first" });
  source.push({ type: "thinking_delta", thinking: "second" });
  const opened = await openChatGptSessionStream(source.events, META, {
    streamOpenTimeoutMs: 5,
  });
  assert.equal(opened.kind, "stream");
  const reading = readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  source.push({ type: "text_delta", text: "answer" });
  source.push({ type: "done" });
  source.end();
  const text = await reading;
  const roleAt = text.indexOf('"role":"assistant"');
  const firstAt = text.indexOf('"reasoning_content":"first"');
  const secondAt = text.indexOf('"reasoning_content":"second"');
  const answerAt = text.indexOf('"content":"answer"');
  assert.ok(roleAt >= 0 && firstAt > roleAt && secondAt > firstAt && answerAt > secondAt);
});

test("an error before the deadline still returns an error verdict, never a timed-out stream", async () => {
  const source = controllable();
  const opening = openChatGptSessionStream(source.events, META, {
    streamOpenTimeoutMs: 1_000,
  });
  source.push({ type: "error", message: "ChatGPT reported a usage limit" });
  const opened = await opening;
  assert.equal(opened.kind, "error");
  assert.equal((opened as { status: number }).status, 429);
});

test("no event is lost to the deadline race", async () => {
  const source = controllable();
  const opened = await openChatGptSessionStream(source.events, META, {
    streamOpenTimeoutMs: 5,
  });
  const reading = readAll((opened as { stream: ReadableStream<Uint8Array> }).stream);
  source.push({ type: "text_delta", text: "one" });
  source.push({ type: "text_delta", text: "two" });
  source.push({ type: "done" });
  source.end();
  const text = await reading;
  assert.match(text, /"content":"one"/);
  assert.match(text, /"content":"two"/);
});

const STREAM_OPEN_TIMEOUT_ENV_VAR = "OMNIROUTE_CHATGPT_SESSION_STREAM_OPEN_TIMEOUT_MS";

function withStreamOpenTimeoutEnv(raw: string | undefined, run: () => void): void {
  const saved = process.env[STREAM_OPEN_TIMEOUT_ENV_VAR];
  if (raw === undefined) delete process.env[STREAM_OPEN_TIMEOUT_ENV_VAR];
  else process.env[STREAM_OPEN_TIMEOUT_ENV_VAR] = raw;
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env[STREAM_OPEN_TIMEOUT_ENV_VAR];
    else process.env[STREAM_OPEN_TIMEOUT_ENV_VAR] = saved;
  }
}

test("resolveChatGptSessionStreamOpenTimeoutMs falls back to the default when the env var is unset", () => {
  withStreamOpenTimeoutEnv(undefined, () => {
    assert.equal(
      resolveChatGptSessionStreamOpenTimeoutMs(),
      CHATGPT_SESSION_STREAM_OPEN_TIMEOUT_MS
    );
  });
});

test("resolveChatGptSessionStreamOpenTimeoutMs honors a valid positive integer", () => {
  withStreamOpenTimeoutEnv("45000", () => {
    assert.equal(resolveChatGptSessionStreamOpenTimeoutMs(), 45_000);
  });
});

const INVALID_STREAM_OPEN_TIMEOUT_INPUTS: Array<[label: string, raw: string]> = [
  ["an empty string", ""],
  ["non-numeric text", "not-a-number"],
  ["zero", "0"],
  ["a negative number", "-10"],
  ["a non-finite value", "Infinity"],
];

for (const [label, raw] of INVALID_STREAM_OPEN_TIMEOUT_INPUTS) {
  test(`resolveChatGptSessionStreamOpenTimeoutMs falls back to the default for ${label}`, () => {
    withStreamOpenTimeoutEnv(raw, () => {
      assert.equal(
        resolveChatGptSessionStreamOpenTimeoutMs(),
        CHATGPT_SESSION_STREAM_OPEN_TIMEOUT_MS
      );
    });
  });
}
