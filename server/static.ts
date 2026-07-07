import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, mimeForPath, sendStatus } from "./util";

const NUL = String.fromCharCode(0);

export interface StaticHandler {
  /** True when a client build (index.html) was found in the client dir. */
  hasClient: boolean;
  clientDir?: string;
  serve(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

/**
 * Traversal-safe static file server for the built client. Decodes and resolves
 * the request path, verifies the result stays inside the client dir, serves
 * index.html for the root and extensionless (SPA) routes, and 404s otherwise.
 */
export function createStaticHandler(clientDir: string | undefined): StaticHandler {
  const dir = clientDir ? path.resolve(clientDir) : undefined;
  const indexPath = dir ? path.join(dir, "index.html") : undefined;
  const hasClient = Boolean(indexPath && fs.existsSync(indexPath));

  async function serveFile(
    res: ServerResponse,
    absPath: string,
    cacheControl?: string,
  ): Promise<void> {
    try {
      const data = await fsp.readFile(absPath);
      const headers: Record<string, string | number> = {
        "Content-Type": mimeForPath(absPath),
        "Content-Length": data.length,
      };
      if (cacheControl) headers["Cache-Control"] = cacheControl;
      res.writeHead(200, headers);
      res.end(data);
    } catch {
      sendStatus(res, 404, "Not found");
    }
  }

  return {
    hasClient,
    clientDir: dir,
    async serve(req, res) {
      if (!dir || !indexPath || !hasClient) {
        sendStatus(res, 404, "Not found");
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendStatus(res, 405, "Method not allowed");
        return;
      }

      let pathname: string;
      try {
        const parsed = new URL(req.url ?? "/", "http://localhost");
        pathname = decodeURIComponent(parsed.pathname);
      } catch {
        sendStatus(res, 404, "Not found");
        return;
      }
      if (pathname.includes(NUL)) {
        sendStatus(res, 404, "Not found");
        return;
      }

      // Root and extensionless paths are SPA routes → index.html.
      if (pathname === "/" || extname(pathname) === "") {
        await serveFile(res, indexPath, "no-cache");
        return;
      }

      const resolved = path.resolve(dir, "." + pathname);
      if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
        sendStatus(res, 404, "Not found");
        return;
      }

      let stat: fs.Stats;
      try {
        stat = await fsp.stat(resolved);
      } catch {
        sendStatus(res, 404, "Not found");
        return;
      }
      if (!stat.isFile()) {
        sendStatus(res, 404, "Not found");
        return;
      }

      let cacheControl: string | undefined;
      if (pathname.startsWith("/assets/")) {
        cacheControl = "public, max-age=31536000, immutable";
      } else if (path.basename(resolved) === "index.html") {
        cacheControl = "no-cache";
      }
      await serveFile(res, resolved, cacheControl);
    },
  };
}
