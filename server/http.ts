import type { IncomingMessage, ServerResponse } from "node:http";
import type { FileItem, Item } from "../shared/types";
import { LIMITS } from "../shared/types";
import type { HistoryStore } from "./store";
import type { StaticHandler } from "./static";
import { VERSION } from "./net";
import {
  UUID_RE,
  asciiFallbackName,
  encodeRFC5987,
  isAllowedOrigin,
  isInlineImage,
  sanitizeFilename,
  sendJson,
  sendStatus,
} from "./util";

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
  } = opts;

  function handleInfo(res: ServerResponse): void {
    sendJson(res, 200, {
      name: "sync-splat",
      version: VERSION,
      urls: getUrls(),
      maxFileBytes,
      maxTextBytes: LIMITS.maxTextBytes,
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
    if (Number.isFinite(contentLength) && contentLength > maxFileBytes) {
      rejectTooLarge();
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxFileBytes) {
        aborted = true;
        rejectTooLarge();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      const buffer = Buffer.concat(chunks, total);
      const item = store.addFile(name, mime, buffer);
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
    const headers: Record<string, string | number> = {
      "X-Content-Type-Options": "nosniff",
      "Content-Length": blob.length,
    };
    if (isInlineImage(file.mime)) {
      headers["Content-Type"] = file.mime;
      headers["Content-Disposition"] = "inline";
    } else {
      headers["Content-Type"] = "application/octet-stream";
      const fallback = asciiFallbackName(file.name);
      headers["Content-Disposition"] =
        `attachment; filename="${fallback}"; ` +
        `filename*=UTF-8''${encodeRFC5987(file.name)}`;
    }
    res.writeHead(200, headers);
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
      handleInfo(res);
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
      handleUpload(req, res, url.searchParams);
      return;
    }

    if (pathname.startsWith("/api/file/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendStatus(res, 405, "Method not allowed");
        return;
      }
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
