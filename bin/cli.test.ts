import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Readable, Writable } from "node:stream";
import { createSyncSplatServer, type SyncSplatServer } from "../server/index";
import { runCli, type CliIO } from "../server/cli";
import { AUTH, DEVICE_HEADER } from "../shared/types";

let server: SyncSplatServer | undefined;
let baseUrl = "";
let tmpDir: string | undefined;

async function start(
  opts: Partial<Parameters<typeof createSyncSplatServer>[0]> = {},
): Promise<void> {
  server = await createSyncSplatServer({ port: 0, host: "127.0.0.1", ...opts });
  baseUrl = `http://127.0.0.1:${server.address.port}`;
}

/** In-memory CLI streams so we can inspect output as bytes and feed stdin. */
function makeIO(stdin: Buffer | string = "") {
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      outChunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      errChunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const stdinBuf = Buffer.isBuffer(stdin) ? stdin : Buffer.from(stdin, "utf8");
  return {
    io: { stdout, stderr, stdin: Readable.from([stdinBuf]) },
    out: () => Buffer.concat(outChunks),
    outText: () => Buffer.concat(outChunks).toString("utf8"),
    errText: () => Buffer.concat(errChunks).toString("utf8"),
  };
}

/** An ephemeral port that was just bound and released, so connecting to it is
 *  refused. (Port 1 won't do: fetch rejects it up front as a "bad port".) */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("runCli send/history/get", () => {
  it("send text → appears in history and round-trips via get", async () => {
    await start();

    const send = makeIO();
    const code = await runCli(["send", "hello splat ✨", "--url", baseUrl], send.io);
    expect(code).toBe(0);
    const id = send.outText().trim();
    expect(id.length).toBeGreaterThan(0);

    const hist = makeIO();
    expect(await runCli(["history", "--url", baseUrl], hist.io)).toBe(0);
    expect(hist.outText()).toContain("hello splat");
    expect(hist.outText()).toContain("text");

    const got = makeIO();
    expect(await runCli(["get", "0", "--url", baseUrl], got.io)).toBe(0);
    expect(got.outText().trim()).toBe("hello splat ✨");
  });

  it("send joins multiple positionals into one text item", async () => {
    await start();
    const send = makeIO();
    expect(
      await runCli(["send", "hello", "world", "--url", baseUrl], send.io),
    ).toBe(0);

    const got = makeIO();
    await runCli(["get", "0", "--url", baseUrl], got.io);
    expect(got.outText().trim()).toBe("hello world");
  });

  it("send --text forces literal text even when a file with that name exists", async () => {
    await start();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-splat-cli-"));
    const filePath = path.join(tmpDir, "todo");
    fs.writeFileSync(filePath, "file contents, not what we want sent");

    const send = makeIO();
    expect(
      await runCli(["send", filePath, "--text", "--url", baseUrl], send.io),
    ).toBe(0);

    const got = makeIO();
    await runCli(["get", "0", "--url", baseUrl], got.io);
    // The literal argument (the path string) was sent, not the file's bytes.
    expect(got.outText().trim()).toBe(filePath);

    const hist = makeIO();
    await runCli(["history", "--url", baseUrl], hist.io);
    expect(hist.outText()).toContain("text");
  });

  it("send reads text from stdin when the argument is omitted", async () => {
    await start();
    const send = makeIO("from stdin\n");
    expect(await runCli(["send", "--url", baseUrl], send.io)).toBe(0);

    const got = makeIO();
    await runCli(["get", "0", "--url", baseUrl], got.io);
    expect(got.outText().trim()).toBe("from stdin");
  });

  it("send a file → get by index streams identical bytes", async () => {
    await start();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-splat-cli-"));
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254]);
    const filePath = path.join(tmpDir, "blob.png");
    fs.writeFileSync(filePath, bytes);

    const send = makeIO();
    expect(await runCli(["send", filePath, "--url", baseUrl], send.io)).toBe(0);
    expect(send.outText().trim().length).toBeGreaterThan(0);

    const hist = makeIO();
    await runCli(["history", "--url", baseUrl], hist.io);
    expect(hist.outText()).toContain("blob.png");

    const got = makeIO();
    expect(await runCli(["get", "0", "--url", baseUrl], got.io)).toBe(0);
    expect(got.out().equals(bytes)).toBe(true);
  });

  it("send --file writes get --out to a file with identical bytes", async () => {
    await start();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-splat-cli-"));
    const bytes = Buffer.from("binary\0data\xff", "binary");
    const src = path.join(tmpDir, "data.bin");
    fs.writeFileSync(src, bytes);

    const send = makeIO();
    expect(
      await runCli(["send", "--file", src, "--url", baseUrl], send.io),
    ).toBe(0);
    const id = send.outText().trim();

    const outPath = path.join(tmpDir, "out.bin");
    const got = makeIO();
    expect(
      await runCli(["get", id, "--out", outPath, "--url", baseUrl], got.io),
    ).toBe(0);
    expect(fs.readFileSync(outPath).equals(bytes)).toBe(true);
  });

  it("get by full id resolves the same item", async () => {
    await start();
    const send = makeIO();
    await runCli(["send", "by id please", "--url", baseUrl], send.io);
    const id = send.outText().trim();

    const got = makeIO();
    expect(await runCli(["get", id, "--url", baseUrl], got.io)).toBe(0);
    expect(got.outText().trim()).toBe("by id please");
  });

  it("sends HTML-looking text literally and round-trips it via get", async () => {
    await start();
    const input = "<script>x</script> a & b <c>";
    const send = makeIO();
    expect(await runCli(["send", input, "--url", baseUrl], send.io)).toBe(0);

    const got = makeIO();
    await runCli(["get", "0", "--url", baseUrl], got.io);
    // Tags are not interpreted; the text comes back exactly as sent.
    expect(got.outText().trim()).toBe(input);
  });

  it("strips terminal control sequences from get output", async () => {
    await start();
    const ESC = "\x1b";
    const BEL = "\x07";
    // Inject raw control bytes straight into the store (bypassing the CLI's own
    // send-side sanitiser) to exercise get's hardening on the READ path — the
    // defense that matters for text posted by other, untrusted clients.
    await fetch(`${baseUrl}/api/text`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: `${ESC}]0;PWNED${BEL}hello`,
    });

    const got = makeIO();
    await runCli(["get", "0", "--url", baseUrl], got.io);
    const out = got.outText();
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
    // The whole OSC sequence is removed, payload included — not just the
    // control bytes — so no "PWNED" remnant survives.
    expect(out).not.toContain("PWNED");
    expect(out.trim()).toBe("hello");
  });
});

describe("runCli errors", () => {
  it("unknown subcommand exits non-zero with usage", async () => {
    const io = makeIO();
    const code = await runCli(["frobnicate"], io.io);
    expect(code).not.toBe(0);
    expect(io.errText()).toContain("unknown command");
  });

  it("no server running → friendly connection error, non-zero", async () => {
    const io = makeIO();
    const code = await runCli(
      ["history", "--url", `http://127.0.0.1:${await closedPort()}`],
      io.io,
    );
    expect(code).not.toBe(0);
    expect(io.errText()).toContain("no server at");
  });

  it("get with no argument exits non-zero", async () => {
    await start();
    const io = makeIO();
    expect(await runCli(["get", "--url", baseUrl], io.io)).not.toBe(0);
  });

  it("a value flag refuses to consume a following flag-like token", async () => {
    // Without this, `get 0 --out --url http://h` would set out="--url" and
    // treat the URL as a positional.
    const io = makeIO();
    expect(await runCli(["get", "0", "--out", "-x"], io.io)).not.toBe(0);
    expect(io.errText()).toContain("--out requires a value");
    expect(io.errText()).toContain("--out=-x");
  });

  it("rejects unknown single-dash options instead of treating them as positionals", async () => {
    const io = makeIO();
    expect(await runCli(["get", "0", "-o", "out.bin"], io.io)).not.toBe(0);
    expect(io.errText()).toContain('unknown option "-o"');
  });

  it("get rejects surplus positional arguments", async () => {
    const io = makeIO();
    expect(await runCli(["get", "0", "1"], io.io)).not.toBe(0);
    expect(io.errText()).toContain("single");
  });

  it("history rejects positional arguments", async () => {
    const io = makeIO();
    expect(await runCli(["history", "0"], io.io)).not.toBe(0);
    expect(io.errText()).toContain("takes no arguments");
  });

  it("send --text --file is rejected", async () => {
    const io = makeIO();
    expect(
      await runCli(["send", "x", "--text", "--file", "whatever"], io.io),
    ).not.toBe(0);
    expect(io.errText()).toContain("--text cannot be combined with --file");
  });

  it("send from stdin against a down server fails fast with a connection error", async () => {
    // Regression: getMaxTextBytes used to swallow the connection error, so
    // `send` would block on stdin forever against a down server. Use a stdin
    // stream that never ends so a hang would trip the timeout.
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const sink = (chunks: Buffer[]) =>
      new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });
    const neverEnds = new Readable({ read() {} });
    const code = await runCli(
      ["send", "--url", `http://127.0.0.1:${await closedPort()}`],
      { stdout: sink(outChunks), stderr: sink(errChunks), stdin: neverEnds },
    );
    expect(code).not.toBe(0);
    expect(Buffer.concat(errChunks).toString("utf8")).toContain("no server at");
  }, 5000);
});

describe("runCli against a passcoded server", () => {
  const token = "swordfish7";

  it("wrong key → non-zero, missing key → non-zero, right key works", async () => {
    await start({ token });

    const missing = makeIO();
    expect(
      await runCli(["history", "--url", baseUrl], missing.io),
    ).not.toBe(0);
    expect(missing.errText()).toContain("passcode");

    const wrong = makeIO();
    expect(
      await runCli(["history", "--key", "nope", "--url", baseUrl], wrong.io),
    ).not.toBe(0);

    const right = makeIO();
    expect(
      await runCli(["send", "secret note", "--key", token, "--url", baseUrl], right.io),
    ).toBe(0);

    const list = makeIO();
    expect(
      await runCli(["history", "--key", token, "--url", baseUrl], list.io),
    ).toBe(0);
    expect(list.outText()).toContain("secret note");
  });

  it("extracts the key from a URL fragment (#k=...)", async () => {
    await start({ token });
    const io = makeIO();
    expect(
      await runCli(["send", "via fragment", "--url", `${baseUrl}/#k=${token}`], io.io),
    ).toBe(0);
  });
});

describe("runCli --help", () => {
  it("prints client usage and exits 0", async () => {
    const io = makeIO();
    expect(await runCli(["--help"], io.io)).toBe(0);
    expect(io.outText()).toContain("sync-splat send");
    expect(io.outText()).toContain("--url");
  });
});

/* ---------------------------------------------------------------------------
 * watch
 *
 * /api/events isn't necessarily implemented in this checkout yet (another
 * agent is building it in parallel), so these drive `watch` against a small
 * hand-rolled node:http stub that speaks the documented SSE contract, rather
 * than the real server.
 * ------------------------------------------------------------------------- */

interface EventsStubOptions {
  /** When set, /api/events requires this exact ${AUTH.header} value. */
  token?: string;
  /** Answer every /api/events request with this status instead of a stream
   *  (used for the 401/404 tests — auth above still runs first). */
  status?: number;
  /** Invoked for each request that reaches an actual SSE connection, so the
   *  test can write events on it, end it, or leave it open. */
  onConnect?: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  /** Bytes served at GET /api/file/:id, keyed by id. */
  files?: Record<string, Buffer>;
}

interface EventsStub {
  baseUrl: string;
  /** Raw ${DEVICE_HEADER} values as received, in request order. */
  rawDeviceHeaders: string[];
  /** Same, decodeURIComponent'd (what the server is documented to do). */
  deviceHeaders: string[];
  requestCount: () => number;
  close: () => Promise<void>;
}

function startEventsStub(opts: EventsStubOptions = {}): Promise<EventsStub> {
  const rawDeviceHeaders: string[] = [];
  const deviceHeaders: string[] = [];
  let count = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub.invalid");
    if (url.pathname === "/api/events") {
      count += 1;
      if (opts.token !== undefined) {
        const key = req.headers[AUTH.header];
        if (key !== opts.token) {
          res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
          return;
        }
      }
      const raw = req.headers[DEVICE_HEADER];
      if (typeof raw === "string") {
        rawDeviceHeaders.push(raw);
        try {
          deviceHeaders.push(decodeURIComponent(raw));
        } catch {
          deviceHeaders.push(raw);
        }
      }
      if (opts.status !== undefined) {
        res.writeHead(opts.status, { "content-type": "text/plain" }).end("nope");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      opts.onConnect?.(req, res);
      return;
    }
    const fileMatch = /^\/api\/file\/(.+)$/.exec(url.pathname);
    if (fileMatch) {
      const bytes = opts.files?.[fileMatch[1]];
      if (!bytes) {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.length),
        })
        .end(bytes);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        rawDeviceHeaders,
        deviceHeaders,
        requestCount: () => count,
        close: () =>
          new Promise((res2) => {
            server.closeAllConnections?.();
            server.close(() => res2());
          }),
      });
    });
  });
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Poll until `check()` is true or `timeoutMs` elapses, for asserting on
 *  output produced by a `watch` run that's still going in the background. */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Like makeIO, but for `watch`: adds a fast, injectable backoff/watchdog
 *  (so reconnect tests don't run at real-world speed) and an AbortController
 *  the test uses to stop the run, on top of everything makeIO gives. */
function makeWatchIO(overrides: Partial<CliIO> = {}) {
  const base = makeIO();
  const controller = new AbortController();
  const io: CliIO = {
    ...base.io,
    signal: controller.signal,
    watchBackoffMs: [10, 20],
    watchWatchdogMs: 300,
    ...overrides,
  };
  return { ...base, io, controller };
}

describe("runCli watch", () => {
  const stubs: EventsStub[] = [];
  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((s) => s.close()));
  });

  it("prints text items as plain text and file items as name + size in human mode", async () => {
    const stub = await startEventsStub({
      onConnect: (_req, res) => {
        res.write(sseEvent("hello", { version: "0.5.0" }));
        res.write(
          sseEvent("item:new", {
            id: "t1",
            kind: "text",
            html: "hi <b>there</b>",
            createdAt: Date.now(),
          }),
        );
        res.write(
          sseEvent("item:new", {
            id: "f1",
            kind: "file",
            name: "photo.png",
            size: 12345,
            mime: "image/png",
            createdAt: Date.now(),
          }),
        );
      },
    });
    stubs.push(stub);
    const { io, outText, errText, controller } = makeWatchIO();
    const run = runCli(["watch", "--url", stub.baseUrl], io);
    await waitFor(() => outText().includes("photo.png"));
    controller.abort();
    expect(await run).toBe(0);
    expect(outText()).toContain("hi there");
    expect(outText()).toMatch(/file: photo\.png \([\d.]+ KB\)/);
    // resolveTarget round-trips the URL through the WHATWG URL parser, which
    // normalizes a bare origin to include a trailing "/".
    expect(errText()).toContain(`watching ${new URL(stub.baseUrl).toString()} — Ctrl-C to stop`);
  });

  it("ignores item:deleted in human mode but emits it in --json mode", async () => {
    const stub = await startEventsStub({
      onConnect: (_req, res) => {
        res.write(sseEvent("hello", { version: "0.5.0" }));
        res.write(sseEvent("item:new", { id: "t1", kind: "text", html: "x", createdAt: 1 }));
        res.write(sseEvent("item:deleted", { id: "t1" }));
      },
    });
    stubs.push(stub);

    const human = makeWatchIO();
    const runHuman = runCli(["watch", "--url", stub.baseUrl], human.io);
    await waitFor(() => human.outText().includes("x"));
    human.controller.abort();
    expect(await runHuman).toBe(0);
    expect(human.outText()).not.toContain("t1");

    const json = makeWatchIO();
    const runJson = runCli(["watch", "--url", stub.baseUrl, "--json"], json.io);
    await waitFor(() => json.outText().includes('"item:deleted"'));
    json.controller.abort();
    expect(await runJson).toBe(0);
    const lines = json.outText().trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { event: "item:new", item: { id: "t1", kind: "text", html: "x", createdAt: 1 } },
      { event: "item:deleted", id: "t1" },
    ]);
    // --json mode prints nothing but NDJSON lines.
    for (const line of json.outText().trim().split("\n")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("strips terminal control bytes from watch's text output", async () => {
    const ESC = "\x1b";
    const BEL = "\x07";
    const stub = await startEventsStub({
      onConnect: (_req, res) => {
        res.write(sseEvent("hello", { version: "0.5.0" }));
        res.write(
          sseEvent("item:new", {
            id: "t1",
            kind: "text",
            html: `${ESC}]0;PWNED${BEL}hello`,
            createdAt: 1,
          }),
        );
      },
    });
    stubs.push(stub);
    const { io, outText, controller } = makeWatchIO();
    const run = runCli(["watch", "--url", stub.baseUrl], io);
    await waitFor(() => outText().includes("hello"));
    controller.abort();
    expect(await run).toBe(0);
    expect(outText()).not.toContain(ESC);
    expect(outText()).not.toContain(BEL);
    expect(outText()).not.toContain("PWNED");
  });

  it("--copy sends each new text item's plain text to the injected clipboard runner", async () => {
    const stub = await startEventsStub({
      onConnect: (_req, res) => {
        res.write(sseEvent("hello", { version: "0.5.0" }));
        res.write(
          sseEvent("item:new", { id: "t1", kind: "text", html: "copy <i>me</i>", createdAt: 1 }),
        );
      },
    });
    stubs.push(stub);
    const copied: string[] = [];
    const { io, controller } = makeWatchIO({
      clipboard: async (text) => {
        copied.push(text);
      },
    });
    const run = runCli(["watch", "--url", stub.baseUrl, "--copy"], io);
    await waitFor(() => copied.length > 0);
    controller.abort();
    expect(await run).toBe(0);
    expect(copied).toEqual(["copy me"]);
  });

  it("--files saves new file items with sanitized, non-colliding names", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-splat-watch-"));
    const bytesA = Buffer.from("aaa");
    const bytesB = Buffer.from("bbb");
    const bytesC = Buffer.from("ccc");
    const bytesDup = Buffer.from("dup1");
    const bytesDup2 = Buffer.from("dup2");
    const stub = await startEventsStub({
      files: {
        a: bytesA,
        b: bytesB,
        c: bytesC,
        dup1: bytesDup,
        dup2: bytesDup2,
      },
      onConnect: (_req, res) => {
        res.write(sseEvent("hello", { version: "0.5.0" }));
        const send = (id: string, name: string, size: number) =>
          res.write(sseEvent("item:new", { id, kind: "file", name, size, mime: "text/plain", createdAt: 1 }));
        send("a", "../../etc/passwd", bytesA.length);
        send("b", ".bashrc", bytesB.length);
        send("c", "a\u0007b.txt", bytesC.length);
        send("dup1", "dup.txt", bytesDup.length);
        send("dup2", "dup.txt", bytesDup2.length);
      },
    });
    stubs.push(stub);
    const { io, outText, controller } = makeWatchIO();
    const run = runCli(["watch", "--url", stub.baseUrl, "--files", tmpDir], io);
    await waitFor(() => outText().split("saved:").length - 1 >= 5);
    controller.abort();
    expect(await run).toBe(0);

    const names = fs.readdirSync(tmpDir).sort();
    expect(names).toContain("passwd");
    expect(names).toContain("_.bashrc");
    expect(names).toContain("ab.txt");
    expect(names).toContain("dup.txt");
    expect(names).toContain("dup (1).txt");
    expect(fs.readFileSync(path.join(tmpDir, "passwd")).equals(bytesA)).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "_.bashrc")).equals(bytesB)).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "ab.txt")).equals(bytesC)).toBe(true);
    // Whichever of the two "dup.txt" items landed first keeps the plain
    // name; order between two events in the same chunk is preserved by the
    // processing queue, so "dup1"'s bytes land in "dup.txt".
    expect(fs.readFileSync(path.join(tmpDir, "dup.txt")).equals(bytesDup)).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "dup (1).txt")).equals(bytesDup2)).toBe(true);
  });

  it("401 exits 1 with the wrong/missing-passcode message and does not retry", async () => {
    const stub = await startEventsStub({ token: "secret-token" });
    stubs.push(stub);
    const { io, errText } = makeWatchIO();
    const code = await runCli(["watch", "--url", stub.baseUrl], io);
    expect(code).toBe(1);
    expect(errText()).toContain("passcode");
    expect(stub.requestCount()).toBe(1);
  });

  it("404 exits 1 with the version-mismatch message and does not retry", async () => {
    const stub = await startEventsStub({ status: 404 });
    stubs.push(stub);
    const { io, errText } = makeWatchIO();
    const code = await runCli(["watch", "--url", stub.baseUrl], io);
    expect(code).toBe(1);
    expect(errText()).toContain("needs sync-splat");
    expect(stub.requestCount()).toBe(1);
  });

  it("connection refused on the first attempt exits 1 without retrying", async () => {
    const closed = await closedPort();
    const { io, errText } = makeWatchIO();
    const code = await runCli(["watch", "--url", `http://127.0.0.1:${closed}`], io);
    expect(code).toBe(1);
    expect(errText()).toContain("no server at");
  }, 5000);

  it("reconnects (with a backoff message) after the stub drops the connection mid-stream", async () => {
    let connectCount = 0;
    const stub = await startEventsStub({
      onConnect: (_req, res) => {
        connectCount += 1;
        if (connectCount === 1) {
          res.write(sseEvent("hello", { version: "0.5.0" }));
          // Simulate the server going away mid-stream.
          setTimeout(() => res.destroy(), 20);
        } else {
          res.write(sseEvent("hello", { version: "0.5.0" }));
          res.write(sseEvent("item:new", { id: "t1", kind: "text", html: "back", createdAt: 1 }));
        }
      },
    });
    stubs.push(stub);
    const { io, outText, errText, controller } = makeWatchIO();
    const run = runCli(["watch", "--url", stub.baseUrl], io);
    await waitFor(() => outText().includes("back"));
    controller.abort();
    expect(await run).toBe(0);
    expect(errText()).toMatch(/disconnected — reconnecting in \d+s/);
    expect(stub.requestCount()).toBeGreaterThanOrEqual(2);
  }, 5000);

  it("reconnects when the stream goes silent past the watchdog timeout", async () => {
    let connectCount = 0;
    const stub = await startEventsStub({
      onConnect: (_req, res) => {
        connectCount += 1;
        res.write(sseEvent("hello", { version: "0.5.0" }));
        if (connectCount >= 2) {
          res.write(sseEvent("item:new", { id: "t1", kind: "text", html: "revived", createdAt: 1 }));
        }
        // else: hang — never write another byte, so the watchdog has to fire.
      },
    });
    stubs.push(stub);
    const { io, outText, controller } = makeWatchIO({ watchWatchdogMs: 40, watchBackoffMs: [10] });
    const run = runCli(["watch", "--url", stub.baseUrl], io);
    await waitFor(() => outText().includes("revived"), 5000);
    controller.abort();
    expect(await run).toBe(0);
    expect(stub.requestCount()).toBeGreaterThanOrEqual(2);
  }, 5000);

  it("aborting the signal stops watch cleanly with exit code 0", async () => {
    const stub = await startEventsStub({
      onConnect: (_req, res) => {
        res.write(sseEvent("hello", { version: "0.5.0" }));
      },
    });
    stubs.push(stub);
    const { io, errText, controller } = makeWatchIO();
    const run = runCli(["watch", "--url", stub.baseUrl], io);
    await waitFor(() => errText().includes("watching"));
    controller.abort();
    expect(await run).toBe(0);
  });

  it("never prints the passcode to stdout or stderr", async () => {
    const token = "super-secret-key";
    const stub = await startEventsStub({
      token,
      onConnect: (_req, res) => {
        res.write(sseEvent("hello", { version: "0.5.0" }));
        res.write(sseEvent("item:new", { id: "t1", kind: "text", html: "hi", createdAt: 1 }));
      },
    });
    stubs.push(stub);
    const { io, outText, errText, controller } = makeWatchIO();
    const run = runCli(
      ["watch", "--url", `${stub.baseUrl}/#k=${token}`, "--key", token],
      io,
    );
    await waitFor(() => outText().includes("hi"));
    controller.abort();
    expect(await run).toBe(0);
    expect(outText()).not.toContain(token);
    expect(errText()).not.toContain(token);
  });

  it("sends the default device label (Terminal · hostname)", async () => {
    const stub = await startEventsStub({
      onConnect: (_req, res) => res.write(sseEvent("hello", { version: "0.5.0" })),
    });
    stubs.push(stub);
    const { io, errText, controller } = makeWatchIO();
    const run = runCli(["watch", "--url", stub.baseUrl], io);
    await waitFor(() => errText().includes("watching"));
    controller.abort();
    expect(await run).toBe(0);
    expect(stub.deviceHeaders[0]).toBe(`Terminal · ${os.hostname()}`);
  });

  it("--name overrides the device label, percent-encoded on the wire", async () => {
    const stub = await startEventsStub({
      onConnect: (_req, res) => res.write(sseEvent("hello", { version: "0.5.0" })),
    });
    stubs.push(stub);
    const { io, errText, controller } = makeWatchIO();
    const run = runCli(["watch", "--url", stub.baseUrl, "--name", "My Terminal"], io);
    await waitFor(() => errText().includes("watching"));
    controller.abort();
    expect(await run).toBe(0);
    expect(stub.rawDeviceHeaders[0]).toBe(encodeURIComponent("My Terminal"));
    expect(stub.deviceHeaders[0]).toBe("My Terminal");
  });

  it("a non-ASCII --name is percent-encoded and never crashes the request", async () => {
    const label = "☕ 日本語 café";
    const stub = await startEventsStub({
      onConnect: (_req, res) => res.write(sseEvent("hello", { version: "0.5.0" })),
    });
    stubs.push(stub);
    const { io, errText, controller } = makeWatchIO();
    const run = runCli(["watch", "--url", stub.baseUrl, "--name", label], io);
    await waitFor(() => errText().includes("watching"));
    controller.abort();
    expect(await run).toBe(0);
    expect(stub.rawDeviceHeaders[0]).toBe(encodeURIComponent(label));
    expect(stub.deviceHeaders[0]).toBe(label);
  });
});

// Wire-level check that the CLI and the real server agree on the /api/events
// contract (every other watch test runs against a stub).
describe("runCli watch against a real server", () => {
  it("streams text and saves files end to end, with a passcode", async () => {
    await start({ token: "hunter2" });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "splat-watch-"));
    fs.writeFileSync(path.join(tmpDir, "note.txt"), "already here");
    const { io, outText, errText, controller } = makeWatchIO();
    const run = runCli(
      ["watch", "--url", baseUrl, "--key", "hunter2", "--files", tmpDir],
      io,
    );
    await waitFor(() => errText().includes("watching"));

    const src = path.join(tmpDir, "src.bin");
    fs.writeFileSync(src, "file body");
    const sender = makeIO();
    expect(
      await runCli(["send", "--url", baseUrl, "--key", "hunter2", "hello <from> cli"], sender.io),
    ).toBe(0);
    // Uploaded under the name note.txt so it collides with the existing file.
    const res = await fetch(`${baseUrl}/api/upload?name=note.txt`, {
      method: "POST",
      headers: { [AUTH.header]: "hunter2" },
      body: fs.readFileSync(src),
    });
    expect(res.status).toBe(201);

    await waitFor(() => outText().includes("saved:"));
    controller.abort();
    expect(await run).toBe(0);
    expect(outText()).toContain("hello <from> cli");
    expect(fs.readFileSync(path.join(tmpDir, "note.txt"), "utf8")).toBe("already here");
    expect(fs.readFileSync(path.join(tmpDir, "note (1).txt"), "utf8")).toBe("file body");
    expect(errText()).not.toContain("hunter2");
  });

  it("exits 1 on a wrong passcode", async () => {
    await start({ token: "hunter2" });
    const { io, errText } = makeWatchIO();
    expect(await runCli(["watch", "--url", baseUrl, "--key", "nope"], io)).toBe(1);
    expect(errText()).toMatch(/passcode|key/i);
  });
});
