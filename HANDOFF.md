# Project Handoff & Current State

## Objective

Provide a harness-independent, loopback-only (`127.0.0.1`) multi-protocol inference gateway for Metaphor accounts so local coding agents (Pi, Claude Code, OpenAI SDK clients, and custom harnesses) can execute files, shell commands, and tool calls locally on the user's machine without using Metaphor's remote cloud-task VM (`/api/v1/cloud/runs`).

## Implemented & Verified

1. **Direct inference & authentication verified**:
   - Normal Metaphor desktop WorkOS credentials (`workos_access_token.com.metaphor.app`, `workos_refresh_token.com.metaphor.app`, `workos_access_token_expires_at.com.metaphor.app`) authenticate directly against `https://llms.withmetaphor.com` as `Authorization: Bearer <token>`.
   - Expired tokens refresh via `POST https://withmetaphor.com/api/auth` (`{ "userRefreshToken": "<token>" }`) with single-flight coalescing and UTF-16LE Credential Manager writeback on Windows.
2. **Zero-dependency multi-protocol gateway (`src/`)**:
   - Supports `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`, and `POST /v1/messages`.
   - Enforces loopback-only binding, optional constant-time `LOCAL_API_KEY` verification, two-stage boundary validation before body buffering, strict header allowlisting, unbuffered SSE streaming with TCP backpressure, immediate upstream abort on client disconnect, and `Retry-After` cooldown enforcement.
3. **Test suites (`test/`)**:
   - `npm test` (`test/gateway.test.js`): Deterministic offline suite covering CLI flags, loopback/config validation, `LOCAL_API_KEY` isolation, header stripping, route/schema boundary errors, unbuffered SSE + abort propagation, `401`/`403`/`429`/`500`/mid-stream truncation handling, and single-flight WorkOS token refresh.
   - `RUN_LIVE_TESTS=1 npm run test:live` (`test/live.test.js`): Opt-in live suite against `https://llms.withmetaphor.com` covering catalog discovery, streaming + local tool round trips across all three protocols, stream cancellation, and isolated local Pi file editing.
4. **Compatibility matrix (`docs/COMPATIBILITY.json`)**:
   - Populated from the live 25-model `/v1/models` catalog with empirical per-protocol verification statuses.

## Remaining Gaps

- **macOS / Linux native keychain store**: Non-Windows platforms currently use `METAPHOR_ACCESS_TOKEN` / `METAPHOR_REFRESH_TOKEN` environment variables rather than `security` (macOS) or `libsecret` (Linux).
- **Untested catalog entries**: 17 sibling/frontier models in `docs/COMPATIBILITY.json` were intentionally left `untested` to avoid unnecessary token spend; only live-verified routes are marked `verified`.
- **Account entitlement state**: Live tests require an active Metaphor subscription/entitlement; when an account is refunded or unentitled, upstream `401`/`403` errors are surfaced verbatim by design.
