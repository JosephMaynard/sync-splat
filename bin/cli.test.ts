import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
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
    // An OSC title-change sequence must not survive to the terminal.
    const send = makeIO(`${ESC}]0;PWNED${BEL}hello`);
    expect(await runCli(["send", "--url", baseUrl], send.io)).toBe(0);

    const got = makeIO();
    await runCli(["get", "0", "--url", baseUrl], got.io);
    const out = got.outText();
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
    expect(out).toContain("hello");
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
    // Port 1 is privileged/unused; the connection is refused fast.
    const io = makeIO();
    const code = await runCli(
      ["history", "--url", "http://127.0.0.1:1"],
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
