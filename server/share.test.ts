import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createSyncSplatServer, type SyncSplatServer } from "./index";
import type { ServerInfo, ShareListing } from "../shared/types";

let server: SyncSplatServer | undefined;
let baseUrl = "";
let shareRoot: string | undefined;

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Build a share tree with nested dirs, a dotfile, a dot-dir, and mixed-case
// names to exercise sorting and the dotfile exclusions.
function makeShareRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-splat-share-"));
  fs.writeFileSync(path.join(dir, "apple.txt"), "apple");
  fs.writeFileSync(path.join(dir, "Banana.txt"), "banana");
  fs.writeFileSync(path.join(dir, "photo.png"), PNG_BYTES);
  fs.writeFileSync(path.join(dir, ".hidden"), "secret");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "config"), "[core]");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "nested.txt"), "nested");
  fs.mkdirSync(path.join(dir, "Zdir"));
  return dir;
}

async function start(
  opts: Partial<Parameters<typeof createSyncSplatServer>[0]> = {},
): Promise<void> {
  server = await createSyncSplatServer({ port: 0, host: "127.0.0.1", ...opts });
  baseUrl = `http://127.0.0.1:${server.address.port}`;
}

async function startShared(
  extra: Partial<Parameters<typeof createSyncSplatServer>[0]> = {},
): Promise<void> {
  shareRoot = makeShareRoot();
  await start({ shareDir: shareRoot, ...extra });
}

function q(param: string, value: string): string {
  const p = new URLSearchParams();
  p.set(param, value);
  return p.toString();
}

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  if (shareRoot) {
    fs.rmSync(shareRoot, { recursive: true, force: true });
    shareRoot = undefined;
  }
});

describe("GET /api/share/ls", () => {
  it("lists the root: dirs first then files, case-insensitive, dotfiles absent", async () => {
    await startShared();
    const res = await fetch(`${baseUrl}/api/share/ls`);
    expect(res.status).toBe(200);
    const listing = (await res.json()) as ShareListing;
    expect(listing.path).toBe("");
    expect(listing.entries.map((e) => e.name)).toEqual([
      "sub",
      "Zdir",
      "apple.txt",
      "Banana.txt",
      "photo.png",
    ]);
    const apple = listing.entries.find((e) => e.name === "apple.txt");
    expect(apple).toMatchObject({ kind: "file", size: 5 });
    const sub = listing.entries.find((e) => e.name === "sub");
    expect(sub).toMatchObject({ kind: "dir", size: 0 });
    // Neither the dotfile nor the dot-dir appear.
    expect(listing.entries.some((e) => e.name.startsWith("."))).toBe(false);
  });

  it("lists a subdirectory", async () => {
    await startShared();
    const res = await fetch(`${baseUrl}/api/share/ls?${q("path", "sub")}`);
    expect(res.status).toBe(200);
    const listing = (await res.json()) as ShareListing;
    expect(listing.path).toBe("sub");
    expect(listing.entries.map((e) => e.name)).toEqual(["nested.txt"]);
  });

  it("404s when the path is a file, not a directory", async () => {
    await startShared();
    const res = await fetch(`${baseUrl}/api/share/ls?${q("path", "apple.txt")}`);
    expect(res.status).toBe(404);
  });

  it.each([
    ["parent traversal", ".."],
    ["encoded traversal", "%2e%2e"],
    ["nested traversal", "sub/../.."],
    ["absolute path", "/etc/passwd"],
    ["backslash segment", "sub\\..\\.."],
    ["dotfile", ".hidden"],
    ["dot-dir", ".git"],
  ])("404s on bad path: %s", async (_label, raw) => {
    await startShared();
    // Pre-encoded cases (containing "%") go on the wire verbatim so the
    // server's own URL-decoding turns %2e%2e into ".." and the traversal
    // guard is genuinely exercised; encoding them again would make the
    // server see the harmless literal string "%2e%2e".
    const query = raw.includes("%") ? raw : encodeURIComponent(raw);
    const res = await fetch(`${baseUrl}/api/share/ls?path=${query}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/share/dl", () => {
  it("round-trips file bytes with attachment + nosniff headers", async () => {
    await startShared();
    const res = await fetch(
      `${baseUrl}/api/share/dl?${q("path", "apple.txt")}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("filename*=UTF-8''");
    expect(await res.text()).toBe("apple");
  });

  it("serves an image extension inline with the real mime", async () => {
    await startShared();
    const res = await fetch(
      `${baseUrl}/api/share/dl?${q("path", "photo.png")}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(PNG_BYTES)).toBe(true);
  });

  it("404s on a dotfile, traversal, and a directory", async () => {
    await startShared();
    const dotfile = await fetch(
      `${baseUrl}/api/share/dl?path=${encodeURIComponent(".hidden")}`,
    );
    expect(dotfile.status).toBe(404);
    const traversal = await fetch(
      `${baseUrl}/api/share/dl?path=${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(traversal.status).toBe(404);
    const dir = await fetch(`${baseUrl}/api/share/dl?${q("path", "sub")}`);
    expect(dir.status).toBe(404);
  });
});

describe("POST /api/share/upload", () => {
  it("saves a file and 201s with its name", async () => {
    await startShared();
    const res = await fetch(`${baseUrl}/api/share/upload?${q("name", "up.txt")}`, {
      method: "POST",
      body: "hello share",
    });
    expect(res.status).toBe(201);
    expect((await res.json()) as { name: string }).toEqual({ name: "up.txt" });
    expect(fs.readFileSync(path.join(shareRoot!, "up.txt"), "utf8")).toBe(
      "hello share",
    );
  });

  it("never overwrites: suffixes ' (1)', ' (2)' before the extension", async () => {
    await startShared();
    const upload = async () => {
      const res = await fetch(`${baseUrl}/api/share/upload?${q("name", "dup.txt")}`, {
        method: "POST",
        body: "x",
      });
      return (await res.json()) as { name: string };
    };
    expect((await upload()).name).toBe("dup.txt");
    expect((await upload()).name).toBe("dup (1).txt");
    expect((await upload()).name).toBe("dup (2).txt");
    expect(fs.existsSync(path.join(shareRoot!, "dup (2).txt"))).toBe(true);
  });

  it("uploads into a subdirectory", async () => {
    await startShared();
    const res = await fetch(
      `${baseUrl}/api/share/upload?${q("dir", "sub")}&${q("name", "child.txt")}`,
      { method: "POST", body: "in sub" },
    );
    expect(res.status).toBe(201);
    expect(fs.readFileSync(path.join(shareRoot!, "sub", "child.txt"), "utf8")).toBe(
      "in sub",
    );
  });

  it("404s uploading to a missing, dot, or traversal directory", async () => {
    await startShared();
    const missing = await fetch(
      `${baseUrl}/api/share/upload?${q("dir", "nope")}&${q("name", "a.txt")}`,
      { method: "POST", body: "x" },
    );
    expect(missing.status).toBe(404);
    const dotDir = await fetch(
      `${baseUrl}/api/share/upload?dir=${encodeURIComponent(".git")}&name=a.txt`,
      { method: "POST", body: "x" },
    );
    expect(dotDir.status).toBe(404);
    const traversal = await fetch(
      `${baseUrl}/api/share/upload?dir=${encodeURIComponent("..")}&name=a.txt`,
      { method: "POST", body: "x" },
    );
    expect(traversal.status).toBe(404);
  });

  it("400s a dotfile target name", async () => {
    await startShared();
    const res = await fetch(
      `${baseUrl}/api/share/upload?name=${encodeURIComponent(".env")}`,
      { method: "POST", body: "SECRET=1" },
    );
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(shareRoot!, ".env"))).toBe(false);
  });

  it("413s an oversize upload", async () => {
    await startShared({ maxFileBytes: 1024 });
    const res = await fetch(`${baseUrl}/api/share/upload?${q("name", "big.bin")}`, {
      method: "POST",
      body: Buffer.alloc(4096, 1),
    });
    expect(res.status).toBe(413);
    expect(fs.existsSync(path.join(shareRoot!, "big.bin"))).toBe(false);
  });

  it("403s a cross-origin upload and leaves nothing behind", async () => {
    await startShared();
    const res = await fetch(`${baseUrl}/api/share/upload?${q("name", "evil.txt")}`, {
      method: "POST",
      body: "payload",
      headers: { Origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(shareRoot!, "evil.txt"))).toBe(false);
  });

  it("201s a no-Origin (CLI) upload", async () => {
    await startShared();
    const res = await fetch(`${baseUrl}/api/share/upload?${q("name", "cli.txt")}`, {
      method: "POST",
      body: "payload",
    });
    expect(res.status).toBe(201);
  });

  it("leaves no temp files behind after uploads", async () => {
    await startShared();
    await fetch(`${baseUrl}/api/share/upload?${q("name", "clean.txt")}`, {
      method: "POST",
      body: "x",
    });
    const leftover = fs
      .readdirSync(shareRoot!)
      .filter((n) => n.startsWith(".sync-splat-tmp-"));
    expect(leftover).toEqual([]);
  });

  it("cleans up the temp file when the client aborts mid-upload", async () => {
    await startShared();
    // Send headers + a partial body, then sever the connection before the
    // body completes — the server must remove its temp file, not leak it.
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port: server!.address.port,
        path: `/api/share/upload?${q("name", "aborted.bin")}`,
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
      });
      req.on("error", () => resolve());
      req.flushHeaders();
      req.write(Buffer.alloc(1024, 7), () => {
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 50);
      });
    });
    // Give the server a beat to observe the close and unlink.
    await new Promise((r) => setTimeout(r, 150));
    const names = fs.readdirSync(shareRoot!);
    expect(names.filter((n) => n.startsWith(".sync-splat-tmp-"))).toEqual([]);
    expect(names).not.toContain("aborted.bin");
  });

  it("rejects symlinks that point outside the share root", async () => {
    await startShared();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sync-splat-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
    fs.symlinkSync(
      path.join(outside, "secret.txt"),
      path.join(shareRoot!, "escape.txt"),
    );
    fs.symlinkSync(outside, path.join(shareRoot!, "escape-dir"));
    try {
      const dl = await fetch(`${baseUrl}/api/share/dl?${q("path", "escape.txt")}`);
      expect(dl.status).toBe(404);
      const ls = await fetch(`${baseUrl}/api/share/ls?${q("path", "escape-dir")}`);
      expect(ls.status).toBe(404);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("still serves symlinks whose target stays inside the root", async () => {
    await startShared();
    fs.writeFileSync(path.join(shareRoot!, "real.txt"), "inside");
    fs.symlinkSync(
      path.join(shareRoot!, "real.txt"),
      path.join(shareRoot!, "alias.txt"),
    );
    const dl = await fetch(`${baseUrl}/api/share/dl?${q("path", "alias.txt")}`);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe("inside");
  });
});

describe("sharing disabled (shareDir: null)", () => {
  it("404s every /api/share/* route", async () => {
    await start({ shareDir: null });
    const ls = await fetch(`${baseUrl}/api/share/ls`);
    expect(ls.status).toBe(404);
    const dl = await fetch(`${baseUrl}/api/share/dl?path=x`);
    expect(dl.status).toBe(404);
    const up = await fetch(`${baseUrl}/api/share/upload?name=x`, {
      method: "POST",
      body: "x",
    });
    expect(up.status).toBe(404);
  });

  it("reports share: null in /api/info", async () => {
    await start({ shareDir: null });
    const info = (await (await fetch(`${baseUrl}/api/info`)).json()) as ServerInfo;
    expect(info.share).toBeNull();
  });
});

describe("factory validation of shareDir", () => {
  it("rejects a shareDir that does not exist", async () => {
    await expect(
      createSyncSplatServer({
        port: 0,
        host: "127.0.0.1",
        shareDir: path.join(os.tmpdir(), "sync-splat-does-not-exist-xyz"),
      }),
    ).rejects.toThrow();
  });

  it("rejects a shareDir that points at a file", async () => {
    const file = path.join(os.tmpdir(), `sync-splat-file-${Date.now()}.txt`);
    fs.writeFileSync(file, "x");
    try {
      await expect(
        createSyncSplatServer({ port: 0, host: "127.0.0.1", shareDir: file }),
      ).rejects.toThrow(/not a directory/);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe("/api/info share + mdns fields", () => {
  it("reports the share name and an mdnsUrl", async () => {
    await startShared();
    const info = (await (await fetch(`${baseUrl}/api/info`)).json()) as ServerInfo;
    expect(info.share).toEqual({ name: path.basename(shareRoot!) });
    // getMdnsUrl returns a string on any machine with a hostname (CI/dev).
    expect(info.mdnsUrl === null || typeof info.mdnsUrl === "string").toBe(true);
    if (info.mdnsUrl) expect(info.mdnsUrl).toMatch(/^http:\/\/.+\.local:\d+$/);
  });
});

describe("POST /api/network/refresh", () => {
  it("200s and returns fresh urls + share fields", async () => {
    await startShared();
    const res = await fetch(`${baseUrl}/api/network/refresh`, { method: "POST" });
    expect(res.status).toBe(200);
    const info = (await res.json()) as ServerInfo;
    expect(Array.isArray(info.urls)).toBe(true);
    expect(info.share).toEqual({ name: path.basename(shareRoot!) });
    expect(info.mdnsUrl === null || typeof info.mdnsUrl === "string").toBe(true);
  });

  it("403s a cross-origin refresh", async () => {
    await startShared();
    const res = await fetch(`${baseUrl}/api/network/refresh`, {
      method: "POST",
      headers: { Origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("405s a GET", async () => {
    await startShared();
    const res = await fetch(`${baseUrl}/api/network/refresh`, { method: "GET" });
    expect(res.status).toBe(405);
  });
});
