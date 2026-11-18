import { createWindowsKeychainStore } from "./keychain-win32.js";

const EXPIRY_SKEW_SECONDS = 60;

export function decodeJwtExpSeconds(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof claims.exp === "number" && Number.isFinite(claims.exp)) {
      return Math.floor(claims.exp);
    }
  } catch {
    return null;
  }
  return null;
}

export function parseExpiresAtSeconds(raw, fallbackToken) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }
    const parsedMs = Date.parse(trimmed);
    if (Number.isFinite(parsedMs)) {
      return Math.floor(parsedMs / 1000);
    }
  }
  return decodeJwtExpSeconds(fallbackToken);
}

export class MetaphorAuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "MetaphorAuthError";
    this.status = status;
  }
}

export function createMetaphorAuth({
  envAccessToken = null,
  envRefreshToken = null,
  authApiBaseUrl = "https://withmetaphor.com/api",
  keychain = createWindowsKeychainStore(),
  fetchImpl = globalThis.fetch,
  nowSeconds = () => Math.floor(Date.now() / 1000),
} = {}) {
  const cleanApiBase = authApiBaseUrl.replace(/\/+$/, "");
  const usingEnvCredentials = Boolean(envAccessToken || envRefreshToken);

  let loaded = usingEnvCredentials;
  let accessToken = envAccessToken;
  let refreshToken = envRefreshToken;
  let expiresAtSeconds = envAccessToken ? decodeJwtExpSeconds(envAccessToken) : null;
  let refreshInFlight = null;

  async function ensureLoaded() {
    if (loaded) return;
    if (!keychain) {
      throw new MetaphorAuthError(
        "METAPHOR_ACCESS_TOKEN is not set. Automatic Credential Manager lookup is only available on Windows; on macOS/Linux set METAPHOR_ACCESS_TOKEN (and optionally METAPHOR_REFRESH_TOKEN).",
        401,
      );
    }
    const stored = await keychain.readCredentials();
    accessToken = stored.accessToken;
    refreshToken = stored.refreshToken;
    expiresAtSeconds = parseExpiresAtSeconds(stored.expiresAt, stored.accessToken);
    loaded = true;
    if (!accessToken && !refreshToken) {
      throw new MetaphorAuthError(
        "No Metaphor credentials found in METAPHOR_ACCESS_TOKEN or Windows Credential Manager (sign in to the Metaphor desktop app first).",
        401,
      );
    }
  }

  function isExpiredOrExpiring() {
    if (!accessToken) return true;
    if (expiresAtSeconds === null) return false;
    return nowSeconds() + EXPIRY_SKEW_SECONDS >= expiresAtSeconds;
  }

  async function refreshAccessToken() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      let resp;
      try {
        resp = await fetchImpl(`${cleanApiBase}/auth`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ userRefreshToken: refreshToken }),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new MetaphorAuthError(
          `Metaphor auth refresh request failed: ${err instanceof Error ? err.message : String(err)}`,
          502,
        );
      }

      if (!resp.ok) {
        throw new MetaphorAuthError(
          `Metaphor auth refresh failed with HTTP ${resp.status}.`,
          resp.status === 401 || resp.status === 403 ? 401 : 502,
        );
      }

      let payload;
      try {
        payload = await resp.json();
      } catch {
        throw new MetaphorAuthError("Failed to parse Metaphor auth refresh JSON response.", 502);
      }

      const nextAccess =
        typeof payload?.accessToken === "string" && payload.accessToken.trim()
          ? payload.accessToken.trim()
          : null;
      if (!nextAccess) {
        throw new MetaphorAuthError("Metaphor auth refresh response did not include accessToken.", 502);
      }

      const nextRefreshCandidate =
        typeof payload?.userRefreshToken === "string" && payload.userRefreshToken.trim()
          ? payload.userRefreshToken.trim()
          : typeof payload?.refreshToken === "string" && payload.refreshToken.trim()
            ? payload.refreshToken.trim()
            : null;
      const nextExpiresAt = parseExpiresAtSeconds(payload?.expiresAt, nextAccess);

      accessToken = nextAccess;
      expiresAtSeconds = nextExpiresAt;
      if (nextRefreshCandidate) {
        refreshToken = nextRefreshCandidate;
      }

      if (!usingEnvCredentials && keychain) {
        await keychain.writeCredentials({
          accessToken,
          expiresAt: expiresAtSeconds !== null ? String(expiresAtSeconds) : null,
          refreshToken: nextRefreshCandidate ?? null,
        });
      }

      return accessToken;
    })();

    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  return {
    async getAccessToken({ forceRefresh = false } = {}) {
      await ensureLoaded();
      if (forceRefresh || isExpiredOrExpiring()) {
        if (!refreshToken) {
          if (forceRefresh || !accessToken) {
            throw new MetaphorAuthError(
              "Metaphor access token is missing or rejected and no refresh token is configured.",
              401,
            );
          }
          return accessToken;
        }
        return refreshAccessToken();
      }
      return accessToken;
    },

    canRefresh() {
      return Boolean(refreshToken);
    },
  };
}
