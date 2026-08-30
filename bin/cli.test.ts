import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { createSyncSplatServer, type SyncSplatServer } from "../server/index";
import { runCli } from "../server/cli";

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
