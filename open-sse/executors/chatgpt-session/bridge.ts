/**
 * Bridges the vendored adapter's event stream into OpenAI chat-completions payloads.
 *
 * Stream opening is gated on the first event that would ALSO count as committed output on the
 * buffered path, so a turn that fails before producing any assistant content can still be
 * answered with a real HTTP status instead of a 200 stream carrying an error chunk. The gate and
 * `buildChatGptSessionCompletion` must agree on what "output" means — transport framing
 * (heartbeats, assistant boundaries), commentary-phase text, empty text deltas and reasoning are
 * all non-committing on both paths. Once real content has been emitted the status line is
 * already committed, so a later failure just closes the stream cleanly.
 */

import { buildErrorBody, sanitizeErrorMessage } from "../../utils/error.ts";
import { formatTranslatedStreamError } from "../../utils/streamErrorFormat.ts";
import type {
  AdapterEvent,
  CodexMessagePhase,
  CodexUsage,
} from "../../vendor/codex-chatgpt-web/types.ts";
import { classifyChatGptSessionError } from "./errors.ts";

export interface ChatGptSessionResponseMeta {
  cid: string;
  created: number;
  model: string;
}

export type ChatGptSessionStreamOpen =
  | {
      kind: "error";
      status: number;
      code: string;
      message: string;
      fallbackHint?: "connection_cooldown";
    }
  | { kind: "stream"; stream: ReadableStream<Uint8Array> };

/**
 * The adapter tags its own transport chatter with the commentary phase — most visibly the
 * "local Codex computer is unavailable" banner it emits on every fresh turn while
 * `localToolsEnabled` is false, which is this provider's permanent configuration. It is not
 * model output and it is not model reasoning, so it never reaches the client on either path.
 */
const COMMENTARY_PHASE: CodexMessagePhase = "commentary";

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
  // Reasoning that arrives while the gate is still closed is real output the client must
  // receive; it just may not commit the status line, because the buffered path fails over on
  // absent CONTENT regardless of how much reasoning preceded it.
  const bufferedReasoning: AdapterEvent[] = [];
  let first: AdapterEvent | null = null;

  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    const event = next.value;
    if (event.type === "heartbeat" || event.type === "assistant_boundary") continue;
    if (event.type === "text_delta" && (!event.text || event.phase === COMMENTARY_PHASE)) continue;
    if (event.type === "thinking_delta") {
      bufferedReasoning.push(event);
      continue;
    }
    first = event;
    break;
  }

  if (first && first.type === "error") {
    const classified = classifyChatGptSessionError(first);
    return {
      kind: "error",
      status: classified.status,
      code: classified.code,
      message: sanitizeErrorMessage(first.message),
      ...(classified.fallbackHint ? { fallbackHint: classified.fallbackHint } : {}),
    };
  }

  const pending: AdapterEvent[] = first ? [...bufferedReasoning, first] : bufferedReasoning;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        const emit = (text: string) => controller.enqueue(encoder.encode(text));
        emit(chunk(meta, { role: "assistant" }, null));

        let terminatedWithError = false;

        const handle = (event: AdapterEvent): boolean => {
          switch (event.type) {
            case "heartbeat":
              emit(": keepalive\n\n");
              return true;
            case "text_delta":
              if (event.phase === COMMENTARY_PHASE) return true;
              if (event.text) emit(chunk(meta, { content: event.text }, null));
              return true;
            case "thinking_delta":
              if (event.thinking) emit(chunk(meta, { reasoning_content: event.thinking }, null));
              return true;
            case "assistant_boundary":
              // Internal framing between the adapter's guarded first pass and its one-shot
              // continuation (the vendor's Responses bridge only closes the open item here).
              // There is no chat-completions delta for it, and letting it reach `default` would
              // be indistinguishable from a real event we forgot to handle.
              return true;
            case "done":
              emit(chunk(meta, {}, "stop", mapUsage(event.usage)));
              return false;
            case "incomplete":
              emit(chunk(meta, {}, finishReasonFor(event), mapUsage(event.usage)));
              return false;
            case "error": {
              const classified = classifyChatGptSessionError(event);
              emit(
                formatTranslatedStreamError({
                  status: classified.status,
                  message: event.message,
                  code: classified.code,
                  type: classified.status >= 500 ? "provider_error" : "invalid_request_error",
                })
              );
              terminatedWithError = true;
              return false;
            }
            default:
              return true;
          }
        };

        try {
          let open = true;
          for (const event of pending) {
            open = handle(event);
            if (!open) break;
          }
          while (open) {
            const next = await iterator.next();
            if (next.done) {
              emit(chunk(meta, {}, "stop"));
              break;
            }
            open = handle(next.value);
          }
        } finally {
          if (!terminatedWithError) emit("data: [DONE]\n\n");
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
    if (event.type === "text_delta") {
      if (event.phase !== COMMENTARY_PHASE) content += event.text;
    } else if (event.type === "thinking_delta") reasoning += event.thinking;
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
