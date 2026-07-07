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
  maxFileBytes: number;
  maxTextBytes: number;
}

export interface ServerToClientEvents {
  history: (items: Item[]) => void;
  "item:new": (item: Item) => void;
  "item:deleted": (id: string) => void;
}

export interface ClientToServerEvents {
  "text:send": (payload: { html: string }) => void;
  "item:delete": (id: string) => void;
}

export const LIMITS = {
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
