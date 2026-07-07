import type { Server } from "socket.io";
import type {
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

    socket.on("text:send", (payload) => {
      if (!allow()) return;
      if (typeof payload !== "object" || payload === null) return;
      const html = (payload as { html?: unknown }).html;
      if (typeof html !== "string") return;
      if (Buffer.byteLength(html, "utf8") > LIMITS.maxTextBytes) return;
      const item = store.addText(html);
      io.emit("item:new", item);
    });

    socket.on("item:delete", (id) => {
      if (!allow()) return;
      if (typeof id !== "string") return;
      if (store.delete(id)) {
        io.emit("item:deleted", id);
      }
    });
  });
}
