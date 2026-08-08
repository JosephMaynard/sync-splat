import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FileItem, Item } from "../shared/types";
import { LIMITS } from "../shared/types";
import type { HistoryStore } from "./store";
import type { StaticHandler } from "./static";
import { VERSION } from "./net";
import { checkKey, requireKey } from "./auth";
import { handleShareDl, handleShareLs, handleShareUpload } from "./share";
import {
  UUID_RE,
  downloadHeaders,
  isAllowedOrigin,
  sanitizeFilename,
  sendJson,
  sendStatus,
} from "./util";

/**
 * Cap on the total bytes buffered across all concurrent /api/upload requests.
 * A single file is already capped at maxFileBytes, but many uploads at once
 * could still exhaust memory; this bounds the aggregate. Kept as a local const
 * (deliberately not in shared/types, which is the client contract) and set to
 * the same ceiling as the in-memory store so a burst can never buffer more than
 * the store would ever hold. Share uploads stream to disk, so they are exempt.
 */
const MAX_IN_FLIGHT_BYTES = LIMITS.maxTotalFileBytes;

export interface RequestHandlerOptions {
  store: HistoryStore;
  staticHandler: StaticHandler;
  /** Resolved lazily so port 0 (ephemeral) works: only known after listen. */
  getUrls: () => string[];
  /** Hostnames a browser Origin may carry; enumerated fresh per request so
   *  interface changes (DHCP, Wi-Fi) are honoured. */
  getAllowedHostnames: () => ReadonlySet<string>;
  maxFileBytes: number;
  /** Broadcast a freshly-created item to all connected clients. */
  onItemCreated: (item: Item) => void;
  /** Realpath'd root of the shared folder, or null when sharing is disabled
   *  (all /api/share/* routes then 404). */
  shareDir: string | null;
  /** Stable mDNS URL for /api/info, or null when unavailable. */
  getMdnsUrl: () => string | null;
  /** Reprint the startup banner + QR with fresh URLs. Only wired when the
   *  server was started with banner:true; otherwise undefined (a no-op). */
  onNetworkRefresh?: () => void;
  /** Passcode gating every /api/* route except /api/info. null (the default)
   *  means no passcode: all checks pass and behaviour is unchanged. */
  token: string | null;
}

export type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void;

export function createRequestHandler(opts: RequestHandlerOptions): RequestHandler {
  const {
    store,
    staticHandler,
    getUrls,
    getAllowedHostnames,
    maxFileBytes,
    onItemCreated,
    shareDir,
    getMdnsUrl,
    onNetworkRefresh,
    token,
  } = opts;

  // Total bytes buffered across concurrent /api/upload requests right now.
  // Guards against many simultaneous uploads exhausting memory even though each
  // one is individually under maxFileBytes.
  let inFlightBytes = 0;

  function handleInfo(req: IncomingMessage, res: ServerResponse): void {
    // /api/info always answers 200. With a passcode set and no valid key, only
    // the locked payload (name/version/authRequired) is revealed.
    if (token !== null && !checkKey(req, token)) {
      sendJson(res, 200, {
        name: "sync-splat",
        version: VERSION,
        authRequired: true,
      });
      return;
    }
    sendJson(res, 200, {
      name: "sync-splat",
      version: VERSION,
      urls: getUrls(),
      mdnsUrl: getMdnsUrl(),
      share: shareDir ? { name: path.basename(shareDir) } : null,
      maxFileBytes,
      maxTextBytes: LIMITS.maxTextBytes,
      authRequired: token !== null,
    });
  }

  function handleUpload(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
  ): void {
    const name = sanitizeFilename(query.get("name") ?? "");
    const mime =
      (req.headers["content-type"] ?? "").split(";")[0].trim() ||
      "application/octet-stream";

    // Destroy the request only once the error response has flushed, so the
    // client actually sees the 413 instead of a reset connection.
    const rejectTooLarge = () => {
      res.once("finish", () => req.destroy());
      sendJson(res, 413, { error: "file too large" });
    };

    const contentLength = Number(req.headers["content-length"]);
    const hasLength = Number.isFinite(contentLength);
    if (hasLength && contentLength > maxFileBytes) {
      rejectTooLarge();
      return;
    }

    // Reserve against the aggregate memory budget. With a known Content-Length
    // we reserve up front (and reject before reading a byte); a chunked body
    // with no length reserves incrementally as data arrives. `reserved` is what
    // we've added to inFlightBytes so release() always balances exactly, even
    // on abort.
    let reserved = 0;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlightBytes -= reserved;
    };
    const rejectBusy = () => {
      release();
      res.once("finish", () => req.destroy());
      sendJson(res, 503, { error: "server busy" });
    };

    if (hasLength) {
      if (inFlightBytes + contentLength > MAX_IN_FLIGHT_BYTES) {
        rejectBusy();
        return;
      }
      reserved = contentLength;
      inFlightBytes += contentLength;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxFileBytes) {
        aborted = true;
        release();
        rejectTooLarge();
        return;
      }
      if (!hasLength) {
        reserved += chunk.length;
        inFlightBytes += chunk.length;
        if (inFlightBytes > MAX_IN_FLIGHT_BYTES) {
          aborted = true;
          rejectBusy();
          return;
        }
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      release();
      if (aborted) return;
      const buffer = Buffer.concat(chunks, total);
      const item = store.addFile(name, mime, buffer);
      onItemCreated(item);
      sendJson(res, 201, item);
    });

    req.on("error", () => {
      release();
      if (aborted || res.headersSent) return;
      aborted = true;
      sendStatus(res, 400, "Bad request");
    });

    // A client that vanishes mid-upload emits "close" without "end"; release the
    // reservation so aborted uploads don't leak the budget. Idempotent, so it is
    // harmless after a normal end/error.
    req.on("close", release);
  }

  /**
   * POST /api/text — post a text splat over plain HTTP (for the CLI and other
   * non-browser clients). Accepts a raw UTF-8 body (Content-Type text/plain or
   * anything non-JSON) as the html, or a JSON body `{html}`. Validated exactly
   * like the socket text:send path: a string within maxTextBytes, else 413.
   */
  function handleText(req: IncomingMessage, res: ServerResponse): void {
    const type = (req.headers["content-type"] ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const isJson = type === "application/json";

    const rejectTooLarge = () => {
      res.once("finish", () => req.destroy());
      sendJson(res, 413, { error: "text too large" });
    };

    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > LIMITS.maxTextBytes) {
      rejectTooLarge();
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > LIMITS.maxTextBytes) {
        aborted = true;
        rejectTooLarge();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks, total).toString("utf8");
      let html: string;
      if (isJson) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          const candidate = (parsed as { html?: unknown } | null)?.html;
          if (typeof candidate !== "string") {
            sendJson(res, 400, { error: "invalid" });
            return;
          }
          html = candidate;
        } catch {
          sendJson(res, 400, { error: "invalid" });
          return;
        }
      } else {
        html = raw;
      }
      // The JSON `html` string could still be over the cap even when the raw
      // body was under it, so re-check the byte length of the final value.
      if (Buffer.byteLength(html, "utf8") > LIMITS.maxTextBytes) {
        sendJson(res, 413, { error: "text too large" });
        return;
      }
      const item = store.addText(html);
      onItemCreated(item);
      sendJson(res, 201, item);
    });

    req.on("error", () => {
      if (aborted || res.headersSent) return;
      aborted = true;
      sendStatus(res, 400, "Bad request");
    });
  }

  function handleDownload(res: ServerResponse, id: string): void {
    if (!UUID_RE.test(id)) {
      sendStatus(res, 404, "Not found");
      return;
    }
    const item = store.getItem(id);
    const blob = store.getBlob(id);
    if (!item || item.kind !== "file" || !blob) {
      sendStatus(res, 404, "Not found");
      return;
    }
    const file = item as FileItem;
    res.writeHead(200, downloadHeaders(file.name, file.mime, blob.length));
    res.end(blob);
  }

  return function handle(req, res) {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      sendStatus(res, 400, "Bad request");
      return;
    }
    const pathname = url.pathname;

    // socket.io's engine responds to its own paths; it attached to the server
    // before this handler, so both see every request. Never double-respond.
    if (pathname === "/socket.io" || pathname.startsWith("/socket.io/")) {
      return;
    }

    if (pathname === "/api/info") {
      if (req.method !== "GET") {
        sendStatus(res, 405, "Method not allowed");
        return;
      }
      // Never gated: always 200, but the body is the locked payload when a
      // passcode is set and the caller has no valid key (handled inside).
      handleInfo(req, res);
      return;
    }

    if (pathname === "/api/upload") {
      if (req.method !== "POST") {
        sendStatus(res, 405, "Method not allowed");
        return;
      }
      // Cross-site "simple" POSTs execute even without CORS headers — CORS
      // only blocks reading the response. Reject writes from other origins.
      if (!isAllowedOrigin(req.headers.origin, getAllowedHostnames())) {
        // As with rejectTooLarge: destroy only after the response flushes,
        // so the client sees the 403 rather than a reset connection.
        res.once("finish", () => req.destroy());
        sendStatus(res, 403, "Cross-origin requests are not allowed");
        return;
      }
      if (!requireKey(req, res, token)) return;
      handleUpload(req, res, url.searchParams);
      return;
    }

    if (pathname === "/api/text") {
      if (req.method !== "POST") {
        sendStatus(res, 405, "Method not allowed");
        return;
      }
      if (!isAllowedOrigin(req.headers.origin, getAllowedHostnames())) {
        res.once("finish", () => req.destroy());
        sendStatus(res, 403, "Cross-origin requests are not allowed");
        return;
      }
      if (!requireKey(req, res, token)) return;
      handleText(req, res);
      return;
    }

    if (pathname === "/api/history") {
      if (req.method !== "GET") {
        sendStatus(res, 405, "Method not allowed");
        return;
      }
      if (!requireKey(req, res, token)) return;
      sendJson(res, 200, store.getHistory());
      return;
    }

    if (pathname === "/api/network/refresh") {
      if (req.method !== "POST") {
        sendStatus(res, 405, "Method not allowed");
        return;
      }
      if (!isAllowedOrigin(req.headers.origin, getAllowedHostnames())) {
        res.once("finish", () => req.destroy());
        sendStatus(res, 403, "Cross-origin requests are not allowed");
        return;
      }
      if (!requireKey(req, res, token)) return;
      // Reprint the banner (fresh URLs re-enumerated inside) when running with
      // a banner, then answer with the same payload as /api/info.
      onNetworkRefresh?.();
      handleInfo(req, res);
      return;
    }

    if (pathname === "/api/share/ls") {
      if (shareDir === null) {
        sendStatus(res, 404, "Not found");
        return;
      }
      if (req.method !== "GET") {
        sendStatus(res, 405, "Method not allowed");
        return;
      }
      if (!requireKey(req, res, token)) return;
      handleShareLs(res, shareDir, url.searchParams.get("path") ?? "").catch(
        () => sendStatus(res, 500, "Internal server error"),
      );
      return;
    }

    if (pathname === "/api/share/dl") {
      if (shareDir === null) {
        sendStatus(res, 404, "Not found");
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendStatus(res, 405, "Method not allowed");
        return;
      }
      if (!requireKey(req, res, token)) return;
      handleShareDl(
        res,
        shareDir,
        url.searchParams.get("path") ?? "",
        req.method === "HEAD",
      );
      return;
    }

    if (pathname === "/api/share/upload") {
      if (shareDir === null) {
        sendStatus(res, 404, "Not found");
        return;
      }
      if (req.method !== "POST") {
        sendStatus(res, 405, "Method not allowed");
        return;
      }
      if (!isAllowedOrigin(req.headers.origin, getAllowedHostnames())) {
        res.once("finish", () => req.destroy());
        sendStatus(res, 403, "Cross-origin requests are not allowed");
        return;
      }
      if (!requireKey(req, res, token)) return;
      handleShareUpload(
        req,
        res,
        shareDir,
        url.searchParams.get("dir") ?? "",
        url.searchParams.get("name") ?? "",
        maxFileBytes,
      ).catch(() => sendStatus(res, 500, "Internal server error"));
      return;
    }

    if (pathname.startsWith("/api/file/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendStatus(res, 405, "Method not allowed");
        return;
      }
      if (!requireKey(req, res, token)) return;
      handleDownload(res, pathname.slice("/api/file/".length));
      return;
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      sendStatus(res, 404, "Not found");
      return;
    }

    // Never let a static-serving failure become an unhandled rejection that
    // takes down the process. sendStatus destroys the response if headers
    // were already sent, and returns a clean 500 otherwise.
    staticHandler.serve(req, res).catch(() => {
      sendStatus(res, 500, "Internal server error");
    });
  };
}
