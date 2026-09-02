---
title: "Providers — ChatGPT Web (Session)"
version: 3.8.51
lastUpdated: 2026-09-02
---

# Providers — ChatGPT Web (Session)

`chatgpt-session` (alias `cgpt-session`) serves ordinary `/v1/chat/completions` requests from
an authenticated ChatGPT browser session. It is a clean-room implementation and shares no code
with the retired common `chatgpt-web` provider; the browser interaction reuses the MIT-noticed
implementation under `open-sse/vendor/codex-chatgpt-web/`.

## Relationship to the other ChatGPT providers

| Provider                | Endpoint               | Client                       |
| ----------------------- | ---------------------- | ---------------------------- |
| `chatgpt-session`       | `/v1/chat/completions` | any OpenAI-compatible client |
| `chatgpt-web-codex`     | `/v1/responses`        | the native Codex CLI only    |
| `chatgpt-web` (retired) | —                      | fails closed with HTTP 410   |

## Prerequisites

- a full Cookie header from a signed-in ChatGPT session;
- Chrome or Chromium, plus a graphical session or Xvfb on headless hosts;
- with the Docker `web` profile, the internal Chromium service from `docker-compose.yml`.

## Setup

1. Open the **ChatGPT Web (Session)** provider in the dashboard and add a connection.
2. Paste the full ChatGPT Cookie header.
3. Run the connection check. OmniRoute opens an isolated browser profile, verifies the session
   and detects whether Sol and Pro are available for the account.
4. Save. The pasted cookie is replaced by the verified browser session state; the raw cookie is
   not retained.

When the session expires, paste a fresh Cookie header and rerun the check.

## Models

| Model                        | Account requirement              |
| ---------------------------- | -------------------------------- |
| `chatgpt-session/luna`       | Free/Go accounts (Luna selector) |
| `chatgpt-session/think`      | Free/Go accounts                 |
| `chatgpt-session/instant`    | Sol-capable accounts             |
| `chatgpt-session/medium`     | Sol-capable accounts             |
| `chatgpt-session/high`       | Sol-capable accounts             |
| `chatgpt-session/extra-high` | Pro-capable accounts             |
| `chatgpt-session/pro`        | Pro-capable accounts             |

Each model pins one backend model and one reasoning effort. Requesting a route the account does
not expose fails closed with HTTP 400 instead of silently switching modes.

## Tool calling

Tool calling is prompt-emulated, the same contract `perplexity-web` and `gemini-web` use. Tool
turns are answered non-streaming and then replayed as a terminal SSE stream when the client
asked for one.

## Errors

| Condition                                    | Status                               |
| -------------------------------------------- | ------------------------------------ |
| No Chrome or Chromium available              | 503, with a connection-cooldown hint |
| Missing or unreadable credentials            | 401                                  |
| Expired session                              | 401                                  |
| ChatGPT usage limit reached                  | 429                                  |
| Model not available for the account          | 400                                  |
| ChatGPT interface changed (selector timeout) | 400                                  |
| Any other turn failure                       | 502                                  |

Cookies and session state never appear in responses or logs.

## Limitations

Phase 1 covers text chat only. Image generation and editing, citation links and conversation
resume are not implemented.

Every turn is relayed to ChatGPT through the vendored adapter's own task-framing prompt
(`open-sse/vendor/codex-chatgpt-web/adapters/chatgpt-web/prompt.ts`), which wraps the request
before it is typed into the web UI. That framing is not visible to API clients: what a client
sends is not literally what the ChatGPT session receives. One consequence to watch for is that a
tool turn may occasionally be answered with a refusal about local-tool access instead of a tool
block. This has not been observed on a live turn yet — it is a property of the framing that live
validation still has to confirm or rule out.
