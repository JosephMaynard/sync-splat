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
  | {
      ok: false;
      error:
        | "invalid"
        | "too-big"
        | "rate-limited"
        | "not-found"
        /** screen:start while someone else is already sharing. */
        | "busy"
        /** screen:join when the share already has LIMITS.maxScreenViewers. */
        | "full";
    };

/* ---------------------------------------------------------------------------
 * Presence
 *
 * Every connected browser socket and every `sync-splat watch` event stream is
 * a Device. Browsers send a self-chosen label in the socket handshake
 * (`auth: { token, device }`); terminals send it in the X-Splat-Device header
 * on GET /api/events. The server sanitizes labels (see sanitizeDeviceLabel
 * rules in server/presence.ts) and broadcasts the full list on every change.
 * ------------------------------------------------------------------------- */

export interface Device {
  /** socket.id for browsers; a server-generated id for terminal streams.
   *  Browsers use their own socket.id to find themselves in the list. */
  id: string;
  /** Sanitized, ≤ LIMITS.maxDeviceLabelChars, e.g. "iPhone · Safari". */
  label: string;
  kind: "browser" | "terminal";
  /** Connected from a loopback address, i.e. the machine running the server. */
  host: boolean;
}

/* ---------------------------------------------------------------------------
 * Screen sharing
 *
 * One share at a time. The sharer's browser captures with getDisplayMedia
 * (needs a secure context — in practice http://localhost on the server
 * machine) and holds one RTCPeerConnection per viewer. Media flows peer to
 * peer; the server only relays signaling and never sees video.
 *
 * Flow:
 *   sharer  → screen:start (ack)          server → all: screen:state {sharer}
 *   viewer  → screen:join  (ack)          server → sharer: screen:viewer-joined
 *   sharer  → rtc:signal {to: viewer, data: offer}
 *   viewer  → rtc:signal {to: sharer, data: answer}
 *   both    → rtc:signal {…, data: ice candidate} (trickle)
 *   viewer  → screen:leave                server → sharer: screen:viewer-left
 *   sharer  → screen:stop | disconnects   server → all: screen:state {sharer: null}
 *
 * The server relays rtc:signal ONLY between the current sharer and one of its
 * joined viewers, stamps `from` itself (never trusts the client), and drops
 * payloads over LIMITS.maxSignalBytes. Viewers that disconnect are removed and
 * the sharer gets screen:viewer-left.
 * ------------------------------------------------------------------------- */

export interface ScreenState {
  /** The device currently sharing, or null when nobody is. */
  sharer: Device | null;
  /** Number of joined viewers. */
  viewers: number;
}

/** Opaque WebRTC signaling payload relayed verbatim. The server checks only
 *  that it is a plain object under LIMITS.maxSignalBytes when JSON-encoded. */
export type RtcSignalData =
  | { type: "offer" | "answer"; sdp: string }
  | { type: "candidate"; candidate: IceCandidate | null };

/** Structural copy of the DOM's RTCIceCandidateInit so this file stays
 *  DOM-free for the server build. */
export interface IceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface ServerToClientEvents {
  history: (items: Item[]) => void;
  "item:new": (item: Item) => void;
  "item:deleted": (id: string) => void;
  /** Full device list; sent to everyone on connect and on every change. */
  presence: (devices: Device[]) => void;
  /** Sent to everyone on connect and whenever sharer/viewer count changes. */
  "screen:state": (state: ScreenState) => void;
  /** Sharer only: a viewer wants the stream — create a peer and offer. */
  "screen:viewer-joined": (viewerId: string) => void;
  /** Sharer only: tear down that viewer's peer connection. */
  "screen:viewer-left": (viewerId: string) => void;
  /** Relayed signaling; `from` is stamped by the server. */
  "rtc:signal": (msg: { from: string; data: RtcSignalData }) => void;
}

export interface ClientToServerEvents {
  "text:send": (payload: { html: string }, ack?: (r: ActionAck) => void) => void;
  "item:delete": (id: string, ack?: (r: ActionAck) => void) => void;
  /** Become the sharer. ack ok → id is the sharer's socket id; "busy" if
   *  someone else is sharing. Idempotent for the current sharer. */
  "screen:start": (ack?: (r: ActionAck) => void) => void;
  /** Stop sharing (no-op unless the caller is the sharer). */
  "screen:stop": () => void;
  /** Ask to watch. ack ok → id is the sharer's socket id; "not-found" if
   *  nobody is sharing; "full" at the viewer cap; "invalid" if the caller is
   *  the sharer. */
  "screen:join": (ack?: (r: ActionAck) => void) => void;
  /** Stop watching (no-op unless joined). */
  "screen:leave": () => void;
  "rtc:signal": (msg: { to: string; data: RtcSignalData }) => void;
}

/* ---------------------------------------------------------------------------
 * Terminal event stream: GET /api/events (Server-Sent Events)
 *
 * Used by `sync-splat watch`. Same passcode gate as /api/history; no Origin
 * requirement beyond what /api/history has (it is a read). Optional
 * X-Splat-Device header sets the terminal's presence label (default
 * "Terminal"). Response is text/event-stream with these events, each `data:`
 * a single JSON line:
 *
 *   event: hello         data: {"version": "...", "maxFileBytes": n}
 *   event: item:new      data: Item
 *   event: item:deleted  data: {"id": "..."}
 *
 * plus a `: ping` comment every EVENTS_PING_MS so idle proxies and the client
 * can detect a dead connection. No history snapshot is sent: watch reports
 * only what arrives after it connects (use `history` for the backlog).
 * ------------------------------------------------------------------------- */

export const EVENTS_PING_MS = 25_000;

/** Header a terminal client uses to name itself in the presence list.
 *  Header values are bytes (Node's fetch rejects characters above U+00FF,
 *  and the server reads them as latin1), so send the label
 *  percent-encoded — `encodeURIComponent(label)`. The server decodes it;
 *  a value that isn't valid percent-encoding is used literally. */
export const DEVICE_HEADER = "x-splat-device";

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

/**
 * Extract the passcode token from a URL fragment such as `#k=abc123`. Lives
 * here (DOM-free, uses only URLSearchParams) so it is the single source of
 * truth shared by the browser client and by tests. Returns the trimmed token
 * or null. Percent-encoding is decoded by URLSearchParams.
 */
export function parseTokenFromHash(hash: string): string | null {
  if (!hash) return null;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const token = new URLSearchParams(raw).get(AUTH.fragmentParam);
  const trimmed = token?.trim();
  return trimmed ? trimmed : null;
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
  /** Separate per-socket budget for screen:* and rtc:signal events (same
   *  window). ICE trickle bursts would starve the text limiter otherwise. */
  signalRateLimitEvents: 300,
  /** Max JSON-encoded size of one rtc:signal `data` payload. SDPs are ~2–10 KB. */
  maxSignalBytes: 64 * 1024,
  /** Max simultaneous viewers of a screen share (each costs the sharer an
   *  encode). */
  maxScreenViewers: 8,
  /** Max length of a presence label, in characters, after sanitizing. */
  maxDeviceLabelChars: 40,
  /** Max concurrent GET /api/events streams (terminal watchers). */
  maxEventStreams: 16,
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
