#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createGatewayServer } from "./server.js";

const VERSION = "0.1.0";
const HELP_TEXT = `metaphor-local-gateway v${VERSION}

Loopback multi-protocol inference proxy for Metaphor (https://llms.withmetaphor.com).

Usage:
  metaphor-local-gateway [--host 127.0.0.1] [--port 8080]

Options:
  -h, --help          Show this help message and exit
  -v, --version       Print version and exit
      --host <addr>   Loopback bind address (127.0.0.1, ::1, or localhost; overrides HOST)
      --port <port>   Listen port 0-65535 (overrides PORT)

Authentication:
  - Windows: automatically reads workos_*.com.metaphor.app from Credential Manager
    when METAPHOR_ACCESS_TOKEN is unset, and persists rotated tokens on refresh.
  - macOS / Linux / CI: set METAPHOR_ACCESS_TOKEN (and optional METAPHOR_REFRESH_TOKEN).
  - Optional LOCAL_API_KEY requires local clients to pass Authorization: Bearer <key>
    or x-api-key: <key> (never forwarded upstream).
`;

let cliOptions;
try {
  cliOptions = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      host: { type: "string" },
      port: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\nRun with --help for usage.\n`);
  process.exit(1);
}

if (cliOptions.values.help) {
  process.stdout.write(HELP_TEXT);
  process.exit(0);
}

if (cliOptions.values.version) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envPath);
}

const effectiveEnv = {
  ...process.env,
  ...(cliOptions.values.host !== undefined ? { HOST: cliOptions.values.host } : {}),
  ...(cliOptions.values.port !== undefined ? { PORT: cliOptions.values.port } : {}),
};

let server;
let config;
try {
  ({ server, config } = createGatewayServer({ env: effectiveEnv }));
} catch (err) {
  process.stderr.write(`Configuration error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

server.on("error", (err) => {
  process.stderr.write(`Server error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : config.port;
  process.stdout.write(
    `metaphor-local-gateway listening on http://${config.host}:${actualPort} -> ${config.upstreamOrigin}\n`,
  );
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.closeIdleConnections?.();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(0);
  }, 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
