// Shared protocol between server and client. This file is the contract —
// both sides must import from here rather than redeclaring shapes.

export interface TextItem {
  id: string;
  kind: "text";
  /** Raw HTML as captured from the sender. MUST be sanitized before rendering. */
  html: string;
  createdAt: number;
}

export interface FileItem {
  id: string;
  kind: "file";
  name: string;
  size: number;
  mime: string;
  createdAt: number;
}

export type Item = TextItem | FileItem;

export interface ServerInfo {
  name: string;
  version: string;
  /** All LAN URLs the server is reachable on, e.g. "http://192.168.1.23:3011". */
  urls: string[];
  /** mDNS URL (http://<hostname>.local:<port>) — survives Wi-Fi changes on
   *  networks with an mDNS responder (macOS/iOS, most modern systems). */
  mdnsUrl: string | null;
  /** Folder sharing config; null when disabled via --no-share. */
  share: { name: string } | null;
  maxFileBytes: number;
  maxTextBytes: number;
  /** True when a passcode is set. When true, the caller reaching this full
   *  payload has already presented a valid key (unauthenticated callers get
   *  ServerInfoLocked instead). Always present; false when no passcode. */
  authRequired: boolean;
}

/** One entry in a shared-folder listing. */
export interface ShareEntry {
  name: string;
  kind: "dir" | "file";
  /** Bytes for files; 0 for directories. */
  size: number;
  mtimeMs: number;
}

/** GET /api/share/ls?path=<rel> response. `path` is "" for the root. */
export interface ShareListing {
  path: string;
  entries: ShareEntry[];
}

/** Acknowledgement for client→server actions. Optional on the wire — old
 *  clients that pass no callback keep the previous silent-drop behavior. */
export type ActionAck =
  | { ok: true; id: string }
  | { ok: false; error: "invalid" | "too-big" | "rate-limited" | "not-found" };

export interface ServerToClientEvents {
  history: (items: Item[]) => void;
  "item:new": (item: Item) => void;
  "item:deleted": (id: string) => void;
}

export interface ClientToServerEvents {
  "text:send": (payload: { html: string }, ack?: (r: ActionAck) => void) => void;
  "item:delete": (id: string, ack?: (r: ActionAck) => void) => void;
}

/** Auth transport when a passcode is set (see AUTH):
 *  - HTTP: `X-Splat-Key` header, or the `splat-key` cookie (for <a>/<img>).
 *  - socket.io: `auth: { token }` in the handshake (cookie also accepted).
 *  - QR/share links carry it in the URL fragment: http://host:port/#k=TOKEN
 *    (fragments never reach the server or its logs; the client stores the
 *    token and strips the fragment). */
export const AUTH = {
  header: "x-splat-key",
  cookie: "splat-key",
  fragmentParam: "k",
} as const;

/** /api/info payload when a passcode is set and the caller has not presented
 *  it: everything sensitive is withheld. */
export interface ServerInfoLocked {
  name: string;
  version: string;
  authRequired: true;
}

/** File extensions the client offers rich preview for (fetched, rendered
 *  client-side, always through DOMPurify). Images use INLINE_IMAGE_MIMES. */
export const PREVIEW_MARKDOWN_EXTENSIONS = ["md", "markdown"] as const;
export const PREVIEW_CODE_EXTENSIONS = [
  "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "css", "scss", "less",
  "html", "xml", "svg",
  "json", "yml", "yaml", "toml", "ini",
  "sh", "bash", "zsh",
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs",
  "sql", "graphql", "txt", "log", "csv", "diff", "patch",
] as const;

export const LIMITS = {
  /** Max size of a file the client will fetch for text/markdown/code
   *  preview; bigger files fall back to download-only. */
  maxPreviewBytes: 512 * 1024,
  /** Max size of a single text broadcast, in bytes of UTF-8. */
  maxTextBytes: 256 * 1024,
  /** Default max size of a single uploaded file. Overridable via --max-file-size. */
  maxFileBytes: 20 * 1024 * 1024,
  /** Max number of history items kept (text + files combined). */
  maxItems: 20,
  /** Max total bytes of file blobs held in memory; oldest evicted beyond this. */
  maxTotalFileBytes: 200 * 1024 * 1024,
  /** Per-socket rate limit: max events per window. */
  rateLimitEvents: 30,
  /** Rate limit window in ms. */
  rateLimitWindowMs: 10_000,
} as const;

/** Image MIME types safe to serve inline (for thumbnails). Everything else
 *  is served as application/octet-stream attachment. SVG is deliberately
 *  excluded — it can contain script. */
export const INLINE_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;
