/**
 * Client-side passcode handling.
 *
 * When a server is started with a passcode, the token is delivered to the
 * browser in the URL fragment (`http://host:port/#k=<token>`) — fragments
 * never reach the server or its logs. On boot we read it, persist it, strip it
 * from the address bar, and thereafter attach it to every request:
 *   - fetch / XHR: the `X-Splat-Key` header (authHeaders()).
 *   - <a href> / <img src>: a `?k=<token>` query param (withKey()) — those
 *     can't set headers. A SameSite=Strict cookie is also set as a backstop.
 *   - socket.io: the handshake `auth.token` (see socket.ts).
 */

import { AUTH, parseTokenFromHash } from "../shared/types";

// Re-exported so existing importers (and tests) can keep using it from here.
export { parseTokenFromHash };

const STORAGE_KEY = "sync-splat-key";

/** In-memory cache so we don't hit localStorage on every request. `undefined`
 *  means "not yet loaded"; `null` means "known to be absent". */
let cachedToken: string | null | undefined;

/** The token we know about, if any (from the fragment or a prior session). */
export function getToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  try {
    cachedToken = localStorage.getItem(STORAGE_KEY);
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

/** Persist a token to localStorage + a SameSite=Strict cookie (for <a>/<img>). */
export function setToken(token: string): void {
  cachedToken = token;
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* private mode / storage disabled — the in-memory cache still serves us */
  }
  // No `Secure` flag: sync-splat runs over plain http on the LAN by design.
  document.cookie = `${AUTH.cookie}=${encodeURIComponent(token)}; path=/; SameSite=Strict; max-age=31536000`;
}

/**
 * On boot: if the fragment carries a token, store it and strip the fragment
 * from the URL so it can't leak via history, bookmarks, or referrers. Safe to
 * call when there is no fragment (does nothing).
 */
export function initAuthFromHash(): void {
  const token = parseTokenFromHash(location.hash);
  if (!token) return;
  setToken(token);
  history.replaceState(null, "", location.pathname + location.search);
}

/** Forget the stored key (localStorage + cookie + cache). Used when a key is
 *  rejected so the next attempt starts clean. */
export function clearToken(): void {
  cachedToken = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage disabled — the cache reset above still applies */
  }
  document.cookie = `${AUTH.cookie}=; path=/; SameSite=Strict; max-age=0`;
}

/** Request headers carrying the key, or `{}` when there is no key. */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { [AUTH.header]: token } : {};
}

/** Append `?k=<token>`/`&k=<token>` to a download/preview URL for <a>/<img>. */
export function withKey(url: string): string {
  const token = getToken();
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${AUTH.fragmentParam}=${encodeURIComponent(token)}`;
}
