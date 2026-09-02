/**
 * Pure translation from an OpenAI chat-completions message list into the synthetic
 * CodexParsedRequest the vendored browser adapter consumes.
 *
 * Tools are deliberately never placed in `context.tools`: this provider uses the shared
 * prompt-emulated tool contract (translator/webTools.ts), so the adapter must not try to
 * attach the turn-bound Codex connector capability.
 *
 * `_rawBody` is SYNTHESIZED here, never passed through from the OpenAI request. The vendored
 * adapter reads `_rawBody` as a native Codex *Responses* body and refuses to run a turn without
 * turn identity in it — an OpenAI chat-completions body makes every request fail with
 * "ChatGPT web requires native Codex turn_id metadata for browser-session replay" before any
 * browser work starts. Three things are load-bearing (see
 * vendor/codex-chatgpt-web/adapters/chatgpt-web/environment.ts):
 *   1. `client_metadata["x-codex-turn-metadata"]` carrying `thread_id` / `turn_id`
 *      (`clientTurnMetadata`),
 *   2. `input` as an array of Responses items (`latestChatGptTurnUserRevision`,
 *      `chatGptTurnRoundKey`, the Luna rolling checkpoint),
 *   3. `internal_chat_message_metadata_passthrough.turn_id` on the CURRENT user item
 *      (`itemTurnId`).
 * This provider serves stateless chat completions, so a fresh thread/turn pair per request is
 * the truthful identity: every request genuinely is its own turn.
 */

import { randomUUID } from "node:crypto";

import type {
  CodexMessage,
  CodexParsedRequest,
  CodexTextContent,
} from "../../vendor/codex-chatgpt-web/types.ts";
import type { ChatGptSessionRoute } from "./models.ts";

export class ChatGptSessionInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ChatGptSessionInputError";
    this.code = code;
  }
}

interface OpenAiMessage {
  role: string;
  content: unknown;
}

/**
 * One Responses-shaped `input` item. Only the fields the vendored adapter actually reads are
 * emitted: `type`/`role`/`content[].text` (`rawMessageText`, `inputContentParts`) and the
 * current-turn marker (`itemTurnId`).
 */
interface ResponsesInputItem {
  type: "message";
  role: "user" | "assistant";
  content: Array<{ type: "input_text" | "output_text"; text: string }>;
  internal_chat_message_metadata_passthrough?: { turn_id: string };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const part of content) {
    const typed =
      part && typeof part === "object" && !Array.isArray(part)
        ? (part as Record<string, unknown>)
        : null;
    if (typed && typed.type === "text" && typeof typed.text === "string") {
      chunks.push(typed.text);
      continue;
    }
    // `{ type: "refusal", refusal: "…" }` is a legal ASSISTANT content part in the
    // chat-completions spec, and a client replaying its own conversation history sends it back
    // verbatim. It is text as far as the adapter is concerned. A `refusal` part whose payload is
    // missing or not a string falls through to the rejection below rather than being dropped.
    if (typed && typed.type === "refusal" && typeof typed.refusal === "string") {
      chunks.push(typed.refusal);
      continue;
    }
    if (typed && (typed.type === "image_url" || typed.type === "image")) {
      throw new ChatGptSessionInputError(
        "vision_unsupported",
        "ChatGPT Session does not accept image input yet"
      );
    }
    // Every other part — file, input_audio, a future part type, or anything malformed — would
    // otherwise be dropped in silence, and the model would answer about content it never
    // received. Reject loudly instead.
    throw new ChatGptSessionInputError(
      "unsupported_content_part",
      "ChatGPT Session does not accept this message content part type"
    );
  }
  return chunks.join("\n");
}

function assistantParts(content: unknown): CodexTextContent[] {
  const text = textFromContent(content);
  return text ? [{ type: "text", text }] : [];
}

export function buildParsedRequest(input: {
  route: ChatGptSessionRoute;
  messages: ReadonlyArray<OpenAiMessage>;
  stream: boolean;
}): CodexParsedRequest {
  const systemPrompt: string[] = [];
  const messages: CodexMessage[] = [];
  const inputItems: ResponsesInputItem[] = [];
  let lastUserItem = -1;

  for (const message of input.messages) {
    const role = typeof message.role === "string" ? message.role : "";
    if (role === "system" || role === "developer") {
      const text = textFromContent(message.content);
      if (text) systemPrompt.push(text);
      continue;
    }
    if (role === "assistant") {
      const content = assistantParts(message.content);
      if (content.length > 0) {
        messages.push({ role: "assistant", content, timestamp: Date.now() });
        inputItems.push({
          type: "message",
          role: "assistant",
          content: content.map((part) => ({ type: "output_text", text: part.text })),
        });
      }
      continue;
    }
    if (role === "user" || role === "tool" || role === "function") {
      const text = textFromContent(message.content);
      if (!text) continue;
      messages.push({ role: "user", content: text, timestamp: Date.now() });
      lastUserItem = inputItems.length;
      inputItems.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      });
    }
  }

  if (lastUserItem < 0) {
    throw new ChatGptSessionInputError(
      "no_user_message",
      "ChatGPT Session requires at least one user message"
    );
  }

  const threadId = `thread_omniroute_${randomUUID()}`;
  const turnId = `turn_omniroute_${randomUUID()}`;
  // Only the LAST user item is the current turn. Marking an earlier one would make the adapter
  // replay stale history as the live instruction.
  inputItems[lastUserItem] = {
    ...inputItems[lastUserItem]!,
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };

  return {
    modelId: input.route.backendModel,
    context: {
      ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
      messages,
    },
    stream: input.stream,
    options: { reasoning: input.route.effort },
    _rawBody: {
      model: input.route.backendModel,
      // The adapter's Luna checkpoint path re-parses `_rawBody` through the vendored Responses
      // parser, which reads system prompts from `instructions` — keep the two representations
      // equivalent so a re-parse reproduces this same context.
      ...(systemPrompt.length > 0 ? { instructions: systemPrompt.join("\n") } : {}),
      input: inputItems,
      // The real Codex client sends this metadata as a JSON string; the vendor accepts a plain
      // object too, but matching the client's wire shape keeps us on the path the vendor's own
      // tests and future tightening cover.
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
    },
  };
}
