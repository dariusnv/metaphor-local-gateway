# Changelog

## 0.1.0 — 2026-11-18

First release.

- Loopback-only (`127.0.0.1` / `::1` / `localhost`) HTTP gateway with zero runtime dependencies (Node.js >= 22).
- Pass-through routes: `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages` to `https://llms.withmetaphor.com`.
- Windows Credential Manager sign-in reuse (`workos_*.com.metaphor.app`) with single-flight token refresh and write-back; `METAPHOR_ACCESS_TOKEN` / `METAPHOR_REFRESH_TOKEN` env credentials elsewhere.
- Optional `LOCAL_API_KEY`, header allowlists in both directions, boundary validation with protocol-native error shapes, 32 MiB body cap.
- Unbuffered SSE with backpressure, upstream abort on client disconnect, and local `Retry-After` cooldown enforcement.
- Offline test suite (`npm test`) and opt-in live suite (`RUN_LIVE_TESTS=1 npm run test:live`).
