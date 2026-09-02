/**
 * Pure translation from an OpenAI chat-completions message list into the synthetic
 * CodexParsedRequest the vendored browser adapter consumes.
 *
 * Tools are deliberately never placed in `context.tools`: this provider uses the shared
 * prompt-emulated tool contract (translator/webTools.ts), so the adapter must not try to
 * attach the turn-bound Codex connector capability.
 */

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

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const typed = part as Record<string, unknown>;
    if (typed.type === "text" && typeof typed.text === "string") {
      chunks.push(typed.text);
      continue;
    }
    if (typed.type === "image_url" || typed.type === "image") {
      throw new ChatGptSessionInputError(
        "vision_unsupported",
        "ChatGPT Session does not accept image input yet"
      );
    }
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
  rawBody?: unknown;
}): CodexParsedRequest {
  const systemPrompt: string[] = [];
  const messages: CodexMessage[] = [];
  let sawUser = false;

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
      }
      continue;
    }
    if (role === "user" || role === "tool" || role === "function") {
      const text = textFromContent(message.content);
      if (!text) continue;
      messages.push({ role: "user", content: text, timestamp: Date.now() });
      sawUser = true;
    }
  }

  if (!sawUser) {
    throw new ChatGptSessionInputError(
      "no_user_message",
      "ChatGPT Session requires at least one user message"
    );
  }

  return {
    modelId: input.route.backendModel,
    context: {
      ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
      messages,
    },
    stream: input.stream,
    options: { reasoning: input.route.effort },
    ...(input.rawBody !== undefined ? { _rawBody: input.rawBody } : {}),
  };
}
