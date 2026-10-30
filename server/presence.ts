import type { Device } from "../shared/types";
import { LIMITS } from "../shared/types";

/**
 * Presence: who is connected right now. Every browser socket and every
 * `sync-splat watch` event stream registers one Device; the registry calls
 * onChange with the full list after every add/remove so the caller can
 * broadcast it. One registry per server instance — never module state, since
 * tests run many servers in one process.
 */
export interface PresenceRegistry {
  add(device: Device): void;
  /** Returns true if the id was registered. */
  remove(id: string): boolean;
  get(id: string): Device | undefined;
  /** Snapshot in connection order. */
  list(): Device[];
}

export function createPresenceRegistry(
  onChange: (devices: Device[]) => void,
): PresenceRegistry {
  // Map keeps insertion order, so the list reads oldest connection first.
  const devices = new Map<string, Device>();
  const list = () => Array.from(devices.values());
  return {
    add(device) {
      devices.set(device.id, device);
      onChange(list());
    },
    remove(id) {
      if (!devices.delete(id)) return false;
      onChange(list());
      return true;
    },
    get(id) {
      return devices.get(id);
    },
    list,
  };
}

/** Code points dropped outright: they render as nothing (or reorder what
 *  follows), so a label could impersonate another device or smuggle hidden
 *  text into every other client's device list. */
function isInvisible(code: number): boolean {
  if (code < 0x20 || code === 0x7f) return true; // C0 + DEL
  if (code >= 0x80 && code <= 0x9f) return true; // C1 (8-bit CSI/OSC)
  if (code === 0x061c) return true; // Arabic letter mark
  if (code === 0x180e) return true; // Mongolian vowel separator
  if (code >= 0x200b && code <= 0x200f) return true; // ZW space/joiners, LRM/RLM
  if (code >= 0x202a && code <= 0x202e) return true; // bidi embeddings/overrides
  if (code >= 0x2060 && code <= 0x2064) return true; // word joiner, invisible ops
  if (code >= 0x2066 && code <= 0x2069) return true; // bidi isolates
  if (code === 0xfeff) return true; // BOM / zero-width no-break space
  return false;
}

/**
 * Clean a client-chosen device label for display on every other device.
 * Non-strings fall back; control, bidi and zero-width characters are removed;
 * any run of whitespace (tabs and newlines included) becomes one space; the
 * result is trimmed and capped at LIMITS.maxDeviceLabelChars code points (not
 * UTF-16 units, so an emoji is never split into a lone surrogate). An empty
 * result falls back too.
 */
export function sanitizeDeviceLabel(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  let cleaned = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // Whitespace controls become spaces rather than vanishing, so
    // "Joseph's\tMac" doesn't collapse to "Joseph'sMac".
    if (code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c ||
        code === 0x0d || code === 0x85) {
      cleaned += " ";
      continue;
    }
    if (isInvisible(code)) continue;
    cleaned += ch;
  }
  const collapsed = cleaned.replace(/\s+/gu, " ").trim();
  const label = Array.from(collapsed)
    .slice(0, LIMITS.maxDeviceLabelChars)
    .join("")
    .trimEnd();
  return label.length > 0 ? label : fallback;
}

/** True for loopback peers: 127.0.0.0/8, ::1, and IPv4-mapped 127.x. Used to
 *  flag the device running on the server machine itself. */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (typeof addr !== "string") return false;
  const a = addr.toLowerCase();
  if (a === "::1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice("::ffff:".length) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}
