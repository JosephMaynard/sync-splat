import type { ActionAck, IceCandidate } from "../shared/types";

/**
 * Framework-free WebRTC helpers used by useScreenShare. Kept separate (and
 * free of React / live browser objects where possible) so they unit-test in
 * vitest's node environment.
 */

/** Peer config. LAN only: no STUN/TURN — host candidates are all we need,
 *  and a public STUN server would leak the LAN to a third party. */
export const RTC_CONFIG: RTCConfiguration = { iceServers: [] };

/** Viewer gives up waiting for a working connection after this long and
 *  offers a retry (an offer that never arrives otherwise spins forever). */
export const VIEWER_CONNECT_TIMEOUT_MS = 20_000;

/** How long to wait for a screen:* ack before treating it as lost. */
export const SCREEN_ACK_TIMEOUT_MS = 8_000;

/**
 * Whether this browser can capture its screen. getDisplayMedia exists only in
 * secure contexts — on plain-http LAN that means http://localhost on the
 * server machine — and not at all on iOS. Checked by capability rather than
 * hostname so a future HTTPS mode needs no change here.
 */
export function canShareScreen(
  env: {
    isSecureContext?: boolean;
    mediaDevices?: { getDisplayMedia?: unknown };
  } = {
    isSecureContext:
      typeof window !== "undefined" ? window.isSecureContext : false,
    mediaDevices:
      typeof navigator !== "undefined" ? navigator.mediaDevices : undefined,
  },
): boolean {
  return (
    env.isSecureContext === true &&
    typeof env.mediaDevices?.getDisplayMedia === "function"
  );
}

/** True when getDisplayMedia failed because the user dismissed the picker
 *  (or denied permission) — a deliberate choice we shouldn't report as an
 *  error. Chrome/Safari throw NotAllowedError; some builds use AbortError. */
export function isPickerCancel(err: unknown): boolean {
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? (err as { name: unknown }).name
      : undefined;
  return name === "NotAllowedError" || name === "AbortError";
}

/**
 * Remote ICE candidates can arrive before the remote description is set
 * (addIceCandidate would reject then), so they're held here and flushed right
 * after setRemoteDescription. `null` is the end-of-candidates marker and is
 * queued like any other entry so ordering is preserved.
 */
export class CandidateQueue {
  private items: (IceCandidate | null)[] = [];

  push(candidate: IceCandidate | null): void {
    this.items.push(candidate);
  }

  /** Remove and return everything queued, oldest first. */
  drain(): (IceCandidate | null)[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }
}

/**
 * Emit with an ack and resolve with the server's answer, or "timeout" if none
 * arrives in time. `send` does the actual (typed) emit with the given ack
 * callback; this just adds the settle-once timer so a lost ack can't leave
 * the UI stuck in a pending state.
 */
export function awaitAck(
  send: (ack: (r: ActionAck) => void) => void,
  timeoutMs = SCREEN_ACK_TIMEOUT_MS,
): Promise<ActionAck | "timeout"> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve("timeout");
    }, timeoutMs);
    send((r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Guard against a malformed ack rather than trusting the wire blindly.
      resolve(
        r && typeof r === "object" && typeof r.ok === "boolean"
          ? r
          : { ok: false, error: "invalid" },
      );
    });
  });
}
