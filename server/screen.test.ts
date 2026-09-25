import { afterEach, describe, expect, it } from "vitest";
import { io as ioc, type Socket } from "socket.io-client";
import { createSyncSplatServer, type SyncSplatServer } from "./index";
import { LIMITS } from "../shared/types";
import type {
  ActionAck,
  ClientToServerEvents,
  Device,
  RtcSignalData,
  ScreenState,
  ServerToClientEvents,
} from "../shared/types";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** A connected client plus everything the server has pushed to it, recorded
 *  from before the handshake so on-connect events are never missed. */
interface Client {
  socket: ClientSocket;
  id: string;
  presence: Device[] | null;
  screen: ScreenState | null;
  signals: Array<{ from: string; data: RtcSignalData }>;
  joined: string[];
  left: string[];
}

let server: SyncSplatServer | undefined;
let baseUrl = "";
const sockets: ClientSocket[] = [];

async function start(
  opts: Partial<Parameters<typeof createSyncSplatServer>[0]> = {},
): Promise<void> {
  server = await createSyncSplatServer({ port: 0, host: "127.0.0.1", ...opts });
  baseUrl = `http://127.0.0.1:${server.address.port}`;
}

function connect(
  opts: { device?: unknown; browserLike?: boolean } = {},
): Promise<Client> {
  const auth: Record<string, unknown> = {};
  if (opts.device !== undefined) auth.device = opts.device;
  const socket = ioc(baseUrl, {
    // browserLike: socket.io's default (HTTP long-polling, then upgrade to
    // websocket) with the Origin header a real page sends.
    ...(opts.browserLike
      ? { extraHeaders: { Origin: baseUrl } }
      : { transports: ["websocket"] }),
    forceNew: true,
    auth,
  }) as unknown as ClientSocket;
  sockets.push(socket);
  const client: Client = {
    socket,
    id: "",
    presence: null,
    screen: null,
    signals: [],
    joined: [],
    left: [],
  };
  socket.on("presence", (d) => (client.presence = d));
  socket.on("screen:state", (s) => (client.screen = s));
  socket.on("rtc:signal", (m) => client.signals.push(m));
  socket.on("screen:viewer-joined", (id) => client.joined.push(id));
  socket.on("screen:viewer-left", (id) => client.left.push(id));
  return new Promise((resolve, reject) => {
    socket.on("connect", () => {
      client.id = socket.id ?? "";
      resolve(client);
    });
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

function emitAck(
  c: Client,
  event: "screen:start" | "screen:join",
): Promise<ActionAck> {
  return new Promise((resolve) => c.socket.emit(event, resolve));
}

/** Server-side barrier for one client: resolves once the server has handled
 *  everything this client sent before, and this client has received
 *  everything the server sent it before that. item:delete of an unknown id
 *  is a side-effect-free acked round trip. */
function flush(c: Client): Promise<void> {
  return new Promise((resolve) =>
    c.socket.emit("item:delete", "no-such-id", () => resolve()),
  );
}

/** Emit rtc:signal bypassing the typed signature, for malformed payloads. */
function rawSignal(c: Client, msg: unknown): void {
  (c.socket as unknown as { emit(e: string, m: unknown): void }).emit(
    "rtc:signal",
    msg,
  );
}

const offer: RtcSignalData = { type: "offer", sdp: "v=0 offer" };
const answer: RtcSignalData = { type: "answer", sdp: "v=0 answer" };

/** A running share: one sharer and `n` joined viewers. */
async function share(n: number): Promise<{ sharer: Client; viewers: Client[] }> {
  const sharer = await connect({ device: "Sharer" });
  expect(await emitAck(sharer, "screen:start")).toEqual({ ok: true, id: sharer.id });
  const viewers: Client[] = [];
  for (let i = 0; i < n; i += 1) {
    const v = await connect({ device: `Viewer ${i}` });
    expect(await emitAck(v, "screen:join")).toEqual({ ok: true, id: sharer.id });
    viewers.push(v);
  }
  await waitUntil(() => sharer.joined.length === n);
  return { sharer, viewers };
}

afterEach(async () => {
  for (const socket of sockets) socket.disconnect();
  sockets.length = 0;
  if (server) {
    await server.close();
    server = undefined;
  }
});

describe("presence", () => {
  it("lists every connected browser with its sanitized label and host flag", async () => {
    await start();
    const a = await connect({ device: "  Mac‮ ​Book\n" });
    const b = await connect({ device: 42 });
    await waitUntil(() => a.presence?.length === 2 && b.presence?.length === 2);
    expect(a.presence).toEqual([
      { id: a.id, label: "Mac Book", kind: "browser", host: true },
      { id: b.id, label: "Unknown device", kind: "browser", host: true },
    ]);
    expect(b.presence).toEqual(a.presence);
  });

  it("removes a device and re-broadcasts when it disconnects", async () => {
    await start();
    const a = await connect({ device: "stays" });
    const b = await connect({ device: "leaves" });
    await waitUntil(() => a.presence?.length === 2);
    b.socket.disconnect();
    await waitUntil(() => a.presence?.length === 1);
    expect(a.presence?.[0].id).toBe(a.id);
  });

  it("registers a browser that connects the browser way (polling, then upgrade)", async () => {
    await start();
    const c = await connect({ device: "Pixel · Chrome", browserLike: true });
    await waitUntil(() => c.presence !== null && c.screen !== null);
    expect(c.presence).toEqual([
      { id: c.id, label: "Pixel · Chrome", kind: "browser", host: true },
    ]);
    // The id stays the socket id across the transport upgrade.
    await waitUntil(
      () =>
        (c.socket.io.engine as unknown as { transport: { name: string } })
          .transport.name === "websocket",
    );
    expect(c.socket.id).toBe(c.id);
    expect(await emitAck(c, "screen:start")).toEqual({ ok: true, id: c.id });
  });

  it("sends the current screen:state to a new socket", async () => {
    await start();
    const a = await connect();
    await waitUntil(() => a.screen !== null);
    expect(a.screen).toEqual({ sharer: null, viewers: 0 });

    const { sharer } = await share(1);
    const late = await connect();
    await waitUntil(() => late.screen !== null);
    expect(late.screen).toEqual({
      sharer: { id: sharer.id, label: "Sharer", kind: "browser", host: true },
      viewers: 1,
    });
  });
});

describe("screen:start / screen:stop", () => {
  it("makes the caller the sharer, is idempotent, and is busy for others", async () => {
    await start();
    const a = await connect({ device: "A" });
    const b = await connect({ device: "B" });
    expect(await emitAck(a, "screen:start")).toEqual({ ok: true, id: a.id });
    await waitUntil(() => b.screen?.sharer?.id === a.id);
    expect(b.screen?.sharer?.label).toBe("A");
    expect(await emitAck(a, "screen:start")).toEqual({ ok: true, id: a.id });
    expect(await emitAck(b, "screen:start")).toEqual({ ok: false, error: "busy" });
  });

  it("stop is a no-op for non-sharers and ends the share for the sharer", async () => {
    await start();
    const { sharer, viewers } = await share(1);
    const [v] = viewers;
    v.socket.emit("screen:stop");
    await flush(v);
    await flush(sharer);
    expect(sharer.screen?.sharer?.id).toBe(sharer.id);

    sharer.socket.emit("screen:stop");
    await waitUntil(() => v.screen?.sharer === null);
    expect(v.screen).toEqual({ sharer: null, viewers: 0 });
    // Viewers were cleared with the share: a fresh share starts at zero.
    expect(await emitAck(v, "screen:start")).toEqual({ ok: true, id: v.id });
    await waitUntil(() => sharer.screen?.sharer?.id === v.id);
    expect(sharer.screen?.viewers).toBe(0);
  });
});

describe("screen:join / screen:leave", () => {
  it("is not-found with no share, invalid for the sharer", async () => {
    await start();
    const a = await connect();
    expect(await emitAck(a, "screen:join")).toEqual({
      ok: false,
      error: "not-found",
    });
    await emitAck(a, "screen:start");
    expect(await emitAck(a, "screen:join")).toEqual({ ok: false, error: "invalid" });
  });

  it("tells the sharer, acks the sharer id, and counts viewers", async () => {
    await start();
    const { sharer, viewers } = await share(2);
    expect(sharer.joined).toEqual([viewers[0].id, viewers[1].id]);
    await waitUntil(() => sharer.screen?.viewers === 2);
    // Only the sharer hears about joins.
    expect(viewers[0].joined).toEqual([]);
  });

  it("re-join re-notifies the sharer without double counting", async () => {
    await start();
    const { sharer, viewers } = await share(1);
    const [v] = viewers;
    expect(await emitAck(v, "screen:join")).toEqual({ ok: true, id: sharer.id });
    await waitUntil(() => sharer.joined.length === 2);
    expect(sharer.joined).toEqual([v.id, v.id]);
    await flush(sharer);
    expect(sharer.screen?.viewers).toBe(1);
  });

  it("is full at maxScreenViewers, but existing viewers can still re-join", async () => {
    await start();
    const { sharer, viewers } = await share(LIMITS.maxScreenViewers);
    const extra = await connect();
    expect(await emitAck(extra, "screen:join")).toEqual({ ok: false, error: "full" });
    expect(await emitAck(viewers[0], "screen:join")).toEqual({
      ok: true,
      id: sharer.id,
    });
  });

  it("leave notifies the sharer and frees the slot", async () => {
    await start();
    const { sharer, viewers } = await share(1);
    const [v] = viewers;
    v.socket.emit("screen:leave");
    await waitUntil(() => sharer.left.length === 1);
    expect(sharer.left).toEqual([v.id]);
    await waitUntil(() => sharer.screen?.viewers === 0);
    // Leaving again is a no-op.
    v.socket.emit("screen:leave");
    await flush(v);
    await flush(sharer);
    expect(sharer.left).toHaveLength(1);
  });
});

describe("rtc:signal relay", () => {
  it("relays sharer → viewer and viewer → sharer with a server-stamped from", async () => {
    await start();
    const { sharer, viewers } = await share(1);
    const [v] = viewers;

    // A client-supplied `from` is ignored.
    rawSignal(sharer, { to: v.id, from: "spoofed", data: offer });
    await waitUntil(() => v.signals.length === 1);
    expect(v.signals[0]).toEqual({ from: sharer.id, data: offer });

    const candidate: RtcSignalData = {
      type: "candidate",
      candidate: { candidate: "candidate:1 1 udp 1 10.0.0.2 5000 typ host", sdpMid: "0" },
    };
    v.socket.emit("rtc:signal", { to: sharer.id, data: answer });
    v.socket.emit("rtc:signal", { to: sharer.id, data: candidate });
    v.socket.emit("rtc:signal", {
      to: sharer.id,
      data: { type: "candidate", candidate: null },
    });
    await waitUntil(() => sharer.signals.length === 3);
    expect(sharer.signals).toEqual([
      { from: v.id, data: answer },
      { from: v.id, data: candidate },
      { from: v.id, data: { type: "candidate", candidate: null } },
    ]);
  });

  it("drops signals that are not along a sharer ↔ joined-viewer edge", async () => {
    await start();
    const { sharer, viewers } = await share(2);
    const [v1, v2] = viewers;
    const stranger = await connect();

    rawSignal(v1, { to: v2.id, data: offer }); // viewer → viewer
    rawSignal(stranger, { to: sharer.id, data: answer }); // not joined → sharer
    rawSignal(sharer, { to: stranger.id, data: offer }); // sharer → non-viewer
    rawSignal(sharer, { to: sharer.id, data: offer }); // sharer → itself

    for (const c of [v1, stranger, sharer]) await flush(c);
    for (const c of [v2, sharer, stranger]) await flush(c);
    expect(v2.signals).toEqual([]);
    expect(sharer.signals).toEqual([]);
    expect(stranger.signals).toEqual([]);
  });

  it("drops malformed and oversized payloads", async () => {
    await start();
    const { sharer, viewers } = await share(1);
    const [v] = viewers;

    rawSignal(sharer, null);
    rawSignal(sharer, "offer");
    rawSignal(sharer, [v.id, offer]);
    rawSignal(sharer, { to: 7, data: offer });
    rawSignal(sharer, { to: v.id });
    rawSignal(sharer, { to: v.id, data: "offer" });
    rawSignal(sharer, { to: v.id, data: [offer] });
    rawSignal(sharer, { to: v.id, data: { type: "bye", sdp: "x" } });
    rawSignal(sharer, { to: v.id, data: { sdp: "x" } });
    rawSignal(sharer, {
      to: v.id,
      data: { type: "offer", sdp: "x".repeat(LIMITS.maxSignalBytes) },
    });
    // A binary attachment arrives as a Buffer, not a plain object.
    rawSignal(sharer, { to: v.id, data: Buffer.from('{"type":"offer"}') });
    // Just under the cap still goes through, proving the size check isn't
    // over-eager (the JSON wrapper is counted in the limit).
    const wrapper = JSON.stringify({ type: "offer", sdp: "" }).length;
    const maxSdp = "y".repeat(LIMITS.maxSignalBytes - wrapper);
    rawSignal(sharer, { to: v.id, data: { type: "offer", sdp: maxSdp } });

    await waitUntil(() => v.signals.length >= 1);
    await flush(sharer);
    await flush(v);
    expect(v.signals).toHaveLength(1);
    expect(v.signals[0].data).toEqual({ type: "offer", sdp: maxSdp });
  });

  it("stops relaying to a viewer once it has left", async () => {
    await start();
    const { sharer, viewers } = await share(1);
    const [v] = viewers;
    v.socket.emit("screen:leave");
    await waitUntil(() => sharer.left.length === 1);
    rawSignal(sharer, { to: v.id, data: offer });
    rawSignal(v, { to: sharer.id, data: answer });
    await flush(sharer);
    await flush(v);
    await flush(sharer);
    expect(v.signals).toEqual([]);
    expect(sharer.signals).toEqual([]);
  });
});

describe("screen share and disconnects", () => {
  it("ends the share for everyone when the sharer disconnects", async () => {
    await start();
    const { sharer, viewers } = await share(2);
    const bystander = await connect();
    await waitUntil(() => bystander.screen?.viewers === 2);

    sharer.socket.disconnect();
    for (const c of [...viewers, bystander]) {
      await waitUntil(() => c.screen?.sharer === null);
      expect(c.screen).toEqual({ sharer: null, viewers: 0 });
    }
    expect(await emitAck(viewers[0], "screen:join")).toEqual({
      ok: false,
      error: "not-found",
    });
    // Someone else can share now.
    expect(await emitAck(bystander, "screen:start")).toEqual({
      ok: true,
      id: bystander.id,
    });
  });

  it("tells the sharer when a viewer disconnects", async () => {
    await start();
    const { sharer, viewers } = await share(2);
    await waitUntil(() => sharer.screen?.viewers === 2);
    viewers[0].socket.disconnect();
    await waitUntil(() => sharer.left.length === 1);
    expect(sharer.left).toEqual([viewers[0].id]);
    await waitUntil(() => sharer.screen?.viewers === 1);
    expect(sharer.screen?.sharer?.id).toBe(sharer.id);
  });
});

describe("signal rate limiter", () => {
  it("is independent of the text limiter in both directions", async () => {
    await start();
    const a = await connect();
    const deleteAck = () =>
      new Promise<ActionAck>((resolve) =>
        a.socket.emit("item:delete", "no-such-id", resolve),
      );

    // Exhaust the text/delete budget…
    for (let i = 0; i < LIMITS.rateLimitEvents; i += 1) await deleteAck();
    expect(await deleteAck()).toEqual({ ok: false, error: "rate-limited" });
    // …screen events still go through.
    expect(await emitAck(a, "screen:start")).toEqual({ ok: true, id: a.id });

    // Exhaust the signal budget (one event already spent above).
    const acks = await Promise.all(
      Array.from({ length: LIMITS.signalRateLimitEvents }, () =>
        emitAck(a, "screen:start"),
      ),
    );
    expect(acks.at(-1)).toEqual({ ok: false, error: "rate-limited" });
    expect(acks.filter((r) => r.ok)).toHaveLength(LIMITS.signalRateLimitEvents - 1);
  });

  it("never drops screen:stop or screen:leave, even over the signal budget", async () => {
    await start();
    const { sharer, viewers } = await share(2);
    // Burn both clients' signal budgets on candidates.
    const candidate: RtcSignalData = { type: "candidate", candidate: null };
    for (let i = 0; i < LIMITS.signalRateLimitEvents + 5; i += 1) {
      rawSignal(sharer, { to: viewers[0].id, data: candidate });
      rawSignal(viewers[1], { to: sharer.id, data: candidate });
    }
    await flush(sharer);
    await flush(viewers[1]);

    // A dropped leave would leave a phantom viewer the client already gave up.
    viewers[1].socket.emit("screen:leave");
    await waitUntil(() => sharer.left.includes(viewers[1].id));
    await waitUntil(() => sharer.screen?.viewers === 1);

    // A dropped stop would leave a phantom sharer blocking everyone else.
    sharer.socket.emit("screen:stop");
    await waitUntil(() => viewers[0].screen?.sharer === null);
  });

  it("does not let signal traffic consume the text budget", async () => {
    await start();
    const { sharer, viewers } = await share(1);
    for (let i = 0; i < LIMITS.rateLimitEvents + 5; i += 1) {
      rawSignal(sharer, { to: viewers[0].id, data: offer });
    }
    const ack = await new Promise<ActionAck>((resolve) =>
      sharer.socket.emit("text:send", { html: "still fine" }, resolve),
    );
    expect(ack.ok).toBe(true);
    await waitUntil(() => viewers[0].signals.length === LIMITS.rateLimitEvents + 5);
  });
});
