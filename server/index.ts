import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import type {
  ClientToServerEvents,
  Item,
  ServerToClientEvents,
} from "../shared/types";
import { LIMITS } from "../shared/types";
import { HistoryStore } from "./store";
import { createStaticHandler } from "./static";
import { createRequestHandler } from "./http";
import { registerSocketHandlers, type SyncSplatIO } from "./socket";
import { VERSION, getAllowedHostnames, getLanUrls, getMdnsUrl } from "./net";
import { isAllowedOrigin } from "./util";
import { printBanner } from "./banner";

export { VERSION };

export interface SyncSplatOptions {
  /** Port to listen on. Use 0 for an ephemeral port (tests). */
  port: number;
  /** Interface to bind. Defaults to 0.0.0.0 (all interfaces). */
  host?: string;
  /** Max single-file upload size in bytes. Defaults to LIMITS.maxFileBytes. */
  maxFileBytes?: number;
  /** Directory of the built client. Defaults to ../client relative to this
   *  module (i.e. dist/client next to dist/server). */
  clientDir?: string;
  /** Print the startup banner + QR to stdout. Off by default so tests stay
   *  quiet and never depend on the QR encoder. */
  banner?: boolean;
  /** Shared-folder root. A string shares that directory; null disables sharing
   *  entirely; undefined (the default) shares process.cwd(), like
   *  `python -m http.server`. Non-null values must be an existing directory. */
  shareDir?: string | null;
}

export interface SyncSplatServer {
  httpServer: http.Server;
  io: SyncSplatIO;
  store: HistoryStore;
  /** The bound address once listening (port is resolved even for port 0). */
  address: { host: string; port: number };
  /** LAN URLs the server is reachable on. */
  urls: string[];
  /** Whether a client build was found and is being served. */
  hasClient: boolean;
  close(): Promise<void>;
}

function defaultClientDir(): string | undefined {
  try {
    return fileURLToPath(new URL("../client/", import.meta.url));
  } catch {
    return undefined;
  }
}

/**
 * Create, start and return a sync-splat server: one HTTP server that serves the
 * built client and the HTTP API, with socket.io attached to the same port.
 * Resolves once the server is listening.
 */
export async function createSyncSplatServer(
  opts: SyncSplatOptions,
): Promise<SyncSplatServer> {
  const host = opts.host ?? "0.0.0.0";
  const maxFileBytes = opts.maxFileBytes ?? LIMITS.maxFileBytes;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    // NaN would silently disable the size cap entirely (every comparison
    // against it is false); negatives would reject every upload.
    throw new Error(
      "max file size must be a positive integer number of bytes",
    );
  }
  if (maxFileBytes > LIMITS.maxTotalFileBytes) {
    // A single file larger than total storage would be accepted, immediately
    // evict itself, and 201 with an undownloadable id. Refuse up front.
    throw new Error(
      `max file size (${Math.round(maxFileBytes / 1024 / 1024)} MB) cannot ` +
        `exceed the ${Math.round(LIMITS.maxTotalFileBytes / 1024 / 1024)} MB ` +
        `total storage cap`,
    );
  }
  const clientDir =
    opts.clientDir !== undefined ? opts.clientDir : defaultClientDir();

  // Resolve the shared-folder root: null disables sharing; undefined defaults
  // to cwd; a string shares that dir. Validate + realpath the root once so all
  // share routes prefix-check against a canonical, symlink-free path.
  let shareDir: string | null = null;
  if (opts.shareDir !== null) {
    const requested = opts.shareDir ?? process.cwd();
    let stat: fs.Stats;
    try {
      stat = fs.statSync(requested);
    } catch {
      throw new Error(`shared folder does not exist: ${requested}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`shared folder is not a directory: ${requested}`);
    }
    shareDir = fs.realpathSync(requested);
  }

  const httpServer = http.createServer();
  const io: SyncSplatIO = new Server<
    ClientToServerEvents,
    ServerToClientEvents
  >(httpServer, {
    // Same-origin in prod (server serves the client); Vite proxy in dev.
    // No CORS configuration by design.
    serveClient: false,
    // WebSocket handshakes are not subject to CORS, so enforce the origin
    // ourselves: the Origin's hostname must be one of this machine's own
    // addresses (never the spoofable Host header — DNS rebinding can make
    // Origin and Host agree on an attacker domain). CLI/native clients,
    // which send no Origin, remain able to connect.
    allowRequest: (req, callback) => {
      callback(null, isAllowedOrigin(req.headers.origin, getAllowedHostnames()));
    },
  });

  let boundPort = opts.port;
  const getUrls = () => getLanUrls(boundPort);
  const mdnsUrl = () => getMdnsUrl(boundPort);

  const store = new HistoryStore({
    maxItems: LIMITS.maxItems,
    maxTotalFileBytes: LIMITS.maxTotalFileBytes,
    onEvicted: (id) => io.emit("item:deleted", id),
  });

  const staticHandler = createStaticHandler(clientDir);
  const requestHandler = createRequestHandler({
    store,
    staticHandler,
    getUrls,
    getAllowedHostnames,
    maxFileBytes,
    onItemCreated: (item: Item) => io.emit("item:new", item),
    shareDir,
    getMdnsUrl: mdnsUrl,
    // Only reprint the banner when the server owns the terminal (banner:true).
    onNetworkRefresh: opts.banner
      ? () =>
          printBanner({
            port: boundPort,
            urls: getUrls(),
            mdnsUrl: mdnsUrl(),
            hasClient: staticHandler.hasClient,
            shareDir,
          })
      : undefined,
  });
  httpServer.on("request", requestHandler);

  registerSocketHandlers(io, store);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(opts.port, host, () => {
      httpServer.removeListener("error", onError);
      const addr = httpServer.address();
      if (addr && typeof addr === "object") boundPort = addr.port;
      resolve();
    });
  });

  const urls = getLanUrls(boundPort);
  const server: SyncSplatServer = {
    httpServer,
    io,
    store,
    address: { host, port: boundPort },
    urls,
    hasClient: staticHandler.hasClient,
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
    },
  };

  if (opts.banner) {
    printBanner({
      port: boundPort,
      urls,
      mdnsUrl: mdnsUrl(),
      hasClient: staticHandler.hasClient,
      shareDir,
    });
  }

  return server;
}
