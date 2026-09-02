/**
 * Indirection layer over every side-effecting dependency of the executor (browser detection,
 * storage-state IO, login probe, adapter turn). Tests swap the whole record so no unit test
 * ever launches Chrome; production resolves to the vendored implementations.
 */

import { createChatGptWebAdapter } from "../../vendor/codex-chatgpt-web/adapters/chatgpt-web/index.ts";
import {
  browserLoginStateExists,
  inspectBrowserLoginCapabilities,
} from "../../vendor/codex-chatgpt-web/browser-login.ts";
import type {
  AdapterEvent,
  CodexParsedRequest,
  CodexProviderConfig,
} from "../../vendor/codex-chatgpt-web/types.ts";
import { detectChromeExecutable } from "../chatgpt-web-codex.ts";
import {
  ensureConnectionStorageStateFromCredential,
  readConnectionStorageState,
} from "../chatgpt-web-codex/storageState.ts";

export interface ChatGptSessionLoginConfig {
  appName: string;
  storageStatePath: string;
  headed: boolean;
  proAvailable: boolean;
  autoApproveToolCalls: boolean;
  chromeExecutablePath?: string;
  cdpEndpoint?: string;
}

export interface ChatGptSessionRuntime {
  detectChrome(explicit?: string): string | undefined;
  ensureStorageState(
    connectionId: string,
    credential: { cookie?: string; storageState?: Record<string, unknown> }
  ): string;
  readStorageState(path: string): Record<string, unknown>;
  loginStateExists(config: ChatGptSessionLoginConfig): boolean;
  inspectLogin(
    config: ChatGptSessionLoginConfig
  ): Promise<{ solAvailable: boolean; proAvailable: boolean }>;
  runTurn(
    parsed: CodexParsedRequest,
    incoming: { headers: Headers; abortSignal?: AbortSignal },
    emit: (event: AdapterEvent) => void,
    provider: CodexProviderConfig
  ): Promise<void>;
}

const productionRuntime: ChatGptSessionRuntime = {
  detectChrome: (explicit) => detectChromeExecutable(explicit),
  ensureStorageState: (connectionId, credential) =>
    ensureConnectionStorageStateFromCredential(connectionId, credential),
  readStorageState: (path) => readConnectionStorageState(path),
  loginStateExists: (config) => browserLoginStateExists(config),
  inspectLogin: (config) => inspectBrowserLoginCapabilities(config),
  runTurn: (parsed, incoming, emit, provider) =>
    createChatGptWebAdapter(provider).runTurn(parsed, incoming, emit),
};

let override: Partial<ChatGptSessionRuntime> | null = null;

export function __setChatGptSessionRuntimeForTesting(
  next: Partial<ChatGptSessionRuntime> | null
): void {
  override = next;
}

export function chatGptSessionRuntime(): ChatGptSessionRuntime {
  return override ? { ...productionRuntime, ...override } : productionRuntime;
}
