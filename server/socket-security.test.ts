import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { io } from "socket.io-client";
import { createSyncSplatServer, type SyncSplatServer } from "./index";

let server: SyncSplatServer;
const polling = "/socket.io/?EIO=4&transport=polling";

beforeEach(async () => {
  server = await createSyncSplatServer({ port: 0, host: "127.0.0.1" });
});
afterEach(async () => { await server.close(); });

// Node fetch may normalize Host: use raw HTTP to reproduce a rebound request.
function request(path: string, headers: Record<string, string> = {}, method = "GET", body = "") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address.port,
      path, method, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: data }));
    });
    req.setTimeout(2000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

describe("socket transport Host/Origin enforcement", () => {
  it("rejects polling handshakes with a foreign Host and no Origin", async () => {
    expect((await request(polling, { Host: "rebound.example" })).status).toBe(403);
  });

  it.each([
    ["GET", { Host: "rebound.example" }],
    ["POST", { Host: "rebound.example" }],
    ["GET", { Origin: "http://rebound.example" }],
    ["POST", { Origin: "http://rebound.example" }],
  ] as const)("rechecks %s requests on an existing session (%j)", async (method, headers) => {
    const open = await request(polling);
    expect(open.status).toBe(200);
    const { sid } = JSON.parse(open.body.slice(1));
    const result = await request(`${polling}&sid=${sid}`, headers, method,
      method === "POST" ? "40" : "");
    expect(result.status).toBe(403);
  });

  it("allows native polling clients to connect and receive history", async () => {
    server.store.addText("polling regression control");
    const open = await request(polling);
    const { sid } = JSON.parse(open.body.slice(1));
    const endpoint = `${polling}&sid=${sid}`;
    expect((await request(endpoint, { "Content-Type": "text/plain" }, "POST", "40")).status).toBe(200);
    const history = await request(endpoint);
    expect(history.status).toBe(200);
    expect(history.body).toContain("polling regression control");
  });

  it.each([{ Host: "rebound.example" }, { Origin: "http://rebound.example" }])(
    "rejects a polling-to-WebSocket upgrade with forbidden headers (%j)", async (headers) => {
      const open = await request(polling);
      const { sid } = JSON.parse(open.body.slice(1));
      const outcome = await new Promise<number | string>((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port: server.address.port,
          path: `/socket.io/?EIO=4&transport=websocket&sid=${sid}`,
          headers: { Connection: "Upgrade", Upgrade: "websocket",
            "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
        }, (res) => { res.resume(); resolve(res.statusCode!); });
        req.on("upgrade", (_res, socket) => { socket.destroy(); resolve(101); });
        req.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ECONNRESET") resolve(err.code);
          else reject(err);
        });
        req.setTimeout(2000, () => req.destroy(new Error("upgrade timed out")));
        req.end();
      });
      // Engine.IO's upgrade response shim closes rejected sockets directly.
      expect([403, "ECONNRESET"]).toContain(outcome);
    },
  );

  it("rejects a WebSocket handshake with a foreign Host even without Origin", async () => {
    const client = io(`http://127.0.0.1:${server.address.port}`, {
      transports: ["websocket"], extraHeaders: { Host: "rebound.example" },
      reconnection: false, timeout: 2000,
    });
    try {
      const result = await new Promise<string>((resolve) => {
        client.once("connect", () => resolve("connected"));
        client.once("connect_error", () => resolve("rejected"));
      });
      expect(result).toBe("rejected");
    } finally { client.disconnect(); }
  });
});
