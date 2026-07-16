import type { ServerResponse } from "node:http";
import { INLINE_IMAGE_MIMES } from "../shared/types";

/**
 * Same-origin check for browser-initiated requests. Requests without an
 * Origin header (curl, CLI tools, same-origin navigations) are allowed.
 * When a browser sends one — which it does for cross-site POSTs and every
 * WebSocket handshake — its host must match the request's Host header.
 * Neither CORS absence nor the browser blocks those writes on its own.
 */
export function isAllowedOrigin(
  origin: string | string[] | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined) return true;
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (!value || !host) return false;
  try {
    return new URL(value).host === host;
  } catch {
    // Includes the literal "null" origin (sandboxed iframes, file://).
    return false;
  }
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BACKSLASH = String.fromCharCode(92);

/** Extension → MIME type for static assets. Unknown extensions fall back to
 *  application/octet-stream. */
export const MIME_BY_EXT: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
};

/** Extension of the final path segment, lowercased, or "" if none. */
export function extname(pathname: string): string {
  const slash = Math.max(
    pathname.lastIndexOf("/"),
    pathname.lastIndexOf(BACKSLASH),
  );
  const segment = slash >= 0 ? pathname.slice(slash + 1) : pathname;
  const dot = segment.lastIndexOf(".");
  if (dot <= 0) return "";
  return segment.slice(dot + 1).toLowerCase();
}

export function mimeForPath(pathname: string): string {
  const ext = extname(pathname);
  if (!ext) return "application/octet-stream";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function isInlineImage(mime: string): boolean {
  return (INLINE_IMAGE_MIMES as readonly string[]).includes(mime);
}

/**
 * Turn an arbitrary user-supplied name into a safe download filename:
 * strip path separators and control characters, cap the length, and fall
 * back to "file" when nothing usable remains.
 */
export function sanitizeFilename(raw: string): string {
  const input = String(raw ?? "");
  // Keep only the final path segment.
  const slash = Math.max(input.lastIndexOf("/"), input.lastIndexOf(BACKSLASH));
  const segment = slash >= 0 ? input.slice(slash + 1) : input;
  // Drop control chars, DEL, residual separators, and Unicode bidi controls
  // (U+200E/F, U+202A–E, U+2066–9) which can visually spoof extensions.
  let cleaned = "";
  for (const ch of segment) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (code === 0x200e || code === 0x200f) continue;
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    if (ch === "/" || ch === BACKSLASH) continue;
    cleaned += ch;
  }
  let name = cleaned.trim();
  if (name === "." || name === "..") name = "";
  if (name.length > 180) {
    const dot = name.lastIndexOf(".");
    if (dot > 0 && name.length - dot <= 12) {
      const ext = name.slice(dot);
      name = name.slice(0, 180 - ext.length) + ext;
    } else {
      name = name.slice(0, 180);
    }
  }
  return name.length > 0 ? name : "file";
}

/** RFC 5987 encoding for Content-Disposition filename* values. */
export function encodeRFC5987(value: string): string {
  return encodeURIComponent(value)
    .replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%(7C|60|5E)/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** ASCII-only fallback for the plain `filename=""` parameter, with quotes and
 *  backslashes neutralised. */
export function asciiFallbackName(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) out += "_";
    else if (ch === '"' || ch === BACKSLASH) out += "_";
    else out += ch;
  }
  return out.length > 0 ? out : "file";
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendStatus(
  res: ServerResponse,
  status: number,
  message = "",
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message || `${status}`);
}
