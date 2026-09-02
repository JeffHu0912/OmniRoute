/**
 * Bridges the vendored adapter's event stream into OpenAI chat-completions payloads.
 *
 * Stream opening is gated on the first meaningful event so a turn that fails before producing
 * any output can still be answered with a real HTTP status instead of a 200 stream carrying an
 * error chunk. Once any text has been emitted the status line is already committed, so a later
 * failure just closes the stream cleanly.
 */

import { buildErrorBody, sanitizeErrorMessage } from "../../utils/error.ts";
import type { AdapterEvent, CodexUsage } from "../../vendor/codex-chatgpt-web/types.ts";
import { classifyChatGptSessionError } from "./errors.ts";

export interface ChatGptSessionResponseMeta {
  cid: string;
  created: number;
  model: string;
}

export type ChatGptSessionStreamOpen =
  | { kind: "error"; status: number; code: string; message: string }
  | { kind: "stream"; stream: ReadableStream<Uint8Array> };

interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens: number };
}

function mapUsage(usage: CodexUsage | undefined): OpenAiUsage | undefined {
  if (!usage) return undefined;
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokens ?? prompt + completion,
    ...(typeof usage.reasoningOutputTokens === "number"
      ? { completion_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens } }
      : {}),
  };
}

function chunk(
  meta: ChatGptSessionResponseMeta,
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage?: OpenAiUsage
): string {
  const payload: Record<string, unknown> = {
    id: meta.cid,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) payload.usage = usage;
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function finishReasonFor(event: AdapterEvent): string {
  if (event.type === "incomplete") return event.endTurn ? "stop" : "length";
  return "stop";
}

export async function openChatGptSessionStream(
  events: AsyncIterable<AdapterEvent>,
  meta: ChatGptSessionResponseMeta
): Promise<ChatGptSessionStreamOpen> {
  const iterator = events[Symbol.asyncIterator]();
  let first: AdapterEvent | null = null;

  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    if (next.value.type === "heartbeat") continue;
    first = next.value;
    break;
  }

  if (first && first.type === "error") {
    const classified = classifyChatGptSessionError(first);
    return {
      kind: "error",
      status: classified.status,
      code: classified.code,
      message: first.message,
    };
  }

  const pending = first;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        const emit = (text: string) => controller.enqueue(encoder.encode(text));
        emit(chunk(meta, { role: "assistant" }, null));

        const handle = (event: AdapterEvent): boolean => {
          switch (event.type) {
            case "heartbeat":
              emit(": keepalive\n\n");
              return true;
            case "text_delta":
              if (event.text) emit(chunk(meta, { content: event.text }, null));
              return true;
            case "thinking_delta":
              if (event.thinking) emit(chunk(meta, { reasoning_content: event.thinking }, null));
              return true;
            case "done":
              emit(chunk(meta, {}, "stop", mapUsage(event.usage)));
              return false;
            case "incomplete":
              emit(chunk(meta, {}, finishReasonFor(event), mapUsage(event.usage)));
              return false;
            case "error":
              emit(chunk(meta, {}, "stop", mapUsage(event.usage)));
              return false;
            default:
              return true;
          }
        };

        try {
          let open = true;
          if (pending) open = handle(pending);
          while (open) {
            const next = await iterator.next();
            if (next.done) {
              emit(chunk(meta, {}, "stop"));
              break;
            }
            open = handle(next.value);
          }
        } finally {
          emit("data: [DONE]\n\n");
          controller.close();
        }
      },
      cancel() {
        void iterator.return?.();
      },
    },
    { highWaterMark: 16384 }
  );

  return { kind: "stream", stream };
}

export function buildChatGptSessionCompletion(
  events: readonly AdapterEvent[],
  meta: ChatGptSessionResponseMeta
): { status: number; body: Record<string, unknown> } {
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage: CodexUsage | undefined;
  let failure: AdapterEvent | null = null;

  for (const event of events) {
    if (event.type === "text_delta") content += event.text;
    else if (event.type === "thinking_delta") reasoning += event.thinking;
    else if (event.type === "done") usage = event.usage;
    else if (event.type === "incomplete") {
      usage = event.usage;
      finishReason = finishReasonFor(event);
    } else if (event.type === "error") {
      usage = event.usage ?? usage;
      failure = event;
    }
  }

  if (failure && failure.type === "error" && !content) {
    const classified = classifyChatGptSessionError(failure);
    return {
      status: classified.status,
      body: buildErrorBody(classified.status, sanitizeErrorMessage(failure.message), undefined, {
        type: classified.status >= 500 ? "provider_error" : "invalid_request_error",
        code: classified.code,
      }) as unknown as Record<string, unknown>,
    };
  }

  const message: Record<string, unknown> = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;

  return {
    status: 200,
    body: {
      id: meta.cid,
      object: "chat.completion",
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
      ...(mapUsage(usage) ? { usage: mapUsage(usage) } : {}),
    },
  };
}
