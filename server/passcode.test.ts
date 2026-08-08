import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { io as ioc, type Socket } from "socket.io-client";
import { createSyncSplatServer, type SyncSplatServer } from "./index";
import { LIMITS } from "../shared/types";
import type {
  ActionAck,
  ClientToServerEvents,
  FileItem,
  Item,
  ServerToClientEvents,
  TextItem,
} from "../shared/types";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const TOKEN = "pass1234";

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

function connect(auth?: Record<string, unknown>): Promise<ClientSocket> {
  const socket = ioc(baseUrl, {
    transports: ["websocket"],
    forceNew: true,
    auth,
  }) as unknown as ClientSocket;
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

/** Resolve true if the handshake fails (connect_error), false if it connects. */
function handshakeFails(auth?: Record<string, unknown>): Promise<boolean> {
  const socket = ioc(baseUrl, {
    transports: ["websocket"],
    forceNew: true,
    auth,
  }) as unknown as ClientSocket;
  sockets.push(socket);
  return new Promise((resolve) => {
    socket.on("connect", () => resolve(false));
    socket.on("connect_error", () => resolve(true));
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

/** Low-level request that lets us set arbitrary headers (fetch normalises some
 *  away) — used for the in-flight budget test. */
function raw(
  method: string,
  pathname: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const { headers = {}, body = "" } = opts;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method, headers },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function upload(name: string, bytes: Buffer, key?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
  };
  if (key) headers["X-Splat-Key"] = key;
  return fetch(`${baseUrl}/api/upload?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers,
    body: bytes,
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

describe("passcode: /api/info locked vs full", () => {
  it("returns the locked payload without a key", async () => {
    await start({ token: TOKEN });
    const res = await fetch(`${baseUrl}/api/info`);
    expect(res.status).toBe(200);
    const info = (await res.json()) as Record<string, unknown>;
    expect(info).toEqual({
      name: "sync-splat",
      version: expect.any(String),
      authRequired: true,
    });
    expect(info.urls).toBeUndefined();
    expect(info.maxFileBytes).toBeUndefined();
  });

  it("returns the full payload with a valid key via header", async () => {
    await start({ token: TOKEN });
    const res = await fetch(`${baseUrl}/api/info`, {
      headers: { "X-Splat-Key": TOKEN },
    });
    const info = (await res.json()) as Record<string, unknown>;
    expect(info.authRequired).toBe(true);
    expect(Array.isArray(info.urls)).toBe(true);
    expect(info.maxFileBytes).toBe(LIMITS.maxFileBytes);
  });

  it("returns the full payload with a valid key via query param", async () => {
    await start({ token: TOKEN });
    const res = await fetch(`${baseUrl}/api/info?k=${TOKEN}`);
    const info = (await res.json()) as Record<string, unknown>;
    expect(info.authRequired).toBe(true);
    expect(Array.isArray(info.urls)).toBe(true);
  });

  it("returns the full payload with a valid key via cookie", async () => {
    await start({ token: TOKEN });
    const res = await fetch(`${baseUrl}/api/info`, {
      headers: { Cookie: `splat-key=${TOKEN}` },
    });
    const info = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(info.urls)).toBe(true);
  });

  it("stays locked with a wrong key", async () => {
    await start({ token: TOKEN });
    const res = await fetch(`${baseUrl}/api/info`, {
      headers: { "X-Splat-Key": "wrong" },
    });
    const info = (await res.json()) as Record<string, unknown>;
    expect(info.urls).toBeUndefined();
    expect(info.authRequired).toBe(true);
  });
});

describe("passcode: /api/* gating (401 without, ok with)", () => {
  it("gates upload → 401 without, 201 with", async () => {
    await start({ token: TOKEN });
    const bytes = Buffer.from("data");
    const noKey = await upload("a.bin", bytes);
    expect(noKey.status).toBe(401);
    expect(((await noKey.json()) as { error: string }).error).toBe(
      "unauthorized",
    );
    const withKey = await upload("a.bin", bytes, TOKEN);
    expect(withKey.status).toBe(201);
  });

  it("gates /api/history → 401 without, 200 with", async () => {
    await start({ token: TOKEN });
    const noKey = await fetch(`${baseUrl}/api/history`);
    expect(noKey.status).toBe(401);
    const withKey = await fetch(`${baseUrl}/api/history`, {
      headers: { "X-Splat-Key": TOKEN },
    });
    expect(withKey.status).toBe(200);
    expect(Array.isArray(await withKey.json())).toBe(true);
  });

  it("gates /api/text → 401 without, 201 with", async () => {
    await start({ token: TOKEN });
    const noKey = await fetch(`${baseUrl}/api/text`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hi",
    });
    expect(noKey.status).toBe(401);
    const withKey = await fetch(`${baseUrl}/api/text`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Splat-Key": TOKEN },
      body: "hi",
    });
    expect(withKey.status).toBe(201);
  });

  it("gates /api/file download, accepting the key via ?k= query", async () => {
    await start({ token: TOKEN });
    const res = await upload("pic.bin", Buffer.from("bytes"), TOKEN);
    const item = (await res.json()) as FileItem;

    const noKey = await fetch(`${baseUrl}/api/file/${item.id}`);
    expect(noKey.status).toBe(401);

    // Downloads via <a>/<img> can't set headers — the key rides in ?k=.
    const viaQuery = await fetch(`${baseUrl}/api/file/${item.id}?k=${TOKEN}`);
    expect(viaQuery.status).toBe(200);
    expect(Buffer.from(await viaQuery.arrayBuffer()).toString()).toBe("bytes");
  });

  it("gates share routes → 401 without, ok with", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-splat-share-"));
    fs.writeFileSync(path.join(tmpDir, "hello.txt"), "world");
    await start({ token: TOKEN, shareDir: tmpDir });

    const lsNoKey = await fetch(`${baseUrl}/api/share/ls`);
    expect(lsNoKey.status).toBe(401);
    const lsKey = await fetch(`${baseUrl}/api/share/ls`, {
      headers: { "X-Splat-Key": TOKEN },
    });
    expect(lsKey.status).toBe(200);

    const dlNoKey = await fetch(`${baseUrl}/api/share/dl?path=hello.txt`);
    expect(dlNoKey.status).toBe(401);
    const dlKey = await fetch(
      `${baseUrl}/api/share/dl?path=hello.txt&k=${TOKEN}`,
    );
    expect(dlKey.status).toBe(200);
    expect(await dlKey.text()).toBe("world");
  });

  it("still enforces the origin check alongside the key (403 wins for cross-origin writes)", async () => {
    await start({ token: TOKEN });
    const res = await fetch(`${baseUrl}/api/upload?name=x.bin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Splat-Key": TOKEN,
        Origin: "http://evil.example",
      },
      body: "x",
    });
    expect(res.status).toBe(403);
  });
});

describe("passcode: socket handshake", () => {
  it("rejects a handshake without a key", async () => {
    await start({ token: TOKEN });
    expect(await handshakeFails()).toBe(true);
  });

  it("rejects a handshake with a wrong key", async () => {
    await start({ token: TOKEN });
    expect(await handshakeFails({ token: "wrong" })).toBe(true);
  });

  it("accepts a handshake with auth.token", async () => {
    await start({ token: TOKEN });
    const socket = await connect({ token: TOKEN });
    expect(socket.connected).toBe(true);
  });
});

describe("passcode OFF: regression + new endpoints work keyless", () => {
  it("/api/info is full with authRequired:false", async () => {
    await start();
    const info = (await (await fetch(`${baseUrl}/api/info`)).json()) as Record<
      string,
      unknown
    >;
    expect(info.authRequired).toBe(false);
    expect(Array.isArray(info.urls)).toBe(true);
  });

  it("POST /api/text stores, broadcasts item:new, and returns the TextItem", async () => {
    await start();
    const listener = await connect();
    const created = nextEvent<Item>(listener, "item:new");

    const res = await fetch(`${baseUrl}/api/text`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "<b>hello</b>",
    });
    expect(res.status).toBe(201);
    const item = (await res.json()) as TextItem;
    expect(item.kind).toBe("text");
    expect(item.html).toBe("<b>hello</b>");

    const broadcast = (await created) as TextItem;
    expect(broadcast.id).toBe(item.id);
  });

  it("POST /api/text accepts a JSON {html} body", async () => {
    await start();
    const res = await fetch(`${baseUrl}/api/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<i>json</i>" }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as TextItem).html).toBe("<i>json</i>");
  });

  it("POST /api/text rejects oversize bodies with 413", async () => {
    await start();
    const res = await fetch(`${baseUrl}/api/text`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x".repeat(LIMITS.maxTextBytes + 1),
    });
    expect(res.status).toBe(413);
  });

  it("GET /api/history returns the current items", async () => {
    await start();
    await fetch(`${baseUrl}/api/text`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "one",
    });
    const res = await fetch(`${baseUrl}/api/history`);
    expect(res.status).toBe(200);
    const items = (await res.json()) as Item[];
    expect(items.some((i) => i.kind === "text" && i.html === "one")).toBe(true);
  });
});

describe("socket acks", () => {
  function sendText(
    socket: ClientSocket,
    payload: unknown,
  ): Promise<ActionAck> {
    return new Promise((resolve) => {
      (
        socket as unknown as {
          emit(e: string, p: unknown, ack: (r: ActionAck) => void): void;
        }
      ).emit("text:send", payload, resolve);
    });
  }

  it("text:send acks ok with the new id", async () => {
    await start();
    const socket = await connect();
    const ack = await sendText(socket, { html: "hi" });
    expect(ack.ok).toBe(true);
    if (ack.ok) expect(typeof ack.id).toBe("string");
  });

  it("text:send acks too-big for oversize html", async () => {
    await start();
    const socket = await connect();
    const ack = await sendText(socket, {
      html: "x".repeat(LIMITS.maxTextBytes + 1),
    });
    expect(ack).toEqual({ ok: false, error: "too-big" });
  });

  it("text:send acks invalid for a malformed payload", async () => {
    await start();
    const socket = await connect();
    const ack = await sendText(socket, { notHtml: true });
    expect(ack).toEqual({ ok: false, error: "invalid" });
  });

  it("text:send acks rate-limited past the window cap", async () => {
    await start();
    const socket = await connect();
    let last: ActionAck | undefined;
    for (let i = 0; i < LIMITS.rateLimitEvents + 1; i += 1) {
      last = await sendText(socket, { html: "x" });
    }
    expect(last).toEqual({ ok: false, error: "rate-limited" });
  });

  it("item:delete acks ok with the id, then not-found", async () => {
    await start();
    const socket = await connect();
    const res = await upload("d.bin", Buffer.from("bytes"));
    const item = (await res.json()) as FileItem;

    const first = await new Promise<ActionAck>((resolve) => {
      (
        socket as unknown as {
          emit(e: string, id: string, ack: (r: ActionAck) => void): void;
        }
      ).emit("item:delete", item.id, resolve);
    });
    expect(first).toEqual({ ok: true, id: item.id });

    const second = await new Promise<ActionAck>((resolve) => {
      (
        socket as unknown as {
          emit(e: string, id: string, ack: (r: ActionAck) => void): void;
        }
      ).emit("item:delete", item.id, resolve);
    });
    expect(second).toEqual({ ok: false, error: "not-found" });
  });

  it("still works when no ack callback is passed (no throw)", async () => {
    await start();
    const a = await connect();
    const b = await connect();
    const received = nextEvent<Item>(b, "item:new");
    a.emit("text:send", { html: "noack" });
    const item = await received;
    expect(item.kind).toBe("text");
  });
});

describe("in-flight upload memory budget", () => {
  it("rejects a second upload with 503 when the budget is reserved", async () => {
    // Budget == maxTotalFileBytes. Allow a single file that large so the
    // per-file 413 check doesn't fire first.
    await start({ maxFileBytes: LIMITS.maxTotalFileBytes });

    // Request A claims the whole budget via Content-Length and is left open
    // (body never finishes), holding the reservation. Keep a direct handle so
    // we can tear it down after — its response never arrives.
    const held = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/upload?name=a.bin",
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(LIMITS.maxTotalFileBytes),
      },
    });
    held.on("error", () => {});
    held.write("x");

    // Give the server a moment to receive A's headers and reserve the budget.
    await new Promise((r) => setTimeout(r, 100));

    // Request B is tiny but there's no budget left → 503.
    const busy = await raw("POST", "/api/upload?name=b.bin", {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": "1",
      },
      body: "x",
    });
    expect(busy.status).toBe(503);
    expect(JSON.parse(busy.body).error).toBe("server busy");

    // Tear down A; its reservation is released on the request's close event.
    held.destroy();

    // After A is gone, a normal small upload succeeds again.
    await new Promise((r) => setTimeout(r, 100));
    const ok = await upload("c.bin", Buffer.from("ok"));
    expect(ok.status).toBe(201);
  });
});
