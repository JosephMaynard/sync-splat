import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../shared/types";
import { getToken } from "./auth";

/**
 * Same-origin socket. In production the server serves the client, so `io()`
 * with no URL connects back to the origin. In dev, Vite proxies `/socket.io`.
 *
 * autoConnect is off: the server emits `history` once, immediately on
 * connection, so listeners must be registered BEFORE connecting or a fast
 * handshake can win the race against React's effects and the history (and
 * the `connect` event itself) is silently missed. App calls socket.connect()
 * after wiring its listeners.
 *
 * `auth` is a callback so the current passcode is re-read on every (re)connect
 * — the token may be entered via the passcode prompt after this module loads.
 */
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
  autoConnect: false,
  auth: (cb: (data: { token?: string }) => void) =>
    cb({ token: getToken() ?? undefined }),
});
