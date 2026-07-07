#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HELP = `sync-splat — share text and small files across your local network

Usage: sync-splat [options]

Options:
  -p, --port <n>            Port to listen on (default 3011, or $PORT)
      --max-file-size <MB>  Max single upload size in megabytes (default 20)
  -h, --help                Show this help

Once running, open the printed URL on another device — or scan the QR code.
Use only on networks you trust: there is no authentication or encryption.
`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--port" || arg === "-p") {
      opts.port = Number(argv[++i]);
    } else if (arg.startsWith("--port=")) {
      opts.port = Number(arg.slice("--port=".length));
    } else if (arg === "--max-file-size") {
      opts.maxFileMb = Number(argv[++i]);
    } else if (arg.startsWith("--max-file-size=")) {
      opts.maxFileMb = Number(arg.slice("--max-file-size=".length));
    } else {
      console.error(`sync-splat: unknown argument "${arg}"`);
      console.error("Run `sync-splat --help` for usage.");
      process.exit(1);
    }
  }
  return opts;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(HELP);
  process.exit(0);
}

// Flag wins over PORT env, which wins over the default.
const port =
  args.port !== undefined
    ? args.port
    : process.env.PORT
      ? Number(process.env.PORT)
      : 3011;

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`sync-splat: invalid port "${port}"`);
  process.exit(1);
}

let maxFileBytes;
if (args.maxFileMb !== undefined) {
  if (!Number.isFinite(args.maxFileMb) || args.maxFileMb <= 0) {
    console.error(`sync-splat: invalid --max-file-size "${args.maxFileMb}"`);
    process.exit(1);
  }
  maxFileBytes = Math.floor(args.maxFileMb * 1024 * 1024);
}

const entryUrl = new URL("../dist/server/index.js", import.meta.url);
if (!existsSync(fileURLToPath(entryUrl))) {
  console.error("sync-splat: server build not found (dist/server/index.js).");
  console.error("If you cloned the repo, run `pnpm build` first.");
  console.error("If you installed from npm, try reinstalling the package.");
  process.exit(1);
}

const { createSyncSplatServer } = await import(entryUrl.href);

const server = await createSyncSplatServer({ port, maxFileBytes, banner: true });

function shutdown() {
  server
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
