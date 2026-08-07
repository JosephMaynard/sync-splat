import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ShareEntry, ShareListing } from "../shared/types";
import {
  asciiFallbackName,
  encodeRFC5987,
  isInlineImage,
  mimeForPath,
  sanitizeFilename,
  sendJson,
  sendStatus,
} from "./util";

const BACKSLASH = String.fromCharCode(92);
const NUL = String.fromCharCode(0);

/**
 * Resolve a client-supplied relative path (already URL-decoded by URLSearchParams)
 * against the share root, enforcing the traversal + dotfile rules used by ALL
 * share routes. `""` is the root. Returns the absolute path inside the root, or
 * null if the path is invalid (the caller responds 404).
 *
 * Rules: split on "/"; reject any segment that is empty, ".", "..", starts with
 * "." (dotfiles/dot-dirs never leak — .env and .git stay private), or contains a
 * backslash or NUL. Then resolve and prefix-check as belt-and-braces.
 */
export function resolveSharePath(root: string, rel: string): string | null {
  if (rel === "") return root;
  if (rel.includes(NUL)) return null;
  const segments = rel.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return null;
    if (seg.startsWith(".")) return null;
    if (seg.includes(BACKSLASH)) return null;
  }
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/**
 * GET /api/share/ls?path=<rel> — list a shared directory. Dotfiles/dot-dirs and
 * anything that is neither a regular file nor a directory (sockets, fifos) are
 * excluded. stat (not lstat) is followed, so a symlink to a directory inside the
 * tree behaves like `python -m http.server`. Sorted dirs-first, then files,
 * case-insensitive by name.
 */
export async function handleShareLs(
  res: ServerResponse,
  root: string,
  rel: string,
): Promise<void> {
  const abs = resolveSharePath(root, rel);
  if (abs === null) {
    sendStatus(res, 404, "Not found");
    return;
  }

  let names: string[];
  try {
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) {
      sendStatus(res, 404, "Not found");
      return;
    }
    names = await fsp.readdir(abs);
  } catch {
    sendStatus(res, 404, "Not found");
    return;
  }

  const entries: ShareEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    let st: fs.Stats;
    try {
      st = await fsp.stat(path.join(abs, name));
    } catch {
      // Broken symlink or a race with deletion — skip silently.
      continue;
    }
    if (st.isDirectory()) {
      entries.push({ name, kind: "dir", size: 0, mtimeMs: st.mtimeMs });
    } else if (st.isFile()) {
      entries.push({ name, kind: "file", size: st.size, mtimeMs: st.mtimeMs });
    }
    // Anything else (sockets, fifos, devices) is intentionally omitted.
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  const body: ShareListing = { path: rel, entries };
  sendJson(res, 200, body);
}

/**
 * GET /api/share/dl?path=<rel> — stream a shared file. Same header logic as
 * /api/file/:id: nosniff always; inline for the raster image extensions, else
 * octet-stream attachment with an RFC 5987 filename. Streamed with
 * createReadStream (shared files can be large; no size cap on downloads).
 */
export function handleShareDl(
  res: ServerResponse,
  root: string,
  rel: string,
  isHead: boolean,
): void {
  const abs = resolveSharePath(root, rel);
  if (abs === null) {
    sendStatus(res, 404, "Not found");
    return;
  }

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      sendStatus(res, 404, "Not found");
      return;
    }

    const name = path.basename(abs);
    const mime = mimeForPath(abs);
    const headers: Record<string, string | number> = {
      "X-Content-Type-Options": "nosniff",
      "Content-Length": st.size,
    };
    if (isInlineImage(mime)) {
      headers["Content-Type"] = mime;
      headers["Content-Disposition"] = "inline";
    } else {
      headers["Content-Type"] = "application/octet-stream";
      const fallback = asciiFallbackName(name);
      headers["Content-Disposition"] =
        `attachment; filename="${fallback}"; ` +
        `filename*=UTF-8''${encodeRFC5987(name)}`;
    }

    if (isHead) {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    const stream = fs.createReadStream(abs);
    stream.on("error", () => {
      // If the body has started, we can only tear the connection down; before
      // headers we can still send a clean 404.
      if (res.headersSent) res.destroy();
      else sendStatus(res, 404, "Not found");
    });
    res.on("close", () => stream.destroy());
    res.writeHead(200, headers);
    stream.pipe(res);
  });
}

/** Find a non-colliding name in `dir` by suffixing " (1)", " (2)", … before the
 *  extension. Never overwrites an existing entry. */
function uniqueName(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  let n = 0;
  while (fs.existsSync(path.join(dir, candidate))) {
    n += 1;
    candidate = `${base} (${n})${ext}`;
  }
  return candidate;
}

/**
 * POST /api/share/upload?dir=<rel>&name=<filename> — save an uploaded file into
 * a shared directory. Origin-gated by the caller. Streams to a dotfile temp in
 * the same dir then renames to a non-colliding final name (never overwrites).
 * Enforces the byte cap with the same finish-then-destroy 413 as /api/upload.
 * Directories are never created.
 */
export async function handleShareUpload(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  dirRel: string,
  rawName: string,
  maxFileBytes: number,
): Promise<void> {
  // Reject before consuming the body: flush the response, then destroy the
  // request so the client sees the status instead of a reset connection.
  const rejectAndDrain = (status: number, message: string) => {
    res.once("finish", () => req.destroy());
    sendStatus(res, status, message);
  };

  const dirAbs = resolveSharePath(root, dirRel);
  if (dirAbs === null) {
    rejectAndDrain(404, "Not found");
    return;
  }

  const name = sanitizeFilename(rawName);
  if (name.startsWith(".")) {
    // A dotfile target would be invisible to ls and could clobber .env/.git.
    rejectAndDrain(400, "Invalid file name");
    return;
  }

  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxFileBytes) {
    res.once("finish", () => req.destroy());
    sendJson(res, 413, { error: "file too large" });
    return;
  }

  try {
    const dirStat = await fsp.stat(dirAbs);
    if (!dirStat.isDirectory()) {
      rejectAndDrain(404, "Not found");
      return;
    }
  } catch {
    rejectAndDrain(404, "Not found");
    return;
  }

  const tmpPath = path.join(dirAbs, `.sync-splat-tmp-${randomUUID()}`);
  const out = fs.createWriteStream(tmpPath);
  let total = 0;
  let settled = false;

  const cleanupTemp = () => {
    fs.unlink(tmpPath, () => {});
  };

  // End the whole exchange exactly once. `respond` runs after the temp file is
  // closed/removed as needed.
  const finish = (respond: () => void) => {
    if (settled) return;
    settled = true;
    respond();
  };

  out.on("error", () => {
    finish(() => {
      cleanupTemp();
      if (res.headersSent) res.destroy();
      else sendStatus(res, 500, "Internal server error");
    });
  });

  req.on("data", (chunk: Buffer) => {
    if (settled) return;
    total += chunk.length;
    if (total > maxFileBytes) {
      finish(() => {
        out.destroy();
        cleanupTemp();
        res.once("finish", () => req.destroy());
        sendJson(res, 413, { error: "file too large" });
      });
      return;
    }
    if (!out.write(chunk)) {
      req.pause();
      out.once("drain", () => req.resume());
    }
  });

  req.on("error", () => {
    finish(() => {
      out.destroy();
      cleanupTemp();
      if (!res.headersSent) sendStatus(res, 400, "Bad request");
    });
  });

  req.on("end", () => {
    if (settled) return;
    out.end(() => {
      finish(() => {
        const finalName = uniqueName(dirAbs, name);
        fs.rename(tmpPath, path.join(dirAbs, finalName), (err) => {
          if (err) {
            cleanupTemp();
            if (!res.headersSent) sendStatus(res, 500, "Internal server error");
            return;
          }
          sendJson(res, 201, { name: finalName });
        });
      });
    });
  });
}
