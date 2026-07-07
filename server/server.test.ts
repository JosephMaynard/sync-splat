import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { io as ioc, type Socket } from "socket.io-client";
import { createSyncSplatServer, type SyncSplatServer } from "./index";
import type {
  ClientToServerEvents,
  FileItem,
  Item,
  ServerInfo,
  ServerToClientEvents,
} from "../shared/types";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let server: SyncSplatServer | undefined;
let port = 0;
let baseUrl = "";
const sockets: ClientSocket[] = [];
let tmpDir: string | undefined;

async function start(
  opts: Partial<Parameters<typeof createSyncSplatServer>[0]> = {},
): Promise<void> {
  server = await createSyncSplatServer({ port: 0, host: "127.0.0.1", ...opts });
  port = server.address.port;
  baseUrl = `http://127.0.0.1:${port}`;
}

function connect(): Promise<ClientSocket> {
  const socket = ioc(baseUrl, {
    transports: ["websocket"],
    forceNew: true,
  }) as unknown as ClientSocket;
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

// Connect a fresh client and resolve with the `history` it receives on
// connect. The listener is attached before the socket connects so the event
// (emitted server-side immediately on connection) is never missed.
function lateJoinHistory(): Promise<Item[]> {
  const socket = ioc(baseUrl, {
    transports: ["websocket"],
    forceNew: true,
  }) as unknown as ClientSocket;
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on("connect_error", reject);
    socket.on("history", (h) => resolve(h));
  });
}

function nextEvent<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    (socket as unknown as { once(e: string, cb: (v: T) => void): void }).once(
      event,
      resolve,
    );
  });
}

function rawGet(
  pathname: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "GET" },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  for (const socket of sockets) socket.disconnect();
  sockets.length = 0;
  if (server) {
    await server.close();
    server = undefined;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("HTTP API", () => {
  it("GET /api/info returns limits", async () => {
    await start();
    const res = await fetch(`${baseUrl}/api/info`);
    expect(res.status).toBe(200);
    const info = (await res.json()) as ServerInfo;
    expect(info.name).toBe("sync-splat");
    expect(typeof info.version).toBe("string");
    expect(info.maxFileBytes).toBe(20 * 1024 * 1024);
    expect(info.maxTextBytes).toBe(256 * 1024);
    expect(Array.isArray(info.urls)).toBe(true);
  });

  it("upload → broadcast → download round-trips identical bytes", async () => {
    await start();
    const listener = await connect();
    const bytes = Buffer.from("hello splat ✨", "utf8");

    const newItem = nextEvent<Item>(listener, "item:new");
    const res = await fetch(`${baseUrl}/api/upload?name=greeting.txt`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: bytes,
    });
    expect(res.status).toBe(201);
    const item = (await res.json()) as FileItem;
    expect(item.kind).toBe("file");
    expect(item.name).toBe("greeting.txt");
    expect(item.size).toBe(bytes.length);

    const broadcast = (await newItem) as FileItem;
    expect(broadcast.id).toBe(item.id);

    const download = await fetch(`${baseUrl}/api/file/${item.id}`);
    expect(download.status).toBe(200);
    const got = Buffer.from(await download.arrayBuffer());
    expect(got.equals(bytes)).toBe(true);
  });

  it("rejects oversize uploads with 413 (Content-Length)", async () => {
    await start({ maxFileBytes: 1024 });
    const res = await fetch(`${baseUrl}/api/upload?name=big.bin`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.alloc(4096, 1),
    });
    expect(res.status).toBe(413);
  });

  it("sanitizes traversal-style filenames", async () => {
    await start();
    const res = await fetch(
      `${baseUrl}/api/upload?name=${encodeURIComponent("../../etc/passwd")}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from("x"),
      },
    );
    const item = (await res.json()) as FileItem;
    expect(item.name).toBe("passwd");
    expect(item.name.includes("/")).toBe(false);
  });

  it("serves non-image files as octet-stream attachment with nosniff", async () => {
    await start();
    const res = await fetch(`${baseUrl}/api/upload?name=notes.pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: Buffer.from("%PDF-1.4"),
    });
    const item = (await res.json()) as FileItem;
    const dl = await fetch(`${baseUrl}/api/file/${item.id}`);
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    const disposition = dl.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("filename*=UTF-8''");
  });

  it("serves inline images with real mime and nosniff", async () => {
    await start();
    const res = await fetch(`${baseUrl}/api/upload?name=pic.png`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    const item = (await res.json()) as FileItem;
    const dl = await fetch(`${baseUrl}/api/file/${item.id}`);
    expect(dl.headers.get("content-type")).toBe("image/png");
    expect(dl.headers.get("content-disposition")).toBe("inline");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("404s on a bogus file id", async () => {
    await start();
    const res = await fetch(`${baseUrl}/api/file/not-a-uuid`);
    expect(res.status).toBe(404);
  });
});

describe("sockets", () => {
  it("broadcasts text and shows it to late joiners", async () => {
    await start();
    const a = await connect();
    const b = await connect();

    const received = nextEvent<Item>(b, "item:new");
    a.emit("text:send", { html: "<b>hi</b>" });
    const item = await received;
    expect(item.kind).toBe("text");
    if (item.kind === "text") expect(item.html).toBe("<b>hi</b>");

    // Late joiner sees it in history.
    const history = await lateJoinHistory();
    expect(history.some((i) => i.kind === "text" && i.html === "<b>hi</b>")).toBe(
      true,
    );
  });

  it("drops malformed and oversize text:send", async () => {
    await start();
    const a = await connect();
    const b = await connect();

    // Malformed and oversize payloads should be ignored.
    (a as unknown as { emit(e: string, p: unknown): void }).emit("text:send", {
      notHtml: true,
    });
    a.emit("text:send", { html: "x".repeat(256 * 1024 + 1) });
    // A valid sentinel afterwards should be the only surviving text item.
    const received = nextEvent<Item>(b, "item:new");
    a.emit("text:send", { html: "sentinel" });
    await received;

    const history = await lateJoinHistory();
    const texts = history.filter((i) => i.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0].kind === "text" && texts[0].html).toBe("sentinel");
  });

  it("delete broadcasts and frees the blob", async () => {
    await start();
    const a = await connect();
    const b = await connect();

    const res = await fetch(`${baseUrl}/api/upload?name=doomed.bin`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("bytes"),
    });
    const item = (await res.json()) as FileItem;

    const deleted = nextEvent<string>(b, "item:deleted");
    a.emit("item:delete", item.id);
    expect(await deleted).toBe(item.id);

    const dl = await fetch(`${baseUrl}/api/file/${item.id}`);
    expect(dl.status).toBe(404);
  });
});

describe("static serving", () => {
  function makeClientDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-splat-client-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>splat</h1>");
    return dir;
  }

  it("serves index.html and blocks traversal", async () => {
    tmpDir = makeClientDir();
    await start({ clientDir: tmpDir });

    const root = await rawGet("/");
    expect(root.status).toBe(200);
    expect(root.body).toContain("splat");

    const encoded = await rawGet("/%2e%2e/package.json");
    expect(encoded.status).toBe(404);

    const raw = await rawGet("/../package.json");
    expect(raw.status).toBe(404);
  });

  it("still serves the API when no client build is present", async () => {
    await start({ clientDir: path.join(os.tmpdir(), "sync-splat-missing-xyz") });
    expect(server?.hasClient).toBe(false);
    const info = await fetch(`${baseUrl}/api/info`);
    expect(info.status).toBe(200);
    const spa = await rawGet("/");
    expect(spa.status).toBe(404);
  });
});
