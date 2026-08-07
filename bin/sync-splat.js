#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `sync-splat — share text and small files across your local network

Usage: sync-splat [options]

Options:
  -p, --port <n>            Port to listen on (default 3011, or $PORT)
      --max-file-size <MB>  Max single upload size in megabytes (default 20)
      --share <path>        Folder to share for browse/upload (default: current
                            directory). Dotfiles are never listed or served.
      --no-share            Disable folder sharing entirely
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
    } else if (arg === "--no-share") {
      opts.share = null;
    } else if (arg === "--share") {
      if (i + 1 >= argv.length) {
        console.error("sync-splat: --share requires a folder path");
        console.error("Run `sync-splat --help` for usage.");
        process.exit(1);
      }
      opts.share = argv[++i];
    } else if (arg.startsWith("--share=")) {
      opts.share = arg.slice("--share=".length);
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

// undefined → share cwd (factory default); null → --no-share; string → --share.
let shareDir;
if (args.share === null) {
  shareDir = null;
} else if (args.share !== undefined) {
  if (typeof args.share !== "string" || args.share === "") {
    console.error("sync-splat: --share requires a folder path");
    process.exit(1);
  }
  shareDir = path.resolve(args.share);
  let stat;
  try {
    stat = statSync(shareDir);
  } catch {
    console.error(`sync-splat: --share folder does not exist: ${shareDir}`);
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    console.error(`sync-splat: --share path is not a directory: ${shareDir}`);
    process.exit(1);
  }
}

const entryUrl = new URL("../dist/server/index.js", import.meta.url);
if (!existsSync(fileURLToPath(entryUrl))) {
  console.error("sync-splat: server build not found (dist/server/index.js).");
  console.error("If you cloned the repo, run `pnpm build` first.");
  console.error("If you installed from npm, try reinstalling the package.");
  process.exit(1);
}

const { createSyncSplatServer } = await import(entryUrl.href);

let server;
try {
  server = await createSyncSplatServer({
    port,
    maxFileBytes,
    shareDir,
    banner: true,
  });
} catch (err) {
  if (err && err.code === "EADDRINUSE") {
    console.error(`sync-splat: port ${port} is already in use.`);
    console.error("Pick another with `sync-splat --port <n>`.");
  } else {
    console.error(`sync-splat: failed to start — ${err?.message ?? err}`);
  }
  process.exit(1);
}

function shutdown() {
  // Force-exit fallback in case socket.io blocks close (e.g. mid-upgrade).
  setTimeout(() => process.exit(0), 3000).unref();
  server
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
