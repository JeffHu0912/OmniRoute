/**
 * ChatGptSessionExecutor — OpenAI chat completions over an authenticated ChatGPT browser
 * session.
 *
 * The vendored MIT browser adapter owns every anti-bot interaction (sentinel, turnstile,
 * proof-of-work) because a real signed-in browser performs them; this executor only translates
 * request and response shapes around it.
 */

import { CHATGPT_WEB_CODEX_CONNECTOR_NAME } from "@/shared/constants/chatgptWebCodex";

import { FORMATS } from "../translator/formats.ts";
import { prepareToolMessages } from "../translator/webTools.ts";
import { buildErrorBody, sanitizeErrorMessage } from "../utils/error.ts";
import { AsyncEventQueue } from "../vendor/codex-chatgpt-web/event-queue.ts";
import type { AdapterEvent, CodexProviderConfig } from "../vendor/codex-chatgpt-web/types.ts";
import { BaseExecutor, type ExecuteInput, type ExecutorExecuteResult } from "./base.ts";
import { buildToolModeResponse } from "./chatgptWebTools.ts";
import {
  decodeChatGptWebCodexSecrets,
  encodeChatGptWebCodexSecrets,
} from "./chatgpt-web-codex/credentials.ts";
import { connectionRuntimePaths } from "./chatgpt-web-codex/storageState.ts";
import {
  buildChatGptSessionCompletion,
  openChatGptSessionStream,
  resolveChatGptSessionStreamOpenTimeoutMs,
  type ChatGptSessionResponseMeta,
} from "./chatgpt-session/bridge.ts";
import { classifyChatGptSessionError } from "./chatgpt-session/errors.ts";
import { buildParsedRequest } from "./chatgpt-session/messages.ts";
import { requireChatGptSessionRoute, type ChatGptSessionRoute } from "./chatgpt-session/models.ts";
import {
  chatGptSessionRuntime,
  type ChatGptSessionLoginConfig,
} from "./chatgpt-session/runtime.ts";

const BASE_URL = "https://chatgpt.com";
const JSON_HEADERS = { "Content-Type": "application/json" };
const SSE_HEADERS = {
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "Content-Type": "text/event-stream; charset=utf-8",
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function configuredString(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * A caller-supplied logger is foreign code and may throw. It never gets to decide whether the
 * request is answered, so every warn goes through here.
 */
function warn(log: ExecuteInput["log"], message: unknown): void {
  try {
    log?.warn?.(
      "CHATGPT_SESSION",
      sanitizeErrorMessage(message instanceof Error ? message.message : message)
    );
  } catch {
    // A broken logger must not fail the turn.
  }
}

function wrapped(response: Response, body: unknown): ExecutorExecuteResult {
  return {
    response,
    url: BASE_URL,
    headers: {},
    transformedBody: body,
    transport: "chatgpt-session-browser",
  };
}

function errorResponse(
  status: number,
  message: unknown,
  code: string,
  fallbackHint?: "connection_cooldown"
): Response {
  return new Response(
    JSON.stringify(
      buildErrorBody(status, sanitizeErrorMessage(message), undefined, {
        type: status >= 500 ? "provider_error" : "invalid_request_error",
        code,
      })
    ),
    {
      status,
      headers: fallbackHint
        ? { ...JSON_HEADERS, "X-Omni-Fallback-Hint": fallbackHint }
        : JSON_HEADERS,
    }
  );
}

export function buildChatGptSessionProviderConfig(args: {
  route: ChatGptSessionRoute;
  connectionId: string;
  storageStatePath: string;
  connectorName: string;
  chromeExecutablePath?: string;
  cdpEndpoint?: string;
  solAvailable: boolean;
  proAvailable: boolean;
}): CodexProviderConfig {
  const paths = connectionRuntimePaths(args.connectionId);
  return {
    adapter: "chatgpt-web",
    baseUrl: BASE_URL,
    defaultModel: args.route.backendModel,
    models: [args.route.backendModel],
    chatgptWeb: {
      appName: args.connectorName,
      storageStatePath: args.storageStatePath,
      ...(args.chromeExecutablePath ? { chromeExecutablePath: args.chromeExecutablePath } : {}),
      ...(args.cdpEndpoint ? { cdpEndpoint: args.cdpEndpoint } : {}),
      brokerSocketPath: paths.brokerSocketPath,
      threadEnvironmentStatePath: paths.threadEnvironmentStatePath,
      lunaCheckpointStatePath: paths.lunaCheckpointStatePath,
      headed: true,
      // Prompt-emulated tools only: never attach the turn-bound Codex connector capability.
      localToolsEnabled: false,
      solAvailable: args.solAvailable,
      proAvailable: args.proAvailable,
      autoApproveToolCalls: false,
    },
  };
}

export class ChatGptSessionExecutor extends BaseExecutor {
  constructor() {
    super("chatgpt-session", {
      id: "chatgpt-session",
      baseUrl: BASE_URL,
      format: FORMATS.OPENAI,
    });
  }

  override async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    const runtime = chatGptSessionRuntime();
    const requestBody = record(input.body);

    try {
      const route = requireChatGptSessionRoute(input.model);

      const connectionId = input.credentials.connectionId?.trim();
      const encodedCredentials = input.credentials.apiKey?.trim();
      if (!connectionId || !encodedCredentials) {
        throw new Error("ChatGPT browser credentials are missing");
      }
      const secrets = decodeChatGptWebCodexSecrets(encodedCredentials);

      const providerData = record(input.credentials.providerSpecificData);
      const cdpEndpoint =
        configuredString(providerData, "browserCdpEndpoint") ??
        process.env.CHATGPT_WEB_CODEX_CDP_URL?.trim();
      const chromeExecutablePath = runtime.detectChrome(
        configuredString(providerData, "chromeExecutablePath")
      );
      if (!chromeExecutablePath && !cdpEndpoint) {
        throw new Error("No supported Chrome or Chromium executable was found");
      }

      const storageStatePath = runtime.ensureStorageState(connectionId, secrets);
      const connectorName =
        configuredString(providerData, "connectorName", "appName") ??
        CHATGPT_WEB_CODEX_CONNECTOR_NAME;

      const loginConfig: ChatGptSessionLoginConfig = {
        appName: connectorName,
        storageStatePath,
        headed: true,
        proAvailable: providerData.proAvailable === true,
        autoApproveToolCalls: false,
        ...(chromeExecutablePath ? { chromeExecutablePath } : {}),
        ...(cdpEndpoint ? { cdpEndpoint } : {}),
      };

      let solAvailable = providerData.solAvailable !== false;
      let proAvailable = providerData.proAvailable === true;
      if (!runtime.loginStateExists(loginConfig)) {
        const capabilities = await runtime.inspectLogin(loginConfig);
        solAvailable = capabilities.solAvailable;
        proAvailable = capabilities.proAvailable;
        await input.onCredentialsRefreshed?.({
          providerSpecificData: {
            ...providerData,
            solAvailable,
            proAvailable,
            browserVerified: true,
            ...(chromeExecutablePath ? { chromeExecutablePath } : {}),
            ...(cdpEndpoint ? { browserCdpEndpoint: cdpEndpoint } : {}),
          },
        });
      }

      if (route.sol !== solAvailable) {
        throw new Error(
          route.sol
            ? `${route.id} is not available for this Luna-only connection`
            : `${route.id} is not available while the account exposes the Sol model selector`
        );
      }
      if (route.pro && !proAvailable) {
        throw new Error(`${route.id} is not available for this non-Pro connection`);
      }

      const messages = Array.isArray(requestBody.messages)
        ? (requestBody.messages as Array<{ role: string; content: unknown }>)
        : [];
      const { hasTools, requestedTools, effectiveMessages } = prepareToolMessages(
        requestBody,
        messages
      );

      const parsed = buildParsedRequest({
        route,
        messages: effectiveMessages,
        stream: Boolean(input.stream) && !hasTools,
        rawBody: input.body,
      });

      const provider = buildChatGptSessionProviderConfig({
        route,
        connectionId,
        storageStatePath,
        connectorName,
        solAvailable,
        proAvailable,
        ...(chromeExecutablePath ? { chromeExecutablePath } : {}),
        ...(cdpEndpoint ? { cdpEndpoint } : {}),
      });

      const events = new AsyncEventQueue<AdapterEvent>();
      const incoming = {
        headers: new Headers(),
        ...(input.signal ? { abortSignal: input.signal } : {}),
      };

      const persistRotatedState = async () => {
        try {
          const storageState = runtime.readStorageState(storageStatePath);
          await input.onCredentialsRefreshed?.({
            apiKey: encodeChatGptWebCodexSecrets({
              storageState,
              ...(secrets.runtimeKey ? { runtimeKey: secrets.runtimeKey } : {}),
            }),
          });
        } catch (refreshError) {
          warn(input.log, refreshError);
        }
      };

      const run = async () => {
        try {
          await runtime.runTurn(parsed, incoming, (event) => events.push(event), provider);
        } catch (error) {
          const classified = classifyChatGptSessionError(error);
          events.push({
            type: "error",
            message: sanitizeErrorMessage(error instanceof Error ? error.message : error),
            status: classified.status,
            code: classified.code,
          });
        } finally {
          // The close MUST happen even if persisting (or a caller-supplied logger inside its
          // catch) throws: without it `events.collect()` and the streaming consumer both wait
          // on a queue that is never closed, and the streaming path — started as `void run()` —
          // turns the throw into an unhandled rejection on top of the hang.
          try {
            await persistRotatedState();
          } finally {
            events.close();
          }
        }
      };

      const meta: ChatGptSessionResponseMeta = {
        cid: `chatcmpl-cgpts-${crypto.randomUUID().slice(0, 12)}`,
        created: Math.floor(Date.now() / 1000),
        model: input.model,
      };

      if (!parsed.stream) {
        const running = run();
        const collected = await events.collect();
        await running;
        const built = buildChatGptSessionCompletion(collected, meta);
        const jsonResponse = new Response(JSON.stringify(built.body), {
          status: built.status,
          headers: JSON_HEADERS,
        });
        if (!hasTools || built.status !== 200) return wrapped(jsonResponse, input.body);
        const toolResponse = await buildToolModeResponse(
          jsonResponse,
          requestedTools,
          Boolean(input.stream),
          { cid: meta.cid, created: meta.created, model: meta.model, idSeed: "cgpts" }
        );
        return wrapped(toolResponse, input.body);
      }

      void run();
      const opened = await openChatGptSessionStream(events, meta, {
        streamOpenTimeoutMs: resolveChatGptSessionStreamOpenTimeoutMs(),
      });
      if (opened.kind === "error") {
        // Every field of the verdict comes from the bridge's classification of the real adapter
        // event — status, code and fallbackHint alike. Re-classifying the sanitized message here
        // would discard the event's own `status`/`code`/`name`.
        return wrapped(
          errorResponse(opened.status, opened.message, opened.code, opened.fallbackHint),
          input.body
        );
      }
      return wrapped(
        new Response(opened.stream, { status: 200, headers: SSE_HEADERS }),
        input.body
      );
    } catch (error) {
      const classified = classifyChatGptSessionError(error);
      warn(input.log, error);
      return wrapped(
        errorResponse(
          classified.status,
          error instanceof Error ? error.message : error,
          classified.code,
          classified.fallbackHint
        ),
        input.body
      );
    }
  }
}
