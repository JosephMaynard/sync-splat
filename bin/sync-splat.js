#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { randomInt } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `sync-splat — share text and small files across your local network

SERVER (default) — run a server others connect to:
  Usage: sync-splat [options]

Options:
  -p, --port <n>            Port to listen on (default 3011, or $PORT)
      --max-file-size <MB>  Max single upload size in megabytes (default 20)
      --share [path]        Enable the folder browser (off by default). With no
                            value it shares the current directory; pass a path to
                            share that instead. Dotfiles are never listed/served.
      --pin [value]         Require a passcode. With no value one is generated;
                            it is embedded in the printed URLs/QR so a scan just
                            works. Gates reads and writes (not the static shell).
  -h, --help                Show this help

Once running, open the printed URL on another device — or scan the QR code.

CLIENT — talk to a running server from the terminal:
  sync-splat send [text]        Send text (argument or stdin)
  sync-splat send <file>        Upload a file
  sync-splat history            List recent items (indexed, newest first)
  sync-splat get <index|id>     Print text, or stream a file's bytes to stdout

Client options: --url <url> (or $SYNC_SPLAT_URL), --key <token> (or
$SYNC_SPLAT_KEY), --file <path>, --out <path>. Run \`sync-splat send --help\`
for details.

Use only on networks you trust: traffic is not encrypted. A passcode (--pin)
gates access but is not a substitute for TLS.
`;

// Client subcommands are handled by the CLI client module, not the server path.
const CLIENT_SUBCOMMANDS = new Set(["send", "history", "get", "list"]);

const userArgs = process.argv.slice(2);

// Dispatch to the CLI client when the first argument is a client subcommand.
// Everything else (flags, no args) runs the server exactly as before. A single
// top-level catch turns any stray rejection (e.g. a failed dynamic import) into
// the CLI's error style instead of an unhandled-rejection stack trace.
try {
  if (CLIENT_SUBCOMMANDS.has(userArgs[0])) {
    const cliUrl = new URL("../dist/server/cli.js", import.meta.url);
    if (!existsSync(fileURLToPath(cliUrl))) {
      console.error("sync-splat: client build not found (dist/server/cli.js).");
      console.error("If you cloned the repo, run `pnpm build` first.");
      console.error("If you installed from npm, try reinstalling the package.");
      process.exit(1);
    }
    const { runCli } = await import(cliUrl.href);
    // Set exitCode rather than process.exit so buffered stdout flushes cleanly
    // even when output is redirected to a pipe or file.
    process.exitCode = await runCli(userArgs);
  } else {
    await runServer(userArgs);
  }
} catch (err) {
  console.error(`sync-splat: ${err?.message ?? err}`);
  process.exitCode = 1;
}

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
      // Sharing is off by default now; accept for back-compat, but it's a no-op.
      opts.share = false;
    } else if (arg === "--share") {
      // Optional value: bare --share shares cwd; a following non-flag is a path.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        opts.share = argv[++i];
      } else {
        opts.share = true; // share the current directory
      }
    } else if (arg.startsWith("--share=")) {
      opts.share = arg.slice("--share=".length);
    } else if (arg === "--pin") {
      // Optional value: consume the next token only when it isn't another flag.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        opts.pin = argv[++i];
      } else {
        opts.pin = true; // auto-generate
      }
    } else if (arg.startsWith("--pin=")) {
      opts.pin = arg.slice("--pin=".length);
    } else {
      console.error(`sync-splat: unknown argument "${arg}"`);
      console.error("Run `sync-splat --help` for usage.");
      process.exit(1);
    }
  }
  return opts;
}

// URL-safe alphabet without visually ambiguous characters (o/0/l/1/i) so a
// passcode is easy to read off a screen and retype.
const PIN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function generatePin(length = 10) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    // randomInt does unbiased rejection sampling; `byte % alphabet.length`
    // would skew toward the first (256 % 31) characters.
    out += PIN_ALPHABET[randomInt(PIN_ALPHABET.length)];
  }
  return out;
}

async function runServer(argv) {
  const args = parseArgs(argv);

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

  // Sharing is off by default. undefined / false (--no-share) → off; true
  // (bare --share) → cwd; a string → that directory.
  let shareDir;
  if (args.share === true) {
    shareDir = process.cwd();
  } else if (typeof args.share === "string" && args.share !== "") {
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

  // null → no passcode; true → generate one; string → use it verbatim.
  let token = null;
  if (args.pin === true) {
    token = generatePin();
  } else if (typeof args.pin === "string") {
    if (args.pin === "") {
      console.error("sync-splat: --pin value cannot be empty");
      process.exit(1);
    }
    // A custom pin must survive every transport: it rides an HTTP header
    // (ISO-8859-1 only, no controls) and a URL fragment the client trims.
    // Restrict to printable ASCII with no whitespace so it can't
    // authenticate on one client and silently fail on another.
    if (!/^[\x21-\x7e]+$/.test(args.pin)) {
      console.error(
        "sync-splat: --pin must be printable ASCII with no spaces " +
          "(so it works over HTTP headers and QR/URL fragments)",
      );
      process.exit(1);
    }
    token = args.pin;
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
      token,
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
}
