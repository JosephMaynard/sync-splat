import type { Server } from "socket.io";
import type {
  ActionAck,
  ClientToServerEvents,
  ServerToClientEvents,
} from "../shared/types";
import { LIMITS } from "../shared/types";
import type { HistoryStore } from "./store";

export type SyncSplatIO = Server<ClientToServerEvents, ServerToClientEvents>;

/** Simple per-socket sliding-window rate limiter. */
export function createRateLimiter(): () => boolean {
  const events: number[] = [];
  return function allow(): boolean {
    const now = Date.now();
    while (events.length > 0 && now - events[0] > LIMITS.rateLimitWindowMs) {
      events.shift();
    }
    if (events.length >= LIMITS.rateLimitEvents) return false;
    events.push(now);
    return true;
  };
}

export function registerSocketHandlers(io: SyncSplatIO, store: HistoryStore): void {
  io.on("connection", (socket) => {
    socket.emit("history", store.getHistory());
    const allow = createRateLimiter();

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
      io.emit("item:new", item);
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
        io.emit("item:deleted", id);
        respond({ ok: true, id });
      } else {
        respond({ ok: false, error: "not-found" });
      }
    });
  });
}
