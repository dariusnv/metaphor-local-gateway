import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayServer } from "../src/server.js";

const RUN_LIVE = process.env.RUN_LIVE_TESTS === "1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runProcessWithClosedStdin(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Process timed out. stdout=${stdout} stderr=${stderr}`));
    }, options.timeout ?? 90_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}. stdout=${stdout} stderr=${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function fetchRespectingRetryAfter(url, init, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const resp = await fetch(url, init);
    if (resp.status !== 429 || attempt === maxRetries) {
      return resp;
    }
    const retryHeader = resp.headers.get("retry-after");
    await resp.text().catch(() => {});
    const retrySec = Math.max(Number.parseFloat(retryHeader || "3") || 3, 3);
    await sleep((retrySec + 0.5) * 1000);
  }
  throw new Error("Unreachable");
}

function extractAnthropicStreamText(sse) {
  let out = "";
  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    try {
      const ev = JSON.parse(line.slice(6));
      if (ev.type === "content_block_delta" && typeof ev.delta?.text === "string") {
        out += ev.delta.text;
      }
    } catch {
      // ignore non-JSON data lines
    }
  }
  return out;
}

test(
  "live end-to-end gateway verification: catalog, all 3 protocols + tool round trips, cancellation, and local Pi file edit",
  { skip: !RUN_LIVE && "Set RUN_LIVE_TESTS=1 to run live Metaphor gateway checks" },
  async (t) => {
    const localKey = "local-live-verification-key";
    const { server } = createGatewayServer({
      env: {
        HOST: "127.0.0.1",
        PORT: "0",
        LOCAL_API_KEY: localKey,
      },
    });

    const baseUrl = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });

    t.after(async () => {
      await new Promise((resolve) => server.close(() => resolve()));
    });

    await t.test("GET /v1/models returns live catalog with open and frontier models", async () => {
      const resp = await fetch(`${baseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${localKey}` },
      });
      assert.equal(resp.status, 200);
      const catalog = await resp.json();
      assert.equal(catalog.object, "list");
      assert.ok(Array.isArray(catalog.data) && catalog.data.length >= 10);
      const ids = new Set(catalog.data.map((m) => m.id));
      assert.ok(ids.has("deepseek-v4-1-flash"));
      assert.ok(ids.has("qwen3-coder-next"));
    });

    await t.test("POST /v1/chat/completions streams SSE and completes local tool round trip", async () => {
      await sleep(2500);
      const streamResp = await fetchRespectingRetryAfter(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${localKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-v4-1-flash",
          stream: true,
          max_tokens: 96,
          messages: [{ role: "user", content: "Reply with the word PONG." }],
        }),
      });
      assert.equal(streamResp.status, 200);
      assert.match(streamResp.headers.get("content-type") || "", /text\/event-stream/i);
      const sseText = await streamResp.text();
      assert.match(sseText, /data: \[DONE\]/);

      await sleep(3000);
      const tools = [
        {
          type: "function",
          function: {
            name: "compute_checksum",
            description: "Return deterministic checksum string for label.",
            parameters: {
              type: "object",
              properties: { label: { type: "string" } },
              required: ["label"],
              additionalProperties: false,
            },
          },
        },
      ];
      const messages = [
        { role: "user", content: 'Call compute_checksum with label="alpha" and report the returned value.' },
      ];
      const turn1Resp = await fetchRespectingRetryAfter(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${localKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-v4-1-flash",
          messages,
          tools,
          max_tokens: 160,
        }),
      });
      assert.equal(turn1Resp.status, 200);
      const turn1 = await turn1Resp.json();
      const msg1 = turn1.choices[0].message;
      assert.ok(Array.isArray(msg1.tool_calls) && msg1.tool_calls.length > 0);
      const tc = msg1.tool_calls[0];
      assert.equal(tc.function.name, "compute_checksum");

      messages.push(msg1);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify({ checksum: "CHK-9042" }),
      });

      await sleep(3000);
      const turn2Resp = await fetchRespectingRetryAfter(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${localKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-v4-1-flash",
          messages,
          tools,
          max_tokens: 120,
        }),
      });
      assert.equal(turn2Resp.status, 200);
      const turn2 = await turn2Resp.json();
      assert.match(turn2.choices[0].message.content || "", /CHK-9042/);
    });

    await t.test("POST /v1/responses streams SSE and completes function_call round trip", async () => {
      await sleep(3000);
      const tools = [
        {
          type: "function",
          name: "lookup_port",
          description: "Look up local service port by name.",
          parameters: {
            type: "object",
            properties: { service: { type: "string" } },
            required: ["service"],
            additionalProperties: false,
          },
        },
      ];
      const prompt = 'Call lookup_port with service="metrics" and tell me the port number.';
      const turn1Resp = await fetchRespectingRetryAfter(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${localKey}`,
        },
        body: JSON.stringify({
          model: "qwen3-coder-next",
          input: [{ role: "user", content: prompt }],
          tools,
          stream: true,
          max_output_tokens: 160,
        }),
      });
      assert.equal(turn1Resp.status, 200);
      const sse = await turn1Resp.text();
      let completed = null;
      for (const line of sse.split(/\r?\n/)) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.type === "response.completed") {
            completed = parsed.response;
          }
        }
      }
      assert.ok(completed, "Expected response.completed SSE event");
      const fnCall = completed.output.find((item) => item.type === "function_call");
      assert.ok(fnCall, "Expected function_call item in response output");

      await sleep(3000);
      const turn2Resp = await fetchRespectingRetryAfter(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${localKey}`,
        },
        body: JSON.stringify({
          model: "qwen3-coder-next",
          input: [
            { role: "user", content: prompt },
            ...completed.output,
            {
              type: "function_call_output",
              call_id: fnCall.call_id,
              output: JSON.stringify({ port: 9187 }),
            },
          ],
          tools,
          stream: false,
          max_output_tokens: 120,
        }),
      });
      assert.equal(turn2Resp.status, 200);
      const turn2 = await turn2Resp.json();
      const textOut = turn2.output
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content || [])
        .map((c) => c.text || "")
        .join(" ");
      assert.match(textOut, /9187/);
    });

    await t.test("POST /v1/messages streams SSE and completes tool_use round trip", async () => {
      await sleep(3000);
      const tools = [
        {
          name: "get_build_tag",
          description: "Return local build tag.",
          input_schema: {
            type: "object",
            properties: { target: { type: "string" } },
            required: ["target"],
          },
        },
      ];
      const messages = [{ role: "user", content: 'Call get_build_tag for target="win64" and report the build tag.' }];
      const turn1Resp = await fetchRespectingRetryAfter(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": localKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "minimax-m3",
          max_tokens: 180,
          tools,
          messages,
        }),
      });
      assert.equal(turn1Resp.status, 200);
      const turn1 = await turn1Resp.json();
      const toolUse = (turn1.content || []).find((b) => b.type === "tool_use");
      assert.ok(toolUse, "Expected tool_use content block");

      messages.push({ role: "assistant", content: turn1.content });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ build_tag: "BLD-2026-LOCAL" }),
          },
        ],
      });

      await sleep(3000);
      const turn2Resp = await fetchRespectingRetryAfter(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": localKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "minimax-m3",
          max_tokens: 160,
          stream: true,
          tools,
          messages,
        }),
      });
      assert.equal(turn2Resp.status, 200);
      const sse = await turn2Resp.text();
      assert.match(extractAnthropicStreamText(sse), /BLD-2026-LOCAL/);
    });

    await t.test("client cancellation terminates SSE forwarding and upstream releases slot", async () => {
      await sleep(3000);
      const controller = new AbortController();
      const resp = await fetchRespectingRetryAfter(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${localKey}`,
        },
        body: JSON.stringify({
          model: "deepseek-v4-1-flash",
          stream: true,
          max_tokens: 400,
          messages: [{ role: "user", content: "Write a 200-word explanation of TCP flow control." }],
        }),
        signal: controller.signal,
      });
      assert.equal(resp.status, 200);
      const reader = resp.body.getReader();
      const firstChunk = await reader.read();
      assert.equal(firstChunk.done, false);
      controller.abort();
      await reader.cancel().catch(() => {});

      await sleep(4500);
      const followUp = await fetchRespectingRetryAfter(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${localKey}`,
        },
        body: JSON.stringify({
          model: "qwen3-coder-next",
          max_tokens: 32,
          messages: [{ role: "user", content: "Reply DONE." }],
        }),
      });
      assert.equal(followUp.status, 200);
    });

    await t.test("local Pi harness edits a disposable local file through the gateway with no git/cloud workspace", async (subT) => {
      const binDir = path.join(os.homedir(), ".pi", "agent", "bin");
      const isWin = process.platform === "win32";
      const entryPath = path.join(binDir, isWin ? "pi-launcher.js" : "pi");
      try {
        await fs.access(entryPath);
      } catch {
        subT.skip("Pi CLI is not installed at ~/.pi/agent/bin");
        return;
      }

      await sleep(5000);
      const tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "metaphor-gw-workspace-"));
      const tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "metaphor-gw-pi-agent-"));

      try {
        const targetFile = path.join(tempWorkspace, "disposable.txt");
        await fs.writeFile(targetFile, 'mode = "before_gateway_test"\n', "utf8");

        const modelsConfig = {
          providers: {
            "metaphor-local": {
              name: "Metaphor Local Gateway",
              baseUrl: `${baseUrl}/v1`,
              api: "openai-completions",
              apiKey: localKey,
              authHeader: true,
              models: [
                {
                  id: "qwen3-coder-next",
                  name: "Qwen3 Coder Next",
                  contextWindow: 256000,
                  maxTokens: 8192,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        };
        await fs.writeFile(path.join(tempAgentDir, "models.json"), JSON.stringify(modelsConfig, null, 2), "utf8");

        const piArgs = [
          "--provider",
          "metaphor-local",
          "--model",
          "qwen3-coder-next",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "--no-context-files",
          "--no-mcp",
          "--offline",
          "--tools",
          "read,edit",
          "-p",
          "Read disposable.txt and use the edit tool to change before_gateway_test to after_local_gateway_edit. Then reply DONE.",
        ];

        const {
          METAPHOR_ACCESS_TOKEN: _dropAccess,
          METAPHOR_REFRESH_TOKEN: _dropRefresh,
          ...sanitizedEnv
        } = process.env;

        const command = isWin ? process.execPath : entryPath;
        const commandArgs = isWin ? [entryPath, ...piArgs] : piArgs;

        await runProcessWithClosedStdin(command, commandArgs, {
          cwd: tempWorkspace,
          env: {
            ...sanitizedEnv,
            PI_CODING_AGENT_DIR: tempAgentDir,
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0",
          },
          timeout: 90_000,
        });

        const updatedContent = await fs.readFile(targetFile, "utf8");
        assert.match(updatedContent, /mode = "after_local_gateway_edit"/);
      } finally {
        await fs.rm(tempWorkspace, { recursive: true, force: true });
        await fs.rm(tempAgentDir, { recursive: true, force: true });
      }
    });
  },
);
