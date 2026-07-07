<div align="center">
  <img src="public/favicon.svg" alt="sync-splat" width="96" height="96" />
  <h1>sync-splat</h1>
  <p><strong>Share text and small files between devices on your local network.</strong><br/>
  Run one command, scan the QR code on your phone, and splat things back and forth — no accounts, no cloud, no cables.</p>

  <pre><code>npx sync-splat</code></pre>
</div>

---

## What it is

sync-splat is a tiny self-hosted tool for moving rich text and files between the devices already sitting on your Wi‑Fi — your laptop, your phone, a colleague's machine across the table. It starts a single server that serves a small web app and a real‑time socket on the same port, prints the LAN URLs, and draws a scannable QR code right in your terminal.

Everything lives in memory and disappears when you stop the server. There is no database and nothing leaves your network.

## Features

- **One command.** `npx sync-splat` — no install, no config.
- **Phone-friendly.** A QR code in the terminal opens the app on any device on the network.
- **Rich text.** Paste formatted text; it is sanitized and broadcast to everyone instantly.
- **Files.** Drag‑and‑drop, pick, or paste files. Images preview inline; everything else downloads.
- **Live sync.** History is shared over WebSockets — new items appear everywhere at once.
- **Zero runtime dependencies to speak of.** The server is `node:http` + [socket.io]; the QR encoder is hand‑rolled. No Express, no CORS shims.
- **Ephemeral & private.** In‑memory only, same‑origin only, MIT licensed.

## Quick start

```bash
npx sync-splat
```

Then open the printed **Local** URL on this machine, or the **Network** URL (or the QR code) on another device on the same network.

### Flags

| Flag | Default | Description |
| --- | --- | --- |
| `-p, --port <n>` | `3011` | Port to listen on. The `PORT` env var is also honoured; the flag wins. |
| `--max-file-size <MB>` | `20` | Maximum size of a single upload, in megabytes. |
| `-h, --help` | | Show usage. |

```bash
sync-splat --port 8080 --max-file-size 50
PORT=4000 sync-splat
```

### Phone access via QR

On startup the terminal prints a QR code for the first LAN URL. Scan it with your phone's camera to open the app — you're sharing in seconds. If the URL happens to be too long for the encoder, the QR is skipped and the plain URL is printed instead.

## Security model

**Read this before using it anywhere sensitive.** sync-splat is built for convenience on a network you already trust, not for the open internet.

- **No authentication. No encryption.** It serves over plain HTTP. Anyone who can reach the port — that is, anyone on the same LAN — can read the shared history *and* post to it.
- **Same-origin only.** The server serves the client and the socket from one origin and sets no CORS headers, so other websites can't script it — but that is not a substitute for auth.
- **Text is sanitized.** Shared HTML is sanitized (with DOMPurify) before it is rendered, to prevent stored‑XSS between clients.
- **Files are download-only.** Uploads are served with `X-Content-Type-Options: nosniff` and, for anything that isn't a common raster image, as `application/octet-stream` with a `Content-Disposition: attachment`. Only the image types in the allow‑list (PNG, JPEG, GIF, WebP, AVIF) are served inline for thumbnails. SVG is deliberately treated as a download because it can contain script.
- **Nothing is persisted.** History and file blobs live in memory and are gone when the process exits.

**Bottom line: use it on trusted networks only.** Don't expose the port to the internet or to networks with people you don't trust.

## Limits

Sensible caps keep memory bounded. Files and text share a single history list.

| Limit | Default |
| --- | --- |
| Max size of one text broadcast | 256 KB (UTF‑8) |
| Max size of one uploaded file | 20 MB (`--max-file-size`) |
| History items kept (text + files) | 20 |
| Total file bytes held in memory | 200 MB (oldest evicted first) |
| Per‑socket rate limit | 30 events / 10 s |

Oversize or malformed messages are silently dropped; the server never crashes on bad input.

## How it works

```
┌──────────────┐        HTTP + WebSocket (same origin, one port)
│  bin/         │  ┌────────────────────────────────────────────┐
│  sync-splat.js│─▶│  server/index.ts                           │
└──────────────┘  │   • node:http server                        │
                  │   • socket.io attached to it                │
                  │   • in-memory history + blob store          │
                  │   • static serving of the built React app   │
                  └────────────────────────────────────────────┘
                                     ▲
                                     │ built to dist/client
                             ┌───────┴────────┐
                             │  src/ (React)  │
                             └────────────────┘
```

- `pnpm build:client` builds the React app to `dist/client`.
- `pnpm build:server` bundles `server/index.ts` to `dist/server/index.js` with esbuild.
- `bin/sync-splat.js` resolves `../dist/server/index.js` and starts the server.

The QR encoder in [`qr/`](qr/README.md) is hand‑rolled and dependency‑free.

## Development

Requires Node ≥ 20 and [pnpm].

```bash
pnpm install      # install dependencies
pnpm dev          # server on :3011 + Vite dev server on :5173 (proxied)
pnpm test         # run the vitest suite (server + QR encoder)
pnpm build        # typecheck, build the client, bundle the server
pnpm lint         # eslint
```

In dev, the Vite server proxies `/socket.io` and `/api` to the standalone server on `:3011`, so the app behaves exactly as it does in production (same origin, no CORS).

## License

[MIT](LICENSE) © Joseph Maynard

[socket.io]: https://socket.io
[pnpm]: https://pnpm.io
