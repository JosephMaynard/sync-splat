import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../shared/types";

/**
 * Same-origin socket. In production the server serves the client, so `io()`
 * with no URL connects back to the origin. In dev, Vite proxies `/socket.io`.
 */
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
  autoConnect: true,
});
