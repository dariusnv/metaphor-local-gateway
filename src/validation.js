import { timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const SAFE_FORWARD_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "session_id",
  "x-client-request-id",
]);

const ROUTE_SPECS = new Map([
  ["/v1/models", { method: "GET", protocol: "openai" }],
  ["/v1/chat/completions", { method: "POST", protocol: "openai" }],
  ["/v1/responses", { method: "POST", protocol: "openai" }],
  ["/v1/messages", { method: "POST", protocol: "anthropic" }],
]);

export function formatGatewayError(protocol, type, message) {
  if (protocol === "anthropic") {
    return JSON.stringify({
      type: "error",
      error: { type, message },
    });
  }
  return JSON.stringify({
    error: {
      message,
      type,
      code: type,
    },
  });
}

function fail(protocol, status, type, message, extraHeaders = {}) {
  return {
    ok: false,
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
    body: formatGatewayError(protocol, type, message),
  };
}

function parseHttpBaseUrl(raw, envName) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid ${envName}="${raw}".`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported ${envName} protocol "${parsed.protocol}".`);
  }
  return raw.replace(/\/+$/, "");
}

export function validateGatewayConfig(env = process.env) {
  const host = (env.HOST ?? "127.0.0.1").trim();
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error(
      `Refusing non-loopback HOST="${host}". Metaphor Local Gateway only binds to loopback (127.0.0.1, ::1, or localhost).`,
    );
  }

  const rawPort = String(env.PORT ?? "8080").trim();
  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`Invalid PORT="${rawPort}". Must be an integer between 0 and 65535.`);
  }
  const port = Number.parseInt(rawPort, 10);
  if (port < 0 || port > 65535) {
    throw new Error(`Invalid PORT=${port}. Must be between 0 and 65535.`);
  }

  const upstreamOrigin = parseHttpBaseUrl(
    (env.METAPHOR_UPSTREAM ?? "https://llms.withmetaphor.com").trim(),
    "METAPHOR_UPSTREAM",
  );
  const authApiBaseUrl = parseHttpBaseUrl(
    (env.METAPHOR_API_URL ?? "https://withmetaphor.com/api").trim(),
    "METAPHOR_API_URL",
  );

  return {
    host,
    port,
    upstreamOrigin,
    authApiBaseUrl,
    localApiKey: env.LOCAL_API_KEY?.trim() || null,
    envAccessToken: env.METAPHOR_ACCESS_TOKEN?.trim() || null,
    envRefreshToken: env.METAPHOR_REFRESH_TOKEN?.trim() || null,
  };
}

function safeEqualStrings(expected, candidate) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(candidate, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function authenticateLocalRequest(headers, expectedLocalKey) {
  if (!expectedLocalKey) return true;

  const authHeader = typeof headers.authorization === "string" ? headers.authorization.trim() : "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const bearer = authHeader.slice(7).trim();
    if (bearer && safeEqualStrings(expectedLocalKey, bearer)) {
      return true;
    }
  }

  const xApiKey = typeof headers["x-api-key"] === "string" ? headers["x-api-key"].trim() : "";
  if (xApiKey && safeEqualStrings(expectedLocalKey, xApiKey)) {
    return true;
  }

  return false;
}

function buildSanitizedForwardHeaders(incomingHeaders) {
  const out = {};
  for (const [rawName, rawValue] of Object.entries(incomingHeaders)) {
    const name = rawName.toLowerCase();
    if (!SAFE_FORWARD_REQUEST_HEADERS.has(name)) continue;
    if (typeof rawValue === "string" && rawValue.trim()) {
      out[name] = rawValue.trim();
    } else if (Array.isArray(rawValue) && rawValue.length > 0) {
      out[name] = rawValue.join(", ");
    }
  }
  return out;
}

export function validateRequestEnvelope({ method, rawUrl, headers, localApiKey }) {
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl || "/", "http://127.0.0.1");
  } catch {
    return fail("openai", 400, "invalid_request_error", "Malformed request URL.");
  }

  const pathname = parsedUrl.pathname;
  const spec = ROUTE_SPECS.get(pathname);
  const protocol = spec?.protocol ?? "openai";

  if (!authenticateLocalRequest(headers, localApiKey)) {
    return fail(protocol, 401, "authentication_error", "Invalid or missing local gateway API key.");
  }

  if (!spec) {
    return fail(
      "openai",
      404,
      "not_found_error",
      `Unsupported route "${pathname}". Supported routes: GET /v1/models, POST /v1/chat/completions, POST /v1/responses, POST /v1/messages.`,
    );
  }

  const upperMethod = (method || "").toUpperCase();
  if (upperMethod !== spec.method) {
    return fail(
      spec.protocol,
      405,
      "invalid_request_error",
      `Method ${upperMethod} not allowed on ${pathname}; expected ${spec.method}.`,
      { allow: spec.method },
    );
  }

  const forwardHeaders = buildSanitizedForwardHeaders(headers);

  if (spec.method === "POST") {
    const contentType = (forwardHeaders["content-type"] || "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      return fail(spec.protocol, 415, "invalid_request_error", "Content-Type must be application/json.");
    }
  }

  return {
    ok: true,
    value: {
      method: spec.method,
      pathname,
      protocol: spec.protocol,
      forwardHeaders,
    },
  };
}

export function validatePostBody(envelope, rawBodyBuffer) {
  const { pathname, protocol } = envelope;

  if (!rawBodyBuffer || rawBodyBuffer.length === 0) {
    return fail(protocol, 400, "invalid_request_error", "Request body must not be empty.");
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBodyBuffer.toString("utf8"));
  } catch {
    return fail(protocol, 400, "invalid_request_error", "Request body must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail(protocol, 400, "invalid_request_error", "Request JSON root must be an object.");
  }

  if (typeof parsed.model !== "string" || !parsed.model || /[\s\0-\x1f]/.test(parsed.model)) {
    return fail(
      protocol,
      400,
      "invalid_request_error",
      "`model` is required and must be a non-empty model identifier without whitespace.",
    );
  }

  if (parsed.stream !== undefined && typeof parsed.stream !== "boolean") {
    return fail(protocol, 400, "invalid_request_error", "`stream` must be a boolean when provided.");
  }

  if (pathname === "/v1/chat/completions") {
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      return fail(protocol, 400, "invalid_request_error", "`messages` must be a non-empty array for /v1/chat/completions.");
    }
  } else if (pathname === "/v1/responses") {
    const validInput =
      (typeof parsed.input === "string" && parsed.input.length > 0) ||
      (Array.isArray(parsed.input) && parsed.input.length > 0);
    if (!validInput) {
      return fail(protocol, 400, "invalid_request_error", "`input` is required (non-empty string or array) for /v1/responses.");
    }
  } else if (pathname === "/v1/messages") {
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      return fail(protocol, 400, "invalid_request_error", "`messages` must be a non-empty array for /v1/messages.");
    }
    if (typeof parsed.max_tokens !== "number" || !Number.isInteger(parsed.max_tokens) || parsed.max_tokens <= 0) {
      return fail(protocol, 400, "invalid_request_error", "`max_tokens` must be a positive integer for /v1/messages.");
    }
  }

  return {
    ok: true,
    value: {
      ...envelope,
      stream: parsed.stream === true,
      rawBodyBuffer,
    },
  };
}
