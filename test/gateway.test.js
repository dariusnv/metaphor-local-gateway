import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createMetaphorAuth } from "../src/auth.js";
import { createGatewayServer } from "../src/server.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

function listenOnRandomPort(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      resolve(`http://${host}:${addr.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function makeJwtWithExp(expSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, iss: "https://api.workos.com" })).toString("base64url");
  return `${header}.${payload}.test_sig`;
}

test("CLI supports --help, --version, and rejects unknown flags", async () => {
  const helpOut = await execFileAsync(process.execPath, [CLI_PATH, "--help"]);
  assert.match(helpOut.stdout, /metaphor-local-gateway/);
  assert.match(helpOut.stdout, /--port/);

  const verOut = await execFileAsync(process.execPath, [CLI_PATH, "--version"]);
  assert.match(verOut.stdout.trim(), /^\d+\.\d+\.\d+$/);

  await assert.rejects(
    () => execFileAsync(process.execPath, [CLI_PATH, "--unknown-flag"]),
    (err) => err.code === 1 && /Unknown option/.test(err.stderr),
  );
});

test("rejects non-loopback bind host and non-http upstream protocols at startup", () => {
  assert.throws(
    () =>
      createGatewayServer({
        env: {
          HOST: "0.0.0.0",
          PORT: "0",
          METAPHOR_ACCESS_TOKEN: "tok-test",
        },
      }),
    /Refusing non-loopback HOST/,
  );

  assert.throws(
    () =>
      createGatewayServer({
        env: {
          HOST: "127.0.0.1",
          METAPHOR_API_URL: "ftp://example.com",
          METAPHOR_ACCESS_TOKEN: "tok-test",
        },
      }),
    /Unsupported METAPHOR_API_URL protocol/,
  );
});

test("enforces optional LOCAL_API_KEY, strips local credentials, and forwards all four native routes", async (t) => {
  const receivedUpstream = [];

  const mockUpstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    receivedUpstream.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: rawBody ? JSON.parse(rawBody) : null,
    });

    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-v4-1-flash", owned_by: "deepseek" }] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl_1",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
                ],
              },
            },
          ],
        }),
      );
      return;
    }
    if (req.url === "/v1/responses") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_1",
          object: "response",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
        }),
      );
      return;
    }
    if (req.url === "/v1/messages") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "OK" }],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  const upstreamUrl = await listenOnRandomPort(mockUpstream);
  const { server } = createGatewayServer({
    env: {
      HOST: "127.0.0.1",
      PORT: "0",
      METAPHOR_UPSTREAM: upstreamUrl,
      METAPHOR_ACCESS_TOKEN: "metaphor-upstream-secret",
      LOCAL_API_KEY: "local-client-secret",
    },
  });
  const gatewayUrl = await listenOnRandomPort(server);
  t.after(async () => {
    await closeServer(server);
    await closeServer(mockUpstream);
  });

  const unauthModels = await fetch(`${gatewayUrl}/v1/models`);
  assert.equal(unauthModels.status, 401);

  const unauthMessages = await fetch(`${gatewayUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "wrong-key" },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(unauthMessages.status, 401);
  const unauthBody = await unauthMessages.json();
  assert.equal(unauthBody.type, "error");
  assert.equal(unauthBody.error.type, "authentication_error");
  assert.equal(receivedUpstream.length, 0);

  const modelsResp = await fetch(`${gatewayUrl}/v1/models`, {
    headers: {
      authorization: "Bearer local-client-secret",
      cookie: "session=should_not_leak",
      "chatgpt-account-id": "acct_should_not_leak",
      "x-custom-secret": "should_not_leak",
    },
  });
  assert.equal(modelsResp.status, 200);
  const modelsJson = await modelsResp.json();
  assert.equal(modelsJson.data[0].id, "deepseek-v4-1-flash");
  assert.equal(receivedUpstream[0].headers.authorization, "Bearer metaphor-upstream-secret");
  assert.equal(receivedUpstream[0].headers.cookie, undefined);
  assert.equal(receivedUpstream[0].headers["chatgpt-account-id"], undefined);
  assert.equal(receivedUpstream[0].headers["x-custom-secret"], undefined);

  const chatPayload = {
    model: "deepseek-v4-1-flash",
    messages: [{ role: "user", content: "Read a.txt" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
  };
  const chatResp = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer local-client-secret",
    },
    body: JSON.stringify(chatPayload),
  });
  assert.equal(chatResp.status, 200);
  const chatJson = await chatResp.json();
  assert.equal(chatJson.choices[0].message.tool_calls[0].function.name, "read_file");
  assert.deepEqual(receivedUpstream[1].body, chatPayload);

  const respApi = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer local-client-secret",
      session_id: "sess_123",
    },
    body: JSON.stringify({ model: "gpt-5.4-mini", input: "Say OK" }),
  });
  assert.equal(respApi.status, 200);
  assert.equal(receivedUpstream[2].headers.session_id, "sess_123");

  const msgApi = await fetch(`${gatewayUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "local-client-secret",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "Say OK" }],
    }),
  });
  assert.equal(msgApi.status, 200);
  assert.equal(receivedUpstream[3].headers.authorization, "Bearer metaphor-upstream-secret");
  assert.equal(receivedUpstream[3].headers["x-api-key"], undefined);
  assert.equal(receivedUpstream[3].headers["anthropic-version"], "2023-06-01");
});

test("validates routes, HTTP methods, content-type, and required protocol fields at boundary", async (t) => {
  let upstreamHits = 0;
  const mockUpstream = http.createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200).end("{}");
  });
  const upstreamUrl = await listenOnRandomPort(mockUpstream);
  const { server } = createGatewayServer({
    env: {
      HOST: "127.0.0.1",
      PORT: "0",
      METAPHOR_UPSTREAM: upstreamUrl,
      METAPHOR_ACCESS_TOKEN: "tok",
    },
  });
  const gatewayUrl = await listenOnRandomPort(server);
  t.after(async () => {
    await closeServer(server);
    await closeServer(mockUpstream);
  });

  const r404 = await fetch(`${gatewayUrl}/api/v1/cloud/runs`, { method: "POST" });
  assert.equal(r404.status, 404);

  const r405 = await fetch(`${gatewayUrl}/v1/models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(r405.status, 405);
  assert.equal(r405.headers.get("allow"), "GET");

  const r415 = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "hello",
  });
  assert.equal(r415.status, 415);

  const rBadJson = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal(rBadJson.status, 400);

  const rPaddedModel = await fetch(`${gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: " gpt-5.4-mini ", input: "hi" }),
  });
  assert.equal(rPaddedModel.status, 400);

  const rNoMaxTokens = await fetch(`${gatewayUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(rNoMaxTokens.status, 400);
  const errJson = await rNoMaxTokens.json();
  assert.equal(errJson.type, "error");

  assert.equal(upstreamHits, 0);
});

test("streams SSE without buffering and aborts upstream immediately when local client disconnects", async (t) => {
  let releaseSecondChunk;
  const secondChunkGate = new Promise((resolve) => {
    releaseSecondChunk = resolve;
  });
  let upstreamClosedPromiseResolve;
  const upstreamClosed = new Promise((resolve) => {
    upstreamClosedPromiseResolve = resolve;
  });

  const mockUpstream = http.createServer(async (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.flushHeaders();
    res.write('data: {"chunk":1}\n\n');

    req.on("close", () => upstreamClosedPromiseResolve(true));
    res.on("close", () => upstreamClosedPromiseResolve(true));

    await secondChunkGate;
    if (!res.destroyed) {
      res.write('data: {"chunk":2}\n\n');
      res.end("data: [DONE]\n\n");
    }
  });

  const upstreamUrl = await listenOnRandomPort(mockUpstream);
  const { server } = createGatewayServer({
    env: {
      HOST: "127.0.0.1",
      PORT: "0",
      METAPHOR_UPSTREAM: upstreamUrl,
      METAPHOR_ACCESS_TOKEN: "tok",
    },
  });
  const gatewayUrl = await listenOnRandomPort(server);
  t.after(async () => {
    releaseSecondChunk();
    await closeServer(server);
    await closeServer(mockUpstream);
  });

  const clientAbort = new AbortController();
  const resp = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-1-flash",
      stream: true,
      messages: [{ role: "user", content: "stream" }],
    }),
    signal: clientAbort.signal,
  });

  assert.equal(resp.status, 200);
  const reader = resp.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /"chunk":1/);

  clientAbort.abort();
  const closed = await Promise.race([
    upstreamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Upstream was not aborted on client disconnect")), 3000)),
  ]);
  assert.equal(closed, true);
});

test("preserves upstream 401/403/429/500 errors, enforces Retry-After cooldown, and propagates midstream truncation", async (t) => {
  let currentTimeMs = 1_000_000;
  let upstreamCallCount = 0;
  let mode = "401";

  const mockUpstream = http.createServer((_req, res) => {
    upstreamCallCount += 1;
    if (mode === "401") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "authentication_error", message: "Unauthorized" } }));
      return;
    }
    if (mode === "403") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "permission_error", message: "Account suspended or unentitled" } }));
      return;
    }
    if (mode === "429") {
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "4",
      });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "Too many concurrent Darwin requests." },
        }),
      );
      return;
    }
    if (mode === "500") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Upstream failure", type: "server_error" } }));
      return;
    }
    if (mode === "midstream_drop") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"partial":true}\n\n');
      setTimeout(() => {
        res.socket?.destroy();
      }, 30);
    }
  });

  const upstreamUrl = await listenOnRandomPort(mockUpstream);
  const { server } = createGatewayServer({
    env: {
      HOST: "127.0.0.1",
      PORT: "0",
      METAPHOR_UPSTREAM: upstreamUrl,
      METAPHOR_ACCESS_TOKEN: "tok",
    },
    nowMs: () => currentTimeMs,
  });
  const gatewayUrl = await listenOnRandomPort(server);
  t.after(async () => {
    await closeServer(server);
    await closeServer(mockUpstream);
  });

  const r401 = await fetch(`${gatewayUrl}/v1/models`);
  assert.equal(r401.status, 401);
  assert.deepEqual(await r401.json(), { error: { type: "authentication_error", message: "Unauthorized" } });

  mode = "403";
  const r403 = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r403.status, 403);
  assert.deepEqual(await r403.json(), { error: { type: "permission_error", message: "Account suspended or unentitled" } });

  mode = "429";
  const r1 = await fetch(`${gatewayUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r1.status, 429);
  assert.equal(r1.headers.get("retry-after"), "4");
  assert.equal(upstreamCallCount, 3);

  currentTimeMs += 1_000;
  const r2 = await fetch(`${gatewayUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r2.status, 429);
  assert.equal(r2.headers.get("retry-after"), "3");
  assert.equal(upstreamCallCount, 3);

  currentTimeMs += 4_000;
  mode = "500";
  const r3 = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r3.status, 500);
  assert.equal(upstreamCallCount, 4);

  mode = "midstream_drop";
  await assert.rejects(
    async () => {
      const r4 = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(r4.status, 200);
      await r4.text();
    },
    (err) => err instanceof Error,
  );
});

test("refreshes expired WorkOS token via /api/auth and writes rotated credentials to keychain store", async (t) => {
  let currentSec = 2_000_000;
  const expiredJwt = makeJwtWithExp(currentSec + 10);
  const freshJwt = makeJwtWithExp(currentSec + 86_400);
  const writes = [];
  let refreshCalls = 0;

  const mockAuthAndUpstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString("utf8");

    if (req.url === "/api/auth" && req.method === "POST") {
      refreshCalls += 1;
      const body = JSON.parse(bodyText);
      assert.equal(body.userRefreshToken, "ref_initial");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          accessToken: freshJwt,
          userRefreshToken: "ref_rotated",
          expiresAt: currentSec + 86_400,
          refreshTokenRotated: true,
        }),
      );
      return;
    }

    if (req.url === "/v1/models") {
      assert.equal(req.headers.authorization, `Bearer ${freshJwt}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
      return;
    }

    res.writeHead(404).end();
  });

  const baseUrl = await listenOnRandomPort(mockAuthAndUpstream);
  const fakeKeychain = {
    async readCredentials() {
      return {
        accessToken: expiredJwt,
        refreshToken: "ref_initial",
        expiresAt: String(currentSec + 10),
      };
    },
    async writeCredentials(entry) {
      writes.push(entry);
    },
  };

  const auth = createMetaphorAuth({
    authApiBaseUrl: `${baseUrl}/api`,
    keychain: fakeKeychain,
    nowSeconds: () => currentSec,
  });

  const { server } = createGatewayServer({
    env: {
      HOST: "127.0.0.1",
      PORT: "0",
      METAPHOR_UPSTREAM: baseUrl,
    },
    auth,
  });
  const gatewayUrl = await listenOnRandomPort(server);
  t.after(async () => {
    await closeServer(server);
    await closeServer(mockAuthAndUpstream);
  });

  const [a, b] = await Promise.all([fetch(`${gatewayUrl}/v1/models`), fetch(`${gatewayUrl}/v1/models`)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(refreshCalls, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].accessToken, freshJwt);
  assert.equal(writes[0].refreshToken, "ref_rotated");
});
