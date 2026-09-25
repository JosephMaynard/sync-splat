import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEVICE_HEADER, EVENTS_PING_MS, LIMITS } from "../shared/types";
import type { BroadcastHub, HubEvent } from "./hub";
import type { PresenceRegistry } from "./presence";
import { isLoopbackAddress, sanitizeDeviceLabel } from "./presence";
import { VERSION } from "./net";
import { sendJson } from "./util";

/**
 * A stalled watcher (suspended laptop, ^Z'd terminal) stops reading but keeps
 * the TCP connection open, so every item broadcast piles up in its response
 * buffer. Past this many unflushed bytes the stream is dropped; the client's
 * reconnect logic picks up from there. Several max-size texts' worth, so a
 * burst to a healthy-but-slow client is never mistaken for a stall.
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface EventStreamOptions {
  hub: BroadcastHub;
  presence: PresenceRegistry;
  maxFileBytes: number;
  /** Keepalive comment interval. Defaults to EVENTS_PING_MS; tests shorten it. */
  pingMs?: number;
}

/**
 * GET /api/events — the Server-Sent Events feed behind `sync-splat watch`.
 * Routing, method, passcode and origin checks live in http.ts; this owns the
 * open streams themselves so the server can end them all on close().
 */
export interface EventStreams {
  /** Serve one stream. The request has already passed every gate. */
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** End every open stream and clear its timer (server shutdown). */
  closeAll(): void;
  /** Number of open streams. */
  readonly size: number;
}

/** Pull the terminal's label out of the X-Splat-Device header. HTTP header
 *  values are bytes (Node reads them as latin1, and fetch refuses anything
 *  above U+00FF), so clients percent-encode UTF-8 labels; plain ASCII arrives
 *  unchanged. A value that isn't valid percent-encoding is used as-is. */
function labelFromHeader(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return sanitizeDeviceLabel(undefined, "Terminal");
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // e.g. "100% done" — not an encoded label, keep the literal text.
  }
  return sanitizeDeviceLabel(decoded, "Terminal");
}

/** One SSE message. JSON.stringify never emits a raw newline (they are
 *  escaped inside strings), so `data:` is always a single line. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function frameFor(event: HubEvent): string {
  return event.name === "item:new"
    ? frame("item:new", event.item)
    : frame("item:deleted", { id: event.id });
}

export function createEventStreams(opts: EventStreamOptions): EventStreams {
  const { hub, presence, maxFileBytes } = opts;
  const pingMs = opts.pingMs ?? EVENTS_PING_MS;
  // Each open stream's teardown, keyed by its response. Teardown is
  // idempotent, so close events racing closeAll() are harmless.
  const streams = new Map<ServerResponse, () => void>();

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (streams.size >= LIMITS.maxEventStreams) {
      sendJson(res, 503, { error: "too many event streams" });
      return;
    }

    // Node's requestTimeout/headersTimeout only police receiving the request,
    // which is already complete for a bodyless GET, and server.timeout
    // defaults to 0 — so nothing kills an idle stream today (verified against
    // Node's connectionsCheckingInterval). Clearing the socket timeout
    // explicitly keeps that true even if someone sets server.timeout later.
    // Nagle is already off: http servers default to noDelay.
    req.socket.setTimeout(0);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      // Stops nginx-style reverse proxies from buffering the stream.
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      // The connection is dedicated to this stream. Closing it when the
      // response ends means closeAll() leaves no keep-alive socket behind for
      // httpServer.close() to wait on.
      Connection: "close",
    });
    res.flushHeaders();

    let closed = false;
    const write = (chunk: string) => {
      if (closed) return;
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        // Destroying fires "close", which runs teardown.
        res.destroy();
        return;
      }
      res.write(chunk);
    };

    const deviceId = `term-${crypto.randomBytes(8).toString("hex")}`;

    write(frame("hello", { version: VERSION, maxFileBytes }));
    const unsubscribe = hub.subscribe((event) => write(frameFor(event)));
    const ping = setInterval(() => write(": ping\n\n"), pingMs);
    presence.add({
      id: deviceId,
      label: labelFromHeader(req.headers[DEVICE_HEADER]),
      kind: "terminal",
      host: isLoopbackAddress(req.socket.remoteAddress),
    });

    const teardown = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribe();
      streams.delete(res);
      presence.remove(deviceId);
    };
    streams.set(res, teardown);
    // Listen for close on the RESPONSE, not the request: since Node 16 an
    // IncomingMessage may emit "close" as soon as its (empty) body has been
    // consumed, long before the client disconnects. res "close" fires when
    // the connection actually goes away, or after end().
    res.on("close", teardown);
    // A write to a reset socket emits "error"; without a listener that would
    // be an uncaught exception. "close" follows and tears down.
    res.on("error", () => {});
    // The client may have hung up before we got here, in which case "close"
    // has already fired and the listener above would never run.
    if (res.destroyed || req.socket.destroyed) teardown();
  }

  function closeAll(): void {
    for (const [res, teardown] of Array.from(streams)) {
      teardown();
      res.end();
    }
  }

  return {
    handle,
    closeAll,
    get size() {
      return streams.size;
    },
  };
}
