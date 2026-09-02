import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildChatGptSessionCompletion,
  openChatGptSessionStream,
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
