# Working Instructions

- Read `HANDOFF.md` and `docs/ARCHITECTURE.md` first. Preserve verified behavior, methodological corrections, and explicit unknowns.
- Goal: local inference API compatibility (`GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`) with local tool execution using the user's own Metaphor account. Never route through `/api/v1/cloud/runs`.
- Never stage, log, or print authentication tokens, `.env` files, or local `private/` directories.
- Validate external input once at the HTTP/CLI boundary, then use validated structures internally. Preserve native API payloads and SSE streams byte-for-byte.
- No guessed model routing, silent fallbacks, fake success on upstream failures, identity spoofing, or rate-limit evasion. Honor client cancellation and upstream `Retry-After`.
- Keep changes small, inline single-use logic, and avoid runtime npm dependencies unless they solve a demonstrated need.
- Test observable behavior (`npm test` offline; `RUN_LIVE_TESTS=1 npm run test:live` when live credentials are active) and state clearly what remains unverified.
