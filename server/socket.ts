import type { Server, Socket } from "socket.io";
import type {
  ActionAck,
  ClientToServerEvents,
  RtcSignalData,
  ScreenState,
  ServerToClientEvents,
} from "../shared/types";
import { LIMITS } from "../shared/types";
import type { HistoryStore } from "./store";
import type { BroadcastHub } from "./hub";
import type { PresenceRegistry } from "./presence";
import { isLoopbackAddress, sanitizeDeviceLabel } from "./presence";

export type SyncSplatIO = Server<ClientToServerEvents, ServerToClientEvents>;
type SyncSplatSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/** Simple per-socket sliding-window rate limiter. `max` events per
 *  LIMITS.rateLimitWindowMs; defaults to the text/delete budget. */
export function createRateLimiter(
  max: number = LIMITS.rateLimitEvents,
): () => boolean {
  const events: number[] = [];
  return function allow(): boolean {
    const now = Date.now();
    while (events.length > 0 && now - events[0] > LIMITS.rateLimitWindowMs) {
      events.shift();
    }
    if (events.length >= max) return false;
    events.push(now);
    return true;
  };
}

const SIGNAL_TYPES: ReadonlySet<unknown> = new Set(["offer", "answer", "candidate"]);

/** Plain JSON-style object: not null, not an array, not a Buffer or other
 *  class instance (socket.io can deliver binary attachments as Buffers). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Size of a signaling payload once JSON-encoded, or Infinity when it can't
 *  be encoded. Nothing off the wire can be cyclic or hold a BigInt, but a
 *  throw here would escape into socket.io's event dispatch. */
function signalBytes(data: unknown): number {
  try {
    const json = JSON.stringify(data);
    return typeof json === "string" ? Buffer.byteLength(json, "utf8") : Infinity;
  } catch {
    return Infinity;
  }
}

export interface SocketDeps {
  store: HistoryStore;
  hub: BroadcastHub;
  presence: PresenceRegistry;
}

export function registerSocketHandlers(io: SyncSplatIO, deps: SocketDeps): void {
  const { store, hub, presence } = deps;

  // Screen-share state for this server: at most one sharer, and the sockets
  // currently watching it. Viewers only ever exist while a sharer does.
  let sharerId: string | null = null;
  const viewers = new Set<string>();

  const screenState = (): ScreenState => ({
    sharer: sharerId === null ? null : (presence.get(sharerId) ?? null),
    viewers: viewers.size,
  });
  const broadcastScreenState = () => io.emit("screen:state", screenState());

  /** End the current share for everyone. Viewers learn from screen:state. */
  function endShare(): void {
    sharerId = null;
    viewers.clear();
    broadcastScreenState();
  }

  /** Drop a viewer and tell the sharer to tear down that peer connection. */
  function removeViewer(id: string): void {
    if (!viewers.delete(id)) return;
    if (sharerId !== null) io.to(sharerId).emit("screen:viewer-left", id);
    broadcastScreenState();
  }

  io.on("connection", (socket: SyncSplatSocket) => {
    socket.emit("history", store.getHistory());
    // Separate budgets: an ICE-candidate burst while starting a share must
    // never eat into (or be starved by) the text/delete allowance.
    const allow = createRateLimiter();
    const allowSignal = createRateLimiter(LIMITS.signalRateLimitEvents);

    // Registering broadcasts the new list to everyone, this socket included.
    const auth = socket.handshake.auth as { device?: unknown } | undefined;
    presence.add({
      id: socket.id,
      label: sanitizeDeviceLabel(auth?.device, "Unknown device"),
      kind: "browser",
      host: isLoopbackAddress(socket.handshake.address),
    });
    socket.emit("screen:state", screenState());

    socket.on("text:send", (payload, ack) => {
      // Old clients pass no callback; only invoke a real function so the
      // previous silent-drop behaviour is preserved.
      const respond = (r: ActionAck) => {
        if (typeof ack === "function") ack(r);
      };
      if (!allow()) {
        respond({ ok: false, error: "rate-limited" });
        return;
      }
      if (typeof payload !== "object" || payload === null) {
        respond({ ok: false, error: "invalid" });
        return;
      }
      const html = (payload as { html?: unknown }).html;
      if (typeof html !== "string") {
        respond({ ok: false, error: "invalid" });
        return;
      }
      if (Buffer.byteLength(html, "utf8") > LIMITS.maxTextBytes) {
        respond({ ok: false, error: "too-big" });
        return;
      }
      const item = store.addText(html);
      hub.itemNew(item);
      respond({ ok: true, id: item.id });
    });

    socket.on("item:delete", (id, ack) => {
      const respond = (r: ActionAck) => {
        if (typeof ack === "function") ack(r);
      };
      if (!allow()) {
        respond({ ok: false, error: "rate-limited" });
        return;
      }
      if (typeof id !== "string") {
        respond({ ok: false, error: "invalid" });
        return;
      }
      if (store.delete(id)) {
        hub.itemDeleted(id);
        respond({ ok: true, id });
      } else {
        respond({ ok: false, error: "not-found" });
      }
    });

    socket.on("screen:start", (ack) => {
      const respond = (r: ActionAck) => {
        if (typeof ack === "function") ack(r);
      };
      if (!allowSignal()) {
        respond({ ok: false, error: "rate-limited" });
        return;
      }
      if (sharerId === socket.id) {
        respond({ ok: true, id: socket.id });
        return;
      }
      if (sharerId !== null) {
        respond({ ok: false, error: "busy" });
        return;
      }
      // No live share means any leftover viewers are stale (including this
      // socket, if it was watching the share that just ended).
      viewers.clear();
      sharerId = socket.id;
      respond({ ok: true, id: socket.id });
      broadcastScreenState();
    });

    // stop/leave are deliberately NOT rate-limited: they only ever release
    // state the caller holds (and are no-ops otherwise), and dropping one
    // would leave a phantom sharer/viewer the client has already torn down.
    socket.on("screen:stop", () => {
      if (sharerId !== socket.id) return;
      endShare();
    });

    socket.on("screen:join", (ack) => {
      const respond = (r: ActionAck) => {
        if (typeof ack === "function") ack(r);
      };
      if (!allowSignal()) {
        respond({ ok: false, error: "rate-limited" });
        return;
      }
      if (sharerId === null) {
        respond({ ok: false, error: "not-found" });
        return;
      }
      if (sharerId === socket.id) {
        respond({ ok: false, error: "invalid" });
        return;
      }
      const rejoin = viewers.has(socket.id);
      if (!rejoin && viewers.size >= LIMITS.maxScreenViewers) {
        respond({ ok: false, error: "full" });
        return;
      }
      viewers.add(socket.id);
      // Re-sent on a re-join too: that is how a viewer retries a peer
      // connection that failed — the sharer tears down and offers afresh.
      io.to(sharerId).emit("screen:viewer-joined", socket.id);
      respond({ ok: true, id: sharerId });
      if (!rejoin) broadcastScreenState();
    });

    socket.on("screen:leave", () => {
      removeViewer(socket.id);
    });

    socket.on("rtc:signal", (msg) => {
      // Every failure here is a silent drop: signaling has no ack, and a
      // well-behaved client never trips these checks.
      if (!allowSignal()) return;
      if (!isPlainObject(msg)) return;
      const { to, data } = msg;
      if (typeof to !== "string" || !isPlainObject(data)) return;
      if (!SIGNAL_TYPES.has(data.type)) return;
      if (signalBytes(data) > LIMITS.maxSignalBytes) return;
      // Relay only along an edge of the current share: sharer ↔ one of its
      // joined viewers. Anything else (viewer → viewer, a stranger → sharer,
      // sharer → someone not watching) would let the server be used as a
      // generic message bus between arbitrary sockets.
      const fromSharer = sharerId === socket.id && viewers.has(to);
      const toSharer = viewers.has(socket.id) && to === sharerId;
      if (!fromSharer && !toSharer) return;
      // `from` is stamped here, never taken from the client, so a peer can't
      // impersonate the sharer to a viewer.
      io.to(to).emit("rtc:signal", {
        from: socket.id,
        data: data as unknown as RtcSignalData,
      });
    });

    socket.on("disconnect", () => {
      if (sharerId === socket.id) endShare();
      else removeViewer(socket.id);
      presence.remove(socket.id);
    });
  });
}
