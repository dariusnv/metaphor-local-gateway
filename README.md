<div align="center">

# metaphor-local-gateway

**Use your Metaphor account from any local coding agent.**
OpenAI- and Anthropic-compatible endpoints on `127.0.0.1`. Your tools run on your machine.

[![test](https://github.com/dariusnv/metaphor-local-gateway/actions/workflows/test.yml/badge.svg)](https://github.com/dariusnv/metaphor-local-gateway/actions/workflows/test.yml)
![node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)
![deps](https://img.shields.io/badge/runtime%20deps-0-blue)
![license](https://img.shields.io/badge/license-Unlicense-lightgrey)

</div>

> [!NOTE]
> Unofficial. Not affiliated with or endorsed by Metaphor. It relies on an undocumented API that can change or disappear at any time.

```text
 Pi · Claude Code · OpenAI SDK · Anthropic SDK
                  │  /v1/*  (HTTP + SSE)
                  ▼
     metaphor-local-gateway  ── 127.0.0.1:8080
                  │  Bearer <your Metaphor token>
                  ▼
        https://llms.withmetaphor.com
```

## Why

Metaphor's agent normally runs inside a cloud VM. This gateway exposes only the stateless inference API, so your own harness keeps the files, shell and approvals local. Nothing calls `/api/v1/cloud/runs`.

- **Four native routes, passed through byte-for-byte.** No model swaps, no schema rewriting, no fake success.
- **Zero-config on Windows.** Reuses the Metaphor desktop sign-in from Credential Manager and refreshes tokens automatically.
- **Streaming done right.** Unbuffered SSE with backpressure, and the upstream request is aborted the moment your client disconnects.
- **Plays fair.** Upstream `401`/`403`/`429`/`5xx` are returned as-is, and `Retry-After` is enforced locally.
- **Tiny.** About 1,000 lines on the Node.js standard library, with no `npm install` required.

## Quickstart

Requires **Node.js ≥ 22** and an active Metaphor account.

```bash
git clone https://github.com/dariusnv/metaphor-local-gateway.git
cd metaphor-local-gateway
npm start
# metaphor-local-gateway listening on http://127.0.0.1:8080 -> https://llms.withmetaphor.com

curl http://127.0.0.1:8080/v1/models
```

**Windows:** sign in to the Metaphor desktop app once. That's it.

**macOS / Linux / CI:** provide a token via the environment or a `.env` file:

```bash
cp .env.example .env   # set METAPHOR_ACCESS_TOKEN (and optionally METAPHOR_REFRESH_TOKEN)
npm start
```

## Connect a client

Most SDKs insist on an API key. Pass any placeholder such as `local` (or your `LOCAL_API_KEY` if you set one). The gateway strips it and attaches your Metaphor token.

> [!TIP]
> OpenAI-style clients use `http://127.0.0.1:8080/v1`. Anthropic-style clients use `http://127.0.0.1:8080` (they append `/v1/messages` themselves).

<details>
<summary><b>Claude Code</b></summary>

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
export ANTHROPIC_AUTH_TOKEN="local"
export ANTHROPIC_API_KEY=""
claude --model claude-haiku-4-5
```

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8080"
$env:ANTHROPIC_AUTH_TOKEN = "local"
$env:ANTHROPIC_API_KEY = ""
claude --model claude-haiku-4-5
```

</details>

<details>
<summary><b>OpenAI SDK</b> (Node.js / Python)</summary>

```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://127.0.0.1:8080/v1", apiKey: "local" });

const chat = await client.chat.completions.create({
  model: "deepseek-v4-1-flash",
  messages: [{ role: "user", content: "Reply with OK." }],
});

const response = await client.responses.create({ model: "qwen3-coder-next", input: "Reply with OK." });
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="local")
resp = client.chat.completions.create(
    model="deepseek-v4-1-flash",
    messages=[{"role": "user", "content": "Reply with OK."}],
)
print(resp.choices[0].message.content)
```

</details>

<details>
<summary><b>Pi</b> (<code>~/.pi/agent/models.json</code>)</summary>

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "metaphor-chat": {
      "name": "Metaphor Local (Chat Completions)",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "authHeader": true,
      "models": [
        {
          "id": "deepseek-v4-1-flash",
          "name": "DeepSeek V4.1 Flash",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1048576,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "qwen3-coder-next",
          "name": "Qwen3 Coder Next",
          "input": ["text"],
          "contextWindow": 256000,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    },
    "metaphor-responses": {
      "name": "Metaphor Local (Responses)",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-responses",
      "apiKey": "local",
      "authHeader": true,
      "models": [
        {
          "id": "gpt-5.4-mini",
          "name": "GPT 5.4 Mini",
          "input": ["text", "image"],
          "contextWindow": 400000,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    },
    "metaphor-messages": {
      "name": "Metaphor Local (Anthropic Messages)",
      "baseUrl": "http://127.0.0.1:8080",
      "api": "anthropic-messages",
      "apiKey": "local",
      "models": [
        {
          "id": "minimax-m3",
          "name": "MiniMax M3",
          "input": ["text", "image"],
          "contextWindow": 1048576,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "claude-haiku-4-5",
          "name": "Claude Haiku 4.5",
          "input": ["text", "image"],
          "contextWindow": 200000,
          "maxTokens": 16384,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

</details>

## Routes

Every other path, including `/api/v1/cloud/runs`, returns `404`. Request bodies are capped at 32 MiB.

| Route | Protocol | Required fields |
|---|---|---|
| `GET /v1/models` | OpenAI model list | — |
| `POST /v1/chat/completions` | OpenAI Chat Completions | `model`, `messages` |
| `POST /v1/responses` | OpenAI Responses | `model`, `input` |
| `POST /v1/messages` | Anthropic Messages | `model`, `messages`, `max_tokens` |

Validation errors use each protocol's native error shape (Anthropic on `/v1/messages`, OpenAI elsewhere).

## Configuration

```text
metaphor-local-gateway [--host 127.0.0.1] [--port 8080] [--help] [--version]
```

A `.env` in the working directory is loaded automatically.

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Loopback only (`127.0.0.1`, `::1`, `localhost`). |
| `PORT` | `8080` | Listen port (`0` picks a free port). |
| `LOCAL_API_KEY` | — | Require local clients to send `Authorization: Bearer <key>` or `x-api-key`. Never forwarded. |
| `METAPHOR_ACCESS_TOKEN` | Windows: Credential Manager | Metaphor bearer token. Required on macOS/Linux. |
| `METAPHOR_REFRESH_TOKEN` | Windows: Credential Manager | Enables automatic token refresh. |
| `METAPHOR_UPSTREAM` | `https://llms.withmetaphor.com` | Inference origin. |
| `METAPHOR_API_URL` | `https://withmetaphor.com/api` | Token refresh base (`POST <url>/auth`). |

## Models

Live-verified on 2026-11-18. The full 25-model catalog, with aliases and capability flags, is in [`docs/COMPATIBILITY.json`](docs/COMPATIBILITY.json). Anything not listed as ✅ is untested, not known-broken.

| Model | Context | Chat | Responses | Messages | Streaming | Tool round trip |
|---|---:|:-:|:-:|:-:|:-:|:-:|
| `deepseek-v4-1-flash` | 1M | ✅ | ✅ | ✅ | ✅ all | ✅ all |
| `qwen3-coder-next` | 256K | ✅ | ✅ | ✅ | ✅ Chat, Responses | ✅ Responses |
| `minimax-m3` | 1M | ✅ | ✅ | ✅ | ✅ Messages | ✅ Messages |
| `glm-5.3` | 1M | ✅ | ✅ | ✅ | — | — |
| `gpt-5.4-mini` | 400K | ✅ | ✅ | ✅ | — | — |
| `claude-haiku-4-5` | 200K | — | ✅ | ✅ | — | — |
| `deepseek-v4-pro` | 1M | ✅ | — | ✅ | — | — |
| `kimi-k3-1-pro-highspeed` | 1M | ✅ | ✅ | — | — | — |

## Limitations

- **Your account, their rules.** Entitlements, billing and rate limits are enforced by Metaphor. Upstream allows a few concurrent requests per account and returns `429 Too many concurrent Darwin requests.` beyond that.
- **Prompts still leave your machine.** Your repo is never uploaded as a workspace, but messages, tool schemas and any file contents you put in a prompt are sent to Metaphor for inference.
- **Model names are labels.** Neither the requested `model` nor the `model` string in responses proves which weights actually served the request.
- **Keychain support is Windows-only for now.** macOS and Linux use environment variables.
- **Terms.** Read [Metaphor's terms](https://withmetaphor.com/terms) and decide for yourself whether this use fits them.

## Development

```bash
npm test                                 # offline suite: mock upstream + mock keychain
RUN_LIVE_TESTS=1 npm run test:live       # live suite against llms.withmetaphor.com (uses your account)
```

How it works is covered in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), project state in [`HANDOFF.md`](HANDOFF.md), and release notes in [`CHANGELOG.md`](CHANGELOG.md).

## License

Public domain under [The Unlicense](LICENSE).
