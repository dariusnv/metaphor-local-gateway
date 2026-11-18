import http from "node:http";
import { createMetaphorAuth, MetaphorAuthError } from "./auth.js";
import {
  formatGatewayError,
  validateGatewayConfig,
  validatePostBody,
  validateRequestEnvelope,
} from "./validation.js";

const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
const SAFE_UPSTREAM_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "retry-after",
  "x-request-id",
  "request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

export function parseRetryAfterMs(headerValue, nowMs = Date.now()) {
  if (typeof headerValue !== "string" || !headerValue.trim()) return 0;
  const trimmed = headerValue.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number.parseFloat(trimmed);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 0;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs) && dateMs > nowMs) {
    return dateMs - nowMs;
  }
  return 0;
}

class PayloadTooLargeError extends Error {
  constructor(limitBytes) {
    super(`Request body exceeds ${limitBytes} bytes.`);
  }
}

async function readRequestBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(chunk);
  }
  return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total);
}

function waitForDrainOrClose(res) {
  return new Promise((resolve) => {
    if (res.destroyed || res.writableEnded) {
      resolve();
      return;
    }
    const onDone = () => {
      res.off("drain", onDone);
      res.off("close", onDone);
      res.off("error", onDone);
      resolve();
    };
    res.on("drain", onDone);
    res.on("close", onDone);
    res.on("error", onDone);
  });
}

function writeJsonResponse(res, status, headers, jsonBody) {
  if (res.destroyed || res.headersSent) return;
  const buf = Buffer.from(jsonBody, "utf8");
  res.writeHead(status, {
    "cache-control": "no-store",
    ...headers,
    "content-length": String(buf.length),
  });
  res.end(buf);
}

export function createGatewayServer({
  env = process.env,
  auth = null,
  fetchImpl = globalThis.fetch,
  nowMs = () => Date.now(),
} = {}) {
  const config = validateGatewayConfig(env);
  const authProvider =
    auth ??
    createMetaphorAuth({
      envAccessToken: config.envAccessToken,
      envRefreshToken: config.envRefreshToken,
      authApiBaseUrl: config.authApiBaseUrl,
      fetchImpl,
    });

  let retryAfterUntilMs = 0;

  async function sendUpstream(validated, bearerToken, signal) {
    const headers = {
      ...validated.forwardHeaders,
      authorization: `Bearer ${bearerToken}`,
    };
    if (!headers.accept) {
      headers.accept = validated.stream ? "text/event-stream" : "application/json";
    }
    return fetchImpl(`${config.upstreamOrigin}${validated.pathname}`, {
      method: validated.method,
      headers,
      body: validated.method === "POST" ? validated.rawBodyBuffer : undefined,
      redirect: "error",
      signal,
    });
  }

  const server = http.createServer(async (req, res) => {
    const envelopeCheck = validateRequestEnvelope({
      method: req.method,
      rawUrl: req.url,
      headers: req.headers,
      localApiKey: config.localApiKey,
    });

    if (!envelopeCheck.ok) {
      req.resume();
      writeJsonResponse(res, envelopeCheck.status, envelopeCheck.headers, envelopeCheck.body);
      return;
    }

    const envelope = envelopeCheck.value;
    const upstreamAbort = new AbortController();
    const abortUpstream = () => {
      if (!upstreamAbort.signal.aborted) {
        upstreamAbort.abort();
      }
    };
    req.on("close", () => {
      if (!req.complete) {
        abortUpstream();
      }
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        abortUpstream();
      }
    });

    let validated;
    if (envelope.method === "POST") {
      let rawBodyBuffer;
      try {
        rawBodyBuffer = await readRequestBody(req);
      } catch (err) {
        if (upstreamAbort.signal.aborted || res.destroyed) return;
        const isTooLarge = err instanceof PayloadTooLargeError;
        writeJsonResponse(
          res,
          isTooLarge ? 413 : 400,
          { "content-type": "application/json; charset=utf-8" },
          formatGatewayError(
            envelope.protocol,
            "invalid_request_error",
            isTooLarge ? err.message : "Failed to read request body.",
          ),
        );
        return;
      }

      if (upstreamAbort.signal.aborted || res.destroyed) return;

      const bodyCheck = validatePostBody(envelope, rawBodyBuffer);
      if (!bodyCheck.ok) {
        writeJsonResponse(res, bodyCheck.status, bodyCheck.headers, bodyCheck.body);
        return;
      }
      validated = bodyCheck.value;
    } else {
      req.resume();
      validated = { ...envelope, stream: false, rawBodyBuffer: null };
    }

    const currentMs = nowMs();
    if (currentMs < retryAfterUntilMs) {
      const waitSeconds = Math.max(1, Math.ceil((retryAfterUntilMs - currentMs) / 1000));
      writeJsonResponse(
        res,
        429,
        {
          "content-type": "application/json; charset=utf-8",
          "retry-after": String(waitSeconds),
        },
        formatGatewayError(
          validated.protocol,
          "rate_limit_error",
          `Upstream Retry-After cooldown active; retry after ${waitSeconds}s.`,
        ),
      );
      return;
    }

    let accessToken;
    try {
      accessToken = await authProvider.getAccessToken();
    } catch (err) {
      const isAuthErr = err instanceof MetaphorAuthError;
      const status = isAuthErr ? err.status : 500;
      const errType = status === 401 ? "authentication_error" : "api_error";
      writeJsonResponse(
        res,
        status,
        { "content-type": "application/json; charset=utf-8" },
        formatGatewayError(
          validated.protocol,
          errType,
          isAuthErr ? err.message : "Internal credential store error.",
        ),
      );
      return;
    }

    if (upstreamAbort.signal.aborted || res.destroyed) return;

    let upstreamResp;
    try {
      upstreamResp = await sendUpstream(validated, accessToken, upstreamAbort.signal);
      if (upstreamResp.status === 401 && !upstreamAbort.signal.aborted && authProvider.canRefresh()) {
        try {
          const refreshed = await authProvider.getAccessToken({ forceRefresh: true });
          if (refreshed && refreshed !== accessToken && !upstreamAbort.signal.aborted) {
            await upstreamResp.body?.cancel().catch(() => {});
            upstreamResp = await sendUpstream(validated, refreshed, upstreamAbort.signal);
          }
        } catch {
          // Preserve original 401 upstream response when refresh cannot recover.
        }
      }
    } catch (err) {
      if (upstreamAbort.signal.aborted || res.destroyed) return;
      writeJsonResponse(
        res,
        502,
        { "content-type": "application/json; charset=utf-8" },
        formatGatewayError(
          validated.protocol,
          "api_error",
          `Upstream request to ${config.upstreamOrigin}${validated.pathname} failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    if (upstreamAbort.signal.aborted || res.destroyed) {
      await upstreamResp.body?.cancel().catch(() => {});
      return;
    }

    if (upstreamResp.status === 429 || upstreamResp.status === 503) {
      const retryMs = parseRetryAfterMs(upstreamResp.headers.get("retry-after"), nowMs());
      if (retryMs > 0) {
        retryAfterUntilMs = Math.max(retryAfterUntilMs, nowMs() + retryMs);
      }
    }

    const outHeaders = {};
    for (const hName of SAFE_UPSTREAM_RESPONSE_HEADERS) {
      const val = upstreamResp.headers.get(hName);
      if (val !== null) {
        outHeaders[hName] = val;
      }
    }
    if (!outHeaders["content-type"]) {
      outHeaders["content-type"] = "application/json; charset=utf-8";
    }
    if (!outHeaders["cache-control"]) {
      outHeaders["cache-control"] = "no-store";
    }
    if (outHeaders["content-type"].toLowerCase().includes("text/event-stream")) {
      outHeaders["x-accel-buffering"] = "no";
    }

    res.writeHead(upstreamResp.status, outHeaders);
    res.flushHeaders();

    if (!upstreamResp.body) {
      res.end();
      return;
    }

    const reader = upstreamResp.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (upstreamAbort.signal.aborted || res.destroyed) {
          await reader.cancel().catch(() => {});
          break;
        }
        if (value && value.byteLength > 0) {
          if (!res.write(value)) {
            await waitForDrainOrClose(res);
          }
        }
      }
      if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    } catch (err) {
      if (!upstreamAbort.signal.aborted && !res.destroyed) {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      reader.releaseLock();
    }
  });

  return { server, config };
}
