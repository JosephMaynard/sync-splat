import { io, Socket } from "socket.io-client";
import type { Payload } from "./types";

export const socket: Socket = io("http://localhost:3011", {
  autoConnect: true,
});

export const sendUpdate = (payload: Payload) => socket.emit("update", payload);
