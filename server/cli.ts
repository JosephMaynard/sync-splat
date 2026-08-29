// sync-splat CLI client. Talks to a *running* sync-splat server over its HTTP
// API (POST /api/text, POST /api/upload, GET /api/history, GET /api/file/:id,
// GET /api/info). Zero runtime deps beyond node builtins + global fetch, so it
// bundles to a tiny dist/server/cli.js.
//
// The whole thing is a single exported `runCli(argv, io?)` that returns an exit
// code and never calls process.exit itself, so it can be driven from tests with
// captured streams.

import { createReadStream, createWriteStream } from "node:fs";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileItem, Item, ServerInfo, ServerInfoLocked } from "../shared/types";
import { AUTH, LIMITS } from "../shared/types";

const DEFAULT_URL = "http://localhost:3011";

/** Streams the CLI reads/writes. Defaults to the process streams; tests pass
 *  in-memory replacements to capture output and feed stdin. */
export interface CliIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
}

/** A user-facing error whose message is printed as-is (prefixed "sync-splat:")
 *  and mapped to exit code 1. Anything else bubbles up as an unexpected error. */
class CliError extends Error {}

const CLI_HELP = `sync-splat — command-line client for a running sync-splat server

Usage:
  sync-splat send [text]            Send text (from the argument, or stdin if
                                    omitted or "-").
  sync-splat send <file>            Upload a file when the argument is an
  sync-splat send --file <file>     existing path.
  sync-splat history                List recent items (newest first, indexed).
  sync-splat get <index|id>         Print a text item, or stream a file's bytes
                                    to stdout (redirect it: get 0 > out.png).

Options:
  --url <url>     Server URL (default ${DEFAULT_URL}, or $SYNC_SPLAT_URL).
                  A pasted URL with #k=<token> or ?k=<token> is accepted; the
                  passcode is extracted from it automatically.
  --key <token>   Passcode, sent as the ${AUTH.header} header (or $SYNC_SPLAT_KEY).
  --file <path>   Force file upload for \`send\`.
  --text          Force \`send\` to treat its argument as literal text, even
                  when a file with that name exists.
  --out <path>    Write \`get\` output to a file instead of stdout.
  -h, --help      Show this help.
`;

const CLI_USAGE =
  'Usage: sync-splat <send|history|get> [options]  (try "sync-splat send --help")\n';

interface ParsedFlags {
  url?: string;
  key?: string;
  file?: string;
  out?: string;
  text?: boolean;
  help?: boolean;
  /** Positional (non-flag) arguments, in order. */
  _: string[];
}

/** Minimal flag parser. `valueFlags` are the long options that take a value
 *  (as `--name value` or `--name=value`); `boolFlags` take none; everything
 *  else is positional. A `--name value` whose value starts with "-" is
 *  rejected (it is almost always a typo'd/missing value — use `--name=value`
 *  to pass such a value deliberately), as is any unknown "-" token other than
 *  a bare "-" (stdin). */
function parseFlags(
  args: string[],
  valueFlags: readonly string[],
  boolFlags: readonly string[] = [],
): ParsedFlags {
  const flags: ParsedFlags = { _: [] };
  const valueSet = new Set(valueFlags);
  const boolSet = new Set(boolFlags);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--") {
      for (let j = i + 1; j < args.length; j += 1) flags._.push(args[j]);
      break;
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      if (boolSet.has(name)) {
        if (eq >= 0) throw new CliError(`--${name} does not take a value`);
        (flags as unknown as Record<string, boolean>)[name] = true;
        continue;
      }
      if (!valueSet.has(name)) {
        throw new CliError(`unknown option "--${name}"`);
      }
      let value: string | undefined;
      if (eq >= 0) {
        value = arg.slice(eq + 1);
      } else {
        value = args[i + 1];
        i += 1;
      }
      if (value === undefined) {
        throw new CliError(`--${name} requires a value`);
      }
      if (eq < 0 && value.startsWith("-")) {
        throw new CliError(
          `--${name} requires a value but got "${value}" — use --${name}=${value} if that is intentional`,
        );
      }
      (flags as unknown as Record<string, string>)[name] = value;
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new CliError(`unknown option "${arg}"`);
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

interface Target {
  baseUrl: string;
  key: string | undefined;
}

/** Pull a passcode out of a pasted URL's `#k=`/`?k=`/`?key=` and return the URL
 *  stripped of it, so the token never rides along in request paths or logs. */
function splitUrlKey(raw: string): { url: string; key: string | undefined } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: raw, key: undefined };
  }
  let key: string | undefined;
  if (parsed.hash) {
    const frag = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    const fromHash = frag.get(AUTH.fragmentParam);
    if (fromHash) key = fromHash;
    parsed.hash = "";
  }
  const fromQuery =
    parsed.searchParams.get("k") ?? parsed.searchParams.get("key");
  if (fromQuery) {
    if (!key) key = fromQuery;
    parsed.searchParams.delete("k");
    parsed.searchParams.delete("key");
  }
  return { url: parsed.toString(), key };
}

/** Resolve the server URL + passcode from flags, environment, and any token
 *  embedded in a pasted URL (explicit --key/env wins over the URL token). */
function resolveTarget(flags: ParsedFlags): Target {
  const rawUrl = flags.url ?? process.env.SYNC_SPLAT_URL ?? DEFAULT_URL;
  const { url, key: urlKey } = splitUrlKey(rawUrl);
  const key = flags.key ?? process.env.SYNC_SPLAT_KEY ?? urlKey;
  return { baseUrl: url, key };
}

function authHeaders(key: string | undefined): Record<string, string> {
  return key ? { [AUTH.header]: key } : {};
}

function endpoint(baseUrl: string, pathname: string): string {
  return new URL(pathname, baseUrl).toString();
}

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ETIMEDOUT",
]);

/** True when a fetch rejection means the server could not be reached, as
 *  opposed to some other failure (invalid header value, mid-stream error…).
 *  Node's fetch wraps the network error in `cause`; a multi-address connect
 *  surfaces an AggregateError whose own `.code` (and member errors) carry the
 *  syscall codes. */
function isConnectionFailure(err: unknown): boolean {
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (!cause || typeof cause !== "object") return false;
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return true;
  if (cause instanceof AggregateError) {
    return cause.errors.some((e) => {
      const c = (e as { code?: unknown } | null)?.code;
      return typeof c === "string" && CONNECTION_ERROR_CODES.has(c);
    });
  }
  return false;
}

/** fetch wrapper that turns "can't reach the server" transport failures into a
 *  friendly CliError. `fetch` only rejects for network/transport problems — an
 *  HTTP error status resolves normally — so HTTP error statuses are left for
 *  the caller. Only genuine connection failures get the "no server" message;
 *  any other rejection (e.g. an invalid header from a non-ASCII --key, or a
 *  content-length mismatch mid-stream) is rethrown with its real message,
 *  which undici often hides behind a generic "fetch failed" in `cause`. */
async function request(
  url: string,
  init: RequestInit,
  baseUrl: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (isConnectionFailure(err)) {
      throw new CliError(`no server at ${baseUrl} (is it running?)`);
    }
    const cause = (err as { cause?: unknown } | null)?.cause;
    const causeMessage = cause instanceof Error ? cause.message : undefined;
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(causeMessage ?? message);
  }
}

/** Map a non-2xx status to a friendly CliError. */
function statusError(status: number, what: string): CliError {
  if (status === 401) {
    return new CliError(
      "wrong or missing passcode (use --key or $SYNC_SPLAT_KEY)",
    );
  }
  if (status === 413) return new CliError(`${what} is too large for this server`);
  if (status === 503) return new CliError("server is busy, try again shortly");
  return new CliError(`${what} failed (server responded ${status})`);
}

/** Read a stream fully, rejecting as soon as it exceeds `maxBytes` so a huge
 *  (or endless) stdin can't be buffered whole before the server rejects it. */
async function readAll(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > maxBytes) {
      throw new CliError(
        `input is larger than the server's limit (${maxBytes} bytes) — send it as a file instead`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

/** The server's max text size, for capping stdin. Falls back to the built-in
 *  default when /api/info is unreachable or withholds it. */
async function getMaxTextBytes(
  baseUrl: string,
  key: string | undefined,
): Promise<number> {
  try {
    const res = await request(
      endpoint(baseUrl, "/api/info"),
      { headers: authHeaders(key) },
      baseUrl,
    );
    if (res.ok) {
      const info = (await res.json()) as Partial<ServerInfo>;
      if (typeof info.maxTextBytes === "number" && info.maxTextBytes > 0) {
        return info.maxTextBytes;
      }
    }
  } catch (err) {
    // A connection failure must surface: the caller is about to block reading
    // stdin, and swallowing "no server" here would leave `send` hanging on a
    // terminal forever against a down server. Only garbled responses (e.g. an
    // old server whose /api/info isn't JSON) fall back to the default; non-OK
    // HTTP statuses (401, 404…) never throw and fall through above.
    if (err instanceof CliError) throw err;
  }
  return LIMITS.maxTextBytes;
}

/** Await a single write so output is flushed before the caller (and, in turn,
 *  the process) moves on — important since the launcher may process.exit. */
function writeAll(
  stream: NodeJS.WritableStream,
  data: string | Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (err) => (err ? reject(err) : resolve()));
  });
}

/** Write a whole buffer to `outPath` atomically: temp file in the same
 *  directory, then rename into place. Unlike a plain writeFile this never
 *  writes through a symlink planted at the destination and never leaves a
 *  partial file behind on failure. */
async function writeFileAtomic(outPath: string, data: Buffer): Promise<void> {
  const tmp = `${outPath}.sync-splat-${randomUUID()}.part`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, outPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function isExistingFile(pathname: string): Promise<boolean> {
  try {
    return (await stat(pathname)).isFile();
  } catch {
    return false;
  }
}

/** GET /api/info. Returns the parsed payload (full or locked), or null if the
 *  server answered non-200. Connection failures still surface as CliError. */
async function fetchInfo(
  baseUrl: string,
  key: string | undefined,
): Promise<ServerInfo | ServerInfoLocked | null> {
  const res = await request(
    endpoint(baseUrl, "/api/info"),
    { headers: authHeaders(key) },
    baseUrl,
  );
  if (!res.ok) return null;
  return (await res.json()) as ServerInfo | ServerInfoLocked;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  "#x27": "'",
};

/** Crude HTML→text for printing text items: turn block/line breaks into
 *  newlines, drop the remaining tags, and decode the handful of entities the
 *  server-side capture is likely to emit. Good enough for terminal output
 *  (stdout, never re-parsed as HTML). */
function htmlToText(html: string): string {
  let s = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|pre|blockquote)\s*>/gi, "\n");
  // Strip tags to a fixpoint: one pass can leave adjacent/nested fragments, and
  // `>?` also removes an unterminated trailing tag like "<script".
  let prev: string;
  do {
    prev = s;
    s = s.replace(/<[^>]*>?/g, "");
  } while (s !== prev);
  // Decode entities in a SINGLE pass (a callback, not chained replaces) so
  // nothing is double-unescaped — e.g. "&amp;lt;" must yield "&lt;", not "<".
  s = s.replace(
    /&(nbsp|amp|lt|gt|quot|#0*39|#x0*27);/gi,
    (_m, name: string) => {
      const key = name.toLowerCase().replace(/^#x0*/, "#x").replace(/^#0*/, "#");
      return HTML_ENTITIES[key] ?? _m;
    },
  );
  s = s.replace(/\r\n?/g, "\n");
  // Neutralise terminal escape sequences so captured text can't drive the
  // receiving terminal when printed. First remove COMPLETE sequences —
  // payload included — for OSC (ESC ] … BEL/ST) and CSI/other Fe escapes, so
  // nothing like "]0;title" is left behind; then drop any remaining lone
  // control bytes. Tab (\x09) and newline (\x0a) are preserved.
  s = s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC … BEL/ST
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_]/g, "") // other two-byte Fe escapes
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ""); // lone controls
  return s.trim();
}

/** Drop lone control bytes (C0 except tab/newline, DEL, and C1 0x80–0x9f) —
 *  the same class htmlToText strips — from server-supplied strings before
 *  printing. Defense-in-depth: don't trust the server to have sanitised
 *  file names. */
function stripControlBytes(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function snippet(html: string, max = 60): string {
  const text = htmlToText(html).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Turn literal CLI text into HTML for /api/text, which stores the body as
 * renderable HTML. Escaping makes tags show verbatim (so `send "<b>x</b>"`
 * isn't interpreted and the browser can't be fed markup), control bytes are
 * dropped, and newlines become <br> so line breaks survive the round-trip
 * back through htmlToText.
 */
function textToHtml(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "<br>");
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function formatHistory(items: Item[]): string {
  const now = Date.now();
  const rows = items.map((item, i) => ({
    idx: String(i),
    kind: item.kind,
    size: item.kind === "file" ? formatBytes(item.size) : "-",
    age: formatAge(now - item.createdAt),
    label: item.kind === "file" ? stripControlBytes(item.name) : snippet(item.html),
  }));
  const header = { idx: "#", kind: "KIND", size: "SIZE", age: "AGE", label: "NAME / SNIPPET" };
  const all = [header, ...rows];
  const w = {
    idx: Math.max(...all.map((r) => r.idx.length)),
    kind: Math.max(...all.map((r) => r.kind.length)),
    size: Math.max(...all.map((r) => r.size.length)),
    age: Math.max(...all.map((r) => r.age.length)),
  };
  return (
    all
      .map(
        (r) =>
          `${pad(r.idx, w.idx)}  ${pad(r.kind, w.kind)}  ${pad(r.size, w.size)}  ${pad(r.age, w.age)}  ${r.label}`,
      )
      .join("\n") + "\n"
  );
}

function resolveItem(items: Item[], ref: string): Item | undefined {
  if (/^\d+$/.test(ref)) return items[Number(ref)];
  return items.find((item) => item.id === ref);
}

async function cmdSend(args: string[], io: CliIO): Promise<number> {
  const flags = parseFlags(args, ["url", "key", "file"], ["text"]);
  if (flags.help) {
    await writeAll(io.stdout, CLI_HELP);
    return 0;
  }
  if (flags.text && flags.file) {
    throw new CliError("--text cannot be combined with --file");
  }
  const { baseUrl, key } = resolveTarget(flags);
  const positionals = flags._;

  // "-" reads stdin and must stand alone.
  const usesStdin = positionals.includes("-");
  if (usesStdin && (positionals.length > 1 || flags.file)) {
    throw new CliError('"-" (stdin) cannot be combined with other arguments');
  }

  // Decide file vs. text: --file always uploads; a lone positional that names
  // an existing file uploads (unless --text forces literal text); multiple
  // positionals are always joined as text.
  let filePath = flags.file;
  if (
    !filePath &&
    !flags.text &&
    positionals.length === 1 &&
    positionals[0] !== "-" &&
    (await isExistingFile(positionals[0]))
  ) {
    filePath = positionals[0];
  }

  if (filePath) {
    return sendFile(filePath, baseUrl, key, io);
  }

  let text: string;
  let stdinLimit: number | undefined;
  if (!usesStdin && positionals.length > 0) {
    // Join so `sync-splat send hello world` sends "hello world".
    text = positionals.join(" ");
  } else {
    stdinLimit = await getMaxTextBytes(baseUrl, key);
    if ((io.stdin as Partial<{ isTTY: boolean }>).isTTY) {
      await writeAll(io.stderr, "reading from stdin — press Ctrl-D to end\n");
    }
    text = (await readAll(io.stdin, stdinLimit)).toString("utf8");
  }
  if (text.length === 0) {
    throw new CliError("nothing to send (empty input)");
  }

  // The body is HTML-encoded text, which can expand well beyond the raw input
  // (& → &amp; is 5×), so check what will actually be sent against the limit
  // rather than 413-ing after the raw stdin passed readAll's cap.
  const body = textToHtml(text);
  if (stdinLimit !== undefined && Buffer.byteLength(body) > stdinLimit) {
    throw new CliError(
      `input is ${Buffer.byteLength(body)} bytes once encoded for the server, ` +
        `larger than the server's limit (${stdinLimit} bytes) — send it as a file instead`,
    );
  }

  const res = await request(
    endpoint(baseUrl, "/api/text"),
    {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8", ...authHeaders(key) },
      body,
    },
    baseUrl,
  );
  if (!res.ok) throw statusError(res.status, "send");
  const item = (await res.json()) as Item;
  await writeAll(io.stdout, `${item.id}\n`);
  return 0;
}

async function sendFile(
  filePath: string,
  baseUrl: string,
  key: string | undefined,
  io: CliIO,
): Promise<number> {
  let size: number;
  try {
    const st = await stat(filePath);
    if (!st.isFile()) throw new CliError(`not a file: ${filePath}`);
    size = st.size;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`no such file: ${filePath}`);
  }

  // Friendly pre-check against the server's advertised limit (the server also
  // enforces it and would 413; this just gives a clearer message up front).
  const info = await fetchInfo(baseUrl, key);
  if (info && "maxFileBytes" in info && size > info.maxFileBytes) {
    throw new CliError(
      `file is ${formatBytes(size)}, larger than the server limit of ${formatBytes(info.maxFileBytes)}`,
    );
  }

  const url = new URL("/api/upload", baseUrl);
  url.searchParams.set("name", basename(filePath));
  const body = Readable.toWeb(
    createReadStream(filePath),
  ) as unknown as ReadableStream;

  const res = await request(
    url.toString(),
    {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(size),
        ...authHeaders(key),
      },
      body,
      // Required by fetch when the body is a stream.
      duplex: "half",
    } as RequestInit & { duplex: "half" },
    baseUrl,
  );
  if (!res.ok) throw statusError(res.status, "upload");
  const item = (await res.json()) as FileItem;
  await writeAll(io.stdout, `${item.id}\n`);
  return 0;
}

async function cmdHistory(args: string[], io: CliIO): Promise<number> {
  const flags = parseFlags(args, ["url", "key"]);
  if (flags.help) {
    await writeAll(io.stdout, CLI_HELP);
    return 0;
  }
  if (flags._.length > 0) {
    throw new CliError(`history takes no arguments (got "${flags._[0]}")`);
  }
  const { baseUrl, key } = resolveTarget(flags);
  const res = await request(
    endpoint(baseUrl, "/api/history"),
    { headers: authHeaders(key) },
    baseUrl,
  );
  if (!res.ok) throw statusError(res.status, "history");
  const items = (await res.json()) as Item[];
  if (items.length === 0) {
    await writeAll(io.stdout, "(history is empty)\n");
    return 0;
  }
  await writeAll(io.stdout, formatHistory(items));
  return 0;
}

async function cmdGet(args: string[], io: CliIO): Promise<number> {
  const flags = parseFlags(args, ["url", "key", "out"]);
  if (flags.help) {
    await writeAll(io.stdout, CLI_HELP);
    return 0;
  }
  const ref = flags._[0];
  if (!ref) throw new CliError("get requires an <index|id> argument");
  if (flags._.length > 1) {
    throw new CliError(
      `get takes a single <index|id> argument (unexpected "${flags._[1]}")`,
    );
  }
  const { baseUrl, key } = resolveTarget(flags);

  const res = await request(
    endpoint(baseUrl, "/api/history"),
    { headers: authHeaders(key) },
    baseUrl,
  );
  if (!res.ok) throw statusError(res.status, "get");
  const items = (await res.json()) as Item[];
  const item = resolveItem(items, ref);
  if (!item) throw new CliError(`no history item matches "${ref}"`);

  if (item.kind === "text") {
    const buf = Buffer.from(`${htmlToText(item.html)}\n`, "utf8");
    if (flags.out) await writeFileAtomic(flags.out, buf);
    else await writeAll(io.stdout, buf);
    return 0;
  }

  const dl = await request(
    endpoint(baseUrl, `/api/file/${item.id}`),
    { headers: authHeaders(key) },
    baseUrl,
  );
  if (!dl.ok) throw statusError(dl.status, "get");
  if (!dl.body) {
    const buf = Buffer.from(await dl.arrayBuffer());
    if (flags.out) {
      await writeFileAtomic(flags.out, buf);
    } else {
      if ((io.stdout as Partial<{ isTTY: boolean }>).isTTY) {
        throw new CliError(
          "refusing to write binary to the terminal — use --out <path> or redirect",
        );
      }
      await writeAll(io.stdout, buf);
    }
    return 0;
  }

  const source = Readable.fromWeb(
    dl.body as unknown as Parameters<typeof Readable.fromWeb>[0],
  );
  if (flags.out) {
    // Stream to a temp file in the same directory, then rename on success, so a
    // failed/partial download never clobbers an existing destination.
    const tmp = `${flags.out}.sync-splat-${randomUUID()}.part`;
    try {
      await pipeline(source, createWriteStream(tmp));
      await rename(tmp, flags.out);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  } else {
    // Refuse to spray raw bytes at an interactive terminal, which would garble
    // it; a redirect/pipe (non-TTY) streams fine.
    if ((io.stdout as Partial<{ isTTY: boolean }>).isTTY) {
      throw new CliError(
        "refusing to write binary to the terminal — use --out <path> or redirect",
      );
    }
    // Stream to stdout with backpressure so a large file isn't buffered whole;
    // end:false leaves the shared stdout open for the caller.
    await pipeline(source, io.stdout, { end: false });
  }
  return 0;
}

/**
 * Run a CLI client subcommand. `argv[0]` is the subcommand (send|history|get,
 * plus `list` as an alias for history). Returns a process exit code; never
 * calls process.exit, so callers and tests stay in control.
 */
export async function runCli(
  argv: string[],
  ioOverride?: Partial<CliIO>,
): Promise<number> {
  const io: CliIO = {
    stdout: ioOverride?.stdout ?? process.stdout,
    stderr: ioOverride?.stderr ?? process.stderr,
    stdin: ioOverride?.stdin ?? process.stdin,
  };
  const [subcommand, ...rest] = argv;

  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    await writeAll(io.stdout, CLI_HELP);
    return 0;
  }

  try {
    switch (subcommand) {
      case "send":
        return await cmdSend(rest, io);
      case "history":
      case "list":
        return await cmdHistory(rest, io);
      case "get":
        return await cmdGet(rest, io);
      default:
        await writeAll(io.stderr, `sync-splat: unknown command "${subcommand}"\n`);
        await writeAll(io.stderr, CLI_USAGE);
        return 1;
    }
  } catch (err) {
    const message =
      err instanceof CliError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    await writeAll(io.stderr, `sync-splat: ${message}\n`);
    return 1;
  }
}
