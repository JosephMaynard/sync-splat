import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { io as ioc, type Socket } from "socket.io-client";
import { createSyncSplatServer, VERSION, type SyncSplatServer } from "./index";
import { createEventStreams } from "./events";
import { createBroadcastHub } from "./hub";
import { createPresenceRegistry } from "./presence";
import type { SyncSplatIO } from "./socket";
import { LIMITS } from "../shared/types";
import type {
  ClientToServerEvents,
  Device,
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
const streams: SseStream[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

async function start(
  opts: Partial<Parameters<typeof createSyncSplatServer>[0]> = {},
): Promise<void> {
  server = await createSyncSplatServer({ port: 0, host: "127.0.0.1", ...opts });
  port = server.address.port;
  baseUrl = `http://127.0.0.1:${port}`;
}

interface SseEvent {
  event: string;
  data: unknown;
}

interface SseStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Non-stream responses (errors) are read to the end into `body`. */
  body: string;
  events: SseEvent[];
  pings: number;
  ended: boolean;
  /** Resolve with the first event (already received or future) that matches. */
  waitFor(event: string, match?: (data: unknown) => boolean): Promise<unknown>;
  close(): void;
}

/** Open GET /api/events (or another method, for the 405 check) with a raw
 *  http client and parse the SSE framing as it arrives. */
function openEvents(
  opts: { headers?: Record<string, string>; method?: string; port?: number } = {},
): Promise<SseStream> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: opts.port ?? port,
        path: "/api/events",
        method: opts.method ?? "GET",
        headers: opts.headers,
      },
      (res) => {
        const waiters: Array<{
          event: string;
          match: (d: unknown) => boolean;
          resolve: (d: unknown) => void;
        }> = [];
        let buf = "";
        const stream: SseStream = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: "",
          events: [],
          pings: 0,
          ended: false,
          waitFor(event, match = () => true) {
            const hit = stream.events.find((e) => e.event === event && match(e.data));
            if (hit) return Promise.resolve(hit.data);
            return new Promise((r) => waiters.push({ event, match, resolve: r }));
          },
          close() {
            req.destroy();
          },
        };
        streams.push(stream);
        res.setEncoding("utf8");
        const isStream = (res.headers["content-type"] ?? "").startsWith(
          "text/event-stream",
        );
        res.on("data", (chunk: string) => {
          if (!isStream) {
            stream.body += chunk;
            return;
          }
          buf += chunk;
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            if (block.startsWith(":")) {
              stream.pings += 1;
              continue;
            }
            const lines = block.split("\n");
            const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "";
            const dataLines = lines.filter((l) => l.startsWith("data: "));
            // The contract promises single-line JSON data.
            expect(dataLines).toHaveLength(1);
            const data = JSON.parse(dataLines[0].slice(6)) as unknown;
            stream.events.push({ event, data });
            for (const w of waiters.slice()) {
              if (w.event === event && w.match(data)) {
                waiters.splice(waiters.indexOf(w), 1);
                w.resolve(data);
              }
            }
          }
        });
        res.on("end", () => {
          stream.ended = true;
          if (!isStream) resolve(stream);
        });
        res.on("error", () => {
          stream.ended = true;
        });
        res.on("close", () => {
          stream.ended = true;
        });
        if (isStream) resolve(stream);
      },
    );
    req.on("error", (err) => {
      // A deliberate close() on our side is not a failure.
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
    });
    req.end();
  });
}

function connect(auth?: Record<string, unknown>): Promise<{
  socket: ClientSocket;
  presence: () => Device[] | null;
}> {
  const socket = ioc(baseUrl, {
    transports: ["websocket"],
    forceNew: true,
    auth,
  }) as unknown as ClientSocket;
  sockets.push(socket);
  let latest: Device[] | null = null;
  socket.on("presence", (d) => (latest = d));
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve({ socket, presence: () => latest }));
    socket.on("connect_error", reject);
  });
}

async function waitUntil(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterEach(async () => {
  for (const s of streams) s.close();
  streams.length = 0;
  for (const socket of sockets) socket.disconnect();
  sockets.length = 0;
  for (const fn of cleanups.splice(0)) await fn();
  if (server) {
    await server.close();
    server = undefined;
  }
});

describe("GET /api/events: gating", () => {
  it("401s without a key when a passcode is set, streams with the header key", async () => {
    await start({ token: TOKEN });
    const denied = await openEvents();
    expect(denied.status).toBe(401);
    expect(JSON.parse(denied.body)).toEqual({ error: "unauthorized" });

    const ok = await openEvents({ headers: { "X-Splat-Key": TOKEN } });
    expect(ok.status).toBe(200);
    expect(await ok.waitFor("hello")).toEqual({
      version: VERSION,
      maxFileBytes: LIMITS.maxFileBytes,
    });
  });

  it("405s for anything but GET", async () => {
    await start();
    for (const method of ["POST", "HEAD", "PUT"]) {
      const res = await openEvents({ method });
      expect(res.status).toBe(405);
    }
  });

  it("403s a cross-site Origin but allows no Origin and same-origin", async () => {
    await start();
    const evil = await openEvents({ headers: { Origin: "http://evil.example" } });
    expect(evil.status).toBe(403);
    const same = await openEvents({ headers: { Origin: baseUrl } });
    expect(same.status).toBe(200);
  });

  it("503s past maxEventStreams", async () => {
    await start();
    const open: SseStream[] = [];
    for (let i = 0; i < LIMITS.maxEventStreams; i += 1) {
      const s = await openEvents();
      expect(s.status).toBe(200);
      open.push(s);
    }
    const over = await openEvents();
    expect(over.status).toBe(503);
    expect(JSON.parse(over.body)).toEqual({ error: "too many event streams" });

    // A closed stream frees its slot. The server notices the close
    // asynchronously, so retry briefly.
    open[0].close();
    let again: SseStream | undefined;
    for (let i = 0; i < 50 && again?.status !== 200; i += 1) {
      again = await openEvents();
      if (again.status !== 200) await new Promise((r) => setTimeout(r, 10));
    }
    expect(again?.status).toBe(200);
  });
});

describe("GET /api/events: stream", () => {
  it("sends SSE headers and a hello with the configured maxFileBytes", async () => {
    await start({ maxFileBytes: 1234 });
    const s = await openEvents();
    expect(s.status).toBe(200);
    expect(s.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(s.headers["cache-control"]).toBe("no-cache");
    expect(s.headers["x-accel-buffering"]).toBe("no");
    expect(s.headers["x-content-type-options"]).toBe("nosniff");
    expect(await s.waitFor("hello")).toEqual({ version: VERSION, maxFileBytes: 1234 });
    expect(s.events[0].event).toBe("hello");
  });

  it("delivers item:new from socket text:send, HTTP upload and /api/text", async () => {
    await start();
    const s = await openEvents();
    await s.waitFor("hello");
    const { socket } = await connect();

    socket.emit("text:send", { html: "<b>from socket</b>\nline two" });
    const fromSocket = (await s.waitFor("item:new")) as TextItem;
    expect(fromSocket).toMatchObject({ kind: "text", html: "<b>from socket</b>\nline two" });

    const up = await fetch(`${baseUrl}/api/upload?name=a.txt`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "bytes",
    });
    const uploaded = (await up.json()) as FileItem;
    expect(
      await s.waitFor("item:new", (d) => (d as Item).id === uploaded.id),
    ).toEqual(uploaded);

    const posted = (await (
      await fetch(`${baseUrl}/api/text`, { method: "POST", body: "plain" })
    ).json()) as TextItem;
    expect(await s.waitFor("item:new", (d) => (d as Item).id === posted.id)).toEqual(
      posted,
    );
  });

  it("delivers item:deleted as {id} for deletes and evictions", async () => {
    await start();
    const s = await openEvents();
    await s.waitFor("hello");
    const { socket } = await connect();

    const post = async (body: string) =>
      (await (
        await fetch(`${baseUrl}/api/text`, { method: "POST", body })
      ).json()) as TextItem;

    const doomed = await post("delete me");
    socket.emit("item:delete", doomed.id);
    expect(
      await s.waitFor("item:deleted", (d) => (d as { id: string }).id === doomed.id),
    ).toEqual({ id: doomed.id });

    // Fill history past maxItems: the oldest is evicted.
    const first = await post("oldest");
    for (let i = 1; i < LIMITS.maxItems; i += 1) await post(`t${i}`);
    expect(s.events.some((e) => e.event === "item:deleted" &&
      (e.data as { id: string }).id === first.id)).toBe(false);
    await post("one too many");
    expect(
      await s.waitFor("item:deleted", (d) => (d as { id: string }).id === first.id),
    ).toEqual({ id: first.id });
  });

  it("appears in presence as a terminal with its label, and leaves on close", async () => {
    await start();
    const watcher = await connect({ device: "Browser" });
    await waitUntil(() => watcher.presence()?.length === 1);

    const s = await openEvents({
      headers: { "X-Splat-Device": encodeURIComponent("joe@mac · zsh 🐚") },
    });
    await s.waitFor("hello");
    await waitUntil(() => watcher.presence()?.length === 2);
    const term = watcher.presence()?.[1];
    expect(term).toMatchObject({
      label: "joe@mac · zsh 🐚",
      kind: "terminal",
      host: true,
    });
    expect(term?.id).toMatch(/^term-/);

    s.close();
    await waitUntil(() => watcher.presence()?.length === 1);
    expect(watcher.presence()?.[0].kind).toBe("browser");
  });

  it("labels a terminal 'Terminal' by default and keeps literal % labels", async () => {
    await start();
    const watcher = await connect();
    const a = await openEvents();
    const b = await openEvents({ headers: { "X-Splat-Device": "100% box" } });
    await a.waitFor("hello");
    await b.waitFor("hello");
    await waitUntil(() => watcher.presence()?.length === 3);
    const labels = watcher.presence()?.filter((d) => d.kind === "terminal").map((d) => d.label);
    expect(labels?.sort()).toEqual(["100% box", "Terminal"]);
  });

  it("close() resolves with streams open and ends them", async () => {
    await start();
    const a = await openEvents();
    const b = await openEvents();
    await a.waitFor("hello");
    await b.waitFor("hello");
    const closing = server!.close();
    server = undefined;
    await expect(
      Promise.race([
        closing.then(() => "closed"),
        new Promise((r) => setTimeout(() => r("hung"), 2000)),
      ]),
    ).resolves.toBe("closed");
    await waitUntil(() => a.ended && b.ended);
  });
});

describe("createEventStreams (unit)", () => {
  it("pings on the interval and cleans up timer, subscription and presence on close", async () => {
    const fakeIo = { emit: () => true } as unknown as SyncSplatIO;
    const hub = createBroadcastHub(fakeIo);
    const lists: Device[][] = [];
    const presence = createPresenceRegistry((d) => lists.push(d));
    const events = createEventStreams({ hub, presence, maxFileBytes: 1, pingMs: 20 });
    const bare = http.createServer((req, res) => events.handle(req, res));
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => bare.close(() => r())));
    const barePort = (bare.address() as { port: number }).port;

    const s = await openEvents({ port: barePort });
    await waitUntil(() => s.pings >= 2);
    expect(events.size).toBe(1);
    expect(presence.list()).toHaveLength(1);

    hub.itemDeleted("abc");
    expect(await s.waitFor("item:deleted")).toEqual({ id: "abc" });

    s.close();
    await waitUntil(() => events.size === 0);
    expect(presence.list()).toEqual([]);
    expect(lists.at(-1)).toEqual([]);
    // Unsubscribed: fanning out now reaches nobody (and doesn't throw).
    hub.itemDeleted("after");
  });

  it("closeAll ends every stream", async () => {
    const fakeIo = { emit: () => true } as unknown as SyncSplatIO;
    const hub = createBroadcastHub(fakeIo);
    const presence = createPresenceRegistry(() => {});
    const events = createEventStreams({ hub, presence, maxFileBytes: 1 });
    const bare = http.createServer((req, res) => events.handle(req, res));
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => bare.close(() => r())));
    const barePort = (bare.address() as { port: number }).port;

    const s = await openEvents({ port: barePort });
    await s.waitFor("hello");
    events.closeAll();
    expect(events.size).toBe(0);
    expect(presence.list()).toEqual([]);
    await waitUntil(() => s.ended);
  });
});
