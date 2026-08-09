import crypto from "node:crypto";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { AUTH } from "../shared/types";
import { sendJson } from "./util";

/**
 * Passcode auth for a sync-splat server. The passcode ("token") is opt-in:
 * when it is null every check passes and behaviour is exactly as it was before
 * passcodes existed. When it is set, a matching key must accompany the request.
 *
 * The key travels three ways so both browsers and non-browser clients can
 * authenticate:
 *   - the `X-Splat-Key` header (fetch/XHR/CLI)
 *   - a `k`/`key` query param (<a href>/<img src> downloads can't set headers)
 *   - the `splat-key` cookie (the client sets it so <a>/<img> carry it too)
 *
 * Comparison is constant-time: both sides are SHA-256 hashed to a fixed 32-byte
 * digest and compared with timingSafeEqual, so neither the key's length nor its
 * matching prefix leaks through response timing.
 */

/** Pull the `splat-key` value out of a Cookie header, or null if absent. */
export function keyFromCookieHeader(
  cookieHeader: string | string[] | undefined,
): string | null {
  const header = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== AUTH.cookie) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * Extract a candidate key from an HTTP request, in priority order: the
 * X-Splat-Key header, then the `k`/`key` query param, then the splat-key
 * cookie. Returns null when the request carries no key at all.
 */
export function extractKey(req: IncomingMessage): string | null {
  const header = req.headers[AUTH.header];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (typeof headerValue === "string" && headerValue.length > 0) {
    return headerValue;
  }

  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const query = url.searchParams.get("k") ?? url.searchParams.get("key");
    if (query) return query;
  } catch {
    // Malformed URL — fall through to the cookie.
  }

  return keyFromCookieHeader(req.headers.cookie);
}

/**
 * Constant-time equality of a candidate key against the configured token.
 * Both are hashed to a fixed-length digest first so the comparison never
 * short-circuits on length or a matching prefix.
 */
export function keysMatch(candidate: string, token: string): boolean {
  const a = crypto.createHash("sha256").update(candidate, "utf8").digest();
  const b = crypto.createHash("sha256").update(token, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * True when the request is authorised: always true when no passcode is set,
 * otherwise true only when it carries a key that matches (constant-time).
 */
export function checkKey(req: IncomingMessage, token: string | null): boolean {
  if (token === null) return true;
  const candidate = extractKey(req);
  if (candidate === null) return false;
  return keysMatch(candidate, token);
}

/** The subset of a socket.io handshake the key check needs. */
export interface SocketHandshake {
  auth?: { token?: unknown };
  headers: IncomingHttpHeaders;
}

/**
 * Socket variant of checkKey: reads the handshake `auth.token` first, then
 * falls back to the splat-key cookie sent with the upgrade request.
 */
export function checkSocketKey(
  handshake: SocketHandshake,
  token: string | null,
): boolean {
  if (token === null) return true;
  const authToken = handshake.auth?.token;
  const candidate =
    typeof authToken === "string" && authToken.length > 0
      ? authToken
      : keyFromCookieHeader(handshake.headers.cookie);
  if (candidate === null) return false;
  return keysMatch(candidate, token);
}

/**
 * Gate a request handler: returns true and lets the caller proceed when the
 * key is valid (or no passcode is set); otherwise sends a 401 JSON body and
 * returns false so the caller can bail out.
 */
export function requireKey(
  req: IncomingMessage,
  res: ServerResponse,
  token: string | null,
): boolean {
  if (checkKey(req, token)) return true;
  sendJson(res, 401, { error: "unauthorized" });
  return false;
}
