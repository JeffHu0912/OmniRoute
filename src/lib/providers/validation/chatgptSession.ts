import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";

import { CHATGPT_WEB_CODEX_CONNECTOR_NAME } from "@/shared/constants/chatgptWebCodex";
import { inspectBrowserLoginCapabilities } from "@omniroute/open-sse/vendor/codex-chatgpt-web/browser-login.ts";
import { decodeChatGptWebCodexSecrets } from "@omniroute/open-sse/executors/chatgpt-web-codex/credentials.ts";
import { detectChromeExecutable } from "@omniroute/open-sse/executors/chatgpt-web-codex.ts";
import {
  connectionRuntimePaths,
  ensureConnectionStorageState,
  ensureConnectionStorageStateFromCredential,
} from "@omniroute/open-sse/executors/chatgpt-web-codex/storageState.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

export async function validateChatGptSessionProvider({
  apiKey,
  providerSpecificData = {},
}: {
  apiKey?: string;
  providerSpecificData?: Record<string, unknown>;
}) {
  try {
    const secrets = decodeChatGptWebCodexSecrets(String(apiKey || ""));
    if (!secrets.cookie && !secrets.storageState) {
      return {
        valid: false,
        error: "A ChatGPT cookie header or a stored browser session is required.",
      };
    }

    const cdpEndpoint = process.env.CHATGPT_WEB_CODEX_CDP_URL?.trim();
    const chromeExecutablePath = detectChromeExecutable(
      typeof providerSpecificData.chromeExecutablePath === "string"
        ? providerSpecificData.chromeExecutablePath
        : undefined
    );
    if (!chromeExecutablePath && !cdpEndpoint) {
      return {
        valid: false,
        error:
          "No supported Chrome or Chromium was found. Install Chromium or configure the browser path.",
      };
    }

    const validationId = `validation-${randomBytes(12).toString("hex")}`;
    const paths = connectionRuntimePaths(validationId);
    const freshCookie = Boolean(secrets.cookie);
    if (secrets.cookie) ensureConnectionStorageState(validationId, secrets.cookie);
    else ensureConnectionStorageStateFromCredential(validationId, secrets);

    let capabilities;
    try {
      capabilities = await inspectBrowserLoginCapabilities({
        appName: CHATGPT_WEB_CODEX_CONNECTOR_NAME,
        ...(chromeExecutablePath ? { chromeExecutablePath } : {}),
        ...(cdpEndpoint ? { cdpEndpoint } : {}),
        storageStatePath: paths.storageStatePath,
        headed: false,
        proAvailable: false,
        autoApproveToolCalls: false,
      });
    } catch (error) {
      rmSync(paths.root, { recursive: true, force: true });
      throw error;
    }
    if (!freshCookie) rmSync(paths.root, { recursive: true, force: true });

    return {
      valid: true,
      error: null,
      method: "headless-browser",
      capabilities: {
        browser: "ready",
        storageState: "verified",
        login: "authenticated",
        solAvailable: capabilities.solAvailable,
        proAvailable: capabilities.proAvailable,
      },
      providerSpecificData: {
        solAvailable: capabilities.solAvailable,
        proAvailable: capabilities.proAvailable,
        browserVerified: true,
        ...(chromeExecutablePath ? { chromeExecutablePath } : {}),
        ...(freshCookie ? { validationId } : {}),
      },
    };
  } catch (error) {
    return {
      valid: false,
      error: sanitizeErrorMessage(error instanceof Error ? error.message : error),
    };
  }
}
