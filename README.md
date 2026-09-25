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
- **Files.** Drag‑and‑drop, pick, or paste a screenshot — files stage as previews in the compose box and send when you broadcast. Images preview inline; everything else downloads.
- **Shared folder (opt-in).** Add `--share` and a **Files** tab lets any device browse, download, and upload straight to disk. Bare `--share` shares the directory you launched from; `--share <path>` shares somewhere else. Off unless you ask for it; dotfiles are never listed or served.
- **Optional passcode.** Start with `--pin` to require a short passcode on every read and write. It rides along in the QR/URL fragment, so a phone scan still just works, and non‑browser clients pass it with `--key`.
- **Screen sharing.** Share the server machine's screen from the browser and watch it on any device, phones included. Video goes peer to peer over WebRTC; the server only introduces the two ends. See [Screen sharing](#screen-sharing).
- **Who's here.** A device list in the header shows every connected browser and terminal, so you can see who can read (or watch) along.
- **Terminal client.** Talk to a running server without a browser: `sync-splat send`, `history`, and `get` push and pull text and files straight from the shell, and `sync-splat watch` streams new splats as they arrive.
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
| `--share [path]` | off | Enable the folder browser. Bare = current dir; a path shares that dir (must exist). |
| `--pin [value]` | off | Require a passcode. With no value one is generated; `--pin <value>` sets your own. Embedded in the printed URLs/QR. See [Passcode](#passcode). |
| `-h, --help` | | Show usage. |

```bash
sync-splat --port 8080 --max-file-size 50
sync-splat --share               # share the current directory
sync-splat --share ~/Downloads   # share a specific folder
sync-splat --pin                 # generate a passcode
sync-splat --pin hunter2         # set your own
PORT=4000 sync-splat
```

### Phone access via QR

On startup the terminal prints a QR code for the first LAN URL. Scan it with your phone's camera to open the app — you're sharing in seconds. If the URL happens to be too long for the encoder, the QR is skipped and the plain URL is printed instead.

The banner also prints a **Stable** URL of the form `http://<hostname>.local:<port>`. On networks with an mDNS responder (macOS/iOS and most modern systems) this name keeps working even when your machine's IP changes — handy after switching Wi‑Fi. In the app, the QR dialog has a small **Refresh** button that re-reads the current network addresses if you move networks while the server is running.

## Shared folder

sync-splat serves a folder over the network, a bit like `python -m http.server` — but with uploads too.

- **Off by default — opt in with `--share`.** Nothing on disk is exposed unless you ask. Bare `--share` shares the directory you launched from; the **Files** tab then appears in the app.
- **`--share <path>`** shares a specific folder instead. The path must be an existing directory.
- **Browse and download** any file in the tree. Non‑image files download as attachments; common raster images can preview inline.
- **Upload** new files into any folder from the app. Uploads **never overwrite**: if a name is taken, sync-splat inserts a space and appends `(1)`, `(2)`, … before the extension.
- **Dotfiles stay private.** Entries whose name starts with `.` — and any directory named that way — are never listed, downloaded, or written to, so `.env`, `.git`, and friends don't leak. Symlinks that lead outside the shared folder are not followed.

## Screen sharing

Open the app on the machine running sync-splat (the printed **Local** URL, `http://localhost:…`) and click the screen icon in the header. Pick a screen or window in the browser's picker, and every other device gets a banner offering **Watch**.

- **Only the server machine can share.** Browsers only allow screen capture on a secure context, and over plain HTTP the only secure origin is `localhost`. Other devices can watch but won't see a share button. (iOS can't share at all, in any browser.)
- **Viewing works everywhere**, including phones over `http://`. The viewer opens full-width with a fullscreen button.
- **Peer to peer, LAN only.** Video flows directly between the sharer's browser and each viewer's browser over WebRTC; the sync-splat server relays only the few small handshake messages and never sees a frame. No STUN or TURN servers are used, so both devices must be on the same network.
- **One share at a time, up to 8 viewers.** Each viewer costs the sharing machine an encode.
- **The sharer sees who's watching.** The "You're sharing" banner shows the viewer count; tap it for their device names. Without a passcode anyone on the network can watch, so use [`--pin`](#passcode) if that matters.
- **Stopping:** the banner's **Stop** button, the browser's own "Stop sharing" bar, or closing the tab all end the share for everyone.

## Passcode

By default sync-splat has no passcode — anyone who can reach the port can read and post. Start with `--pin` to require a short passcode instead.

```bash
sync-splat --pin            # generates a short passcode and prints it
sync-splat --pin hunter2    # use your own
```

- **It gates reads *and* writes.** With a passcode set, every API route and the real‑time socket require the key. The only exceptions are `GET /api/info` (which returns just the name, version, and "a passcode is required" flag until you authenticate) and the static app shell itself — the page has to load before it can prompt you for the passcode. All actual data sits behind the key.
- **The QR/URLs carry it for you.** The passcode is appended to the printed URLs and the terminal QR as a `#k=<passcode>` fragment, so scanning with your phone authenticates automatically. The fragment stays in the browser and is never sent to the server or written to its logs; the client stores it (and a matching cookie so image/download links work) and strips it from the address bar.
- **Non‑browser clients** pass it with `--key`/`$SYNC_SPLAT_KEY` (see below) or an `X-Splat-Key` header.
- **It is a real access gate, not encryption.** The comparison is constant‑time, but traffic is still plain HTTP. A passcode keeps out people who don't have it; it does **not** protect the contents in transit. The trusted‑network caveat below still applies — this is not TLS.

## Terminal client

The same `sync-splat` binary can act as a client to a server that's already running — handy for scripting or when you don't want a browser tab.

```bash
sync-splat send "quick note"                 # post text
echo "piped" | sync-splat send               # text from stdin
sync-splat send ./screenshot.png             # upload a file
sync-splat history                           # list recent items (indexed)
sync-splat get 2                             # print text, or stream a file…
sync-splat get 2 > out.png                   # …to a file
```

Leave `watch` running to follow along live:

```bash
sync-splat watch                             # print new text, list new files
sync-splat watch --copy                      # also put each new text on your clipboard
sync-splat watch --files ~/Downloads/splats  # save every new file into a folder
sync-splat watch --json                      # one JSON event per line, for scripts
```

`watch` prints only what arrives after it starts (use `history` for the backlog) and reconnects on its own if the server restarts. Text goes to stdout with terminal control characters stripped; status messages go to stderr. `--files` never overwrites: a name that is taken gets ` (1)`, ` (2)`, … like shared‑folder uploads. `--copy` uses `pbcopy`, `clip`, `wl-copy`, `xclip` or `xsel`, whichever fits the platform. Each watcher shows up in the device list as "Terminal · &lt;hostname&gt;"; rename it with `--name`.

Point it at a non‑default server and pass a passcode as needed:

```bash
sync-splat history --url http://192.168.1.23:3011 --key hunter2
export SYNC_SPLAT_URL=http://192.168.1.23:3011
export SYNC_SPLAT_KEY=hunter2
sync-splat send "no more flags"
```

`--url` (default `http://localhost:3011`) and `--key` also read from `$SYNC_SPLAT_URL` and `$SYNC_SPLAT_KEY`; a URL containing a `#k=`/`?k=` passcode is accepted too, and the CLI strips the key out of the URL before sending it — it only ever travels in the `X-Splat-Key` header. Run `sync-splat send --help` for the full client reference.

> **Passcode in browser links.** The web app authenticates fetches and the socket with a header, but plain `<a href>` download links and `<img>` preview URLs can't set headers, so the browser appends the passcode as a `?k=<passcode>` query param (a `splat-key` cookie is set too as a backstop). That means the passcode can appear in browser history and in any server/proxy access logs that record query strings. On a trusted LAN with no proxy in between this is a non-issue; if it matters to you, treat the passcode as low-secrecy and rotate it by restarting with a new `--pin`.

## Security model

**Read this before using it anywhere sensitive.** sync-splat is built for convenience on a network you already trust, not for the open internet.

- **Optional passcode, no encryption.** By default there is no authentication: anyone who can reach the port — that is, anyone on the same LAN — can read the shared history *and* post to it. Starting with [`--pin`](#passcode) adds a real access gate: every read and write then needs the passcode (checked in constant time). Either way it always serves over plain **HTTP** — a passcode controls *who* gets in but does not encrypt what flows over the wire. It is not a substitute for TLS.
- **Same-origin enforced.** The server serves the client and the socket from one origin and sets no CORS headers. On top of that it validates the `Origin` header on uploads and on every socket handshake against the machine's own addresses (localhost + its interface IPs — not the spoofable `Host` header, so DNS rebinding doesn't bypass it). A hostile web page you happen to visit can't write to your history or read it over a WebSocket. Requests without an `Origin` — curl and other non-browser clients — are allowed. None of this is a substitute for auth.
- **Text is sanitized.** Shared HTML is sanitized (with DOMPurify) before it is rendered, to prevent stored‑XSS between clients.
- **Files are download-only.** Uploads are served with `X-Content-Type-Options: nosniff` and, for anything that isn't a common raster image, as `application/octet-stream` with a `Content-Disposition: attachment`. Only the image types in the allow‑list (PNG, JPEG, GIF, WebP, AVIF) are served inline for thumbnails. SVG is deliberately treated as a download because it can contain script.
- **The shared folder is read/write over the network — but only when you pass `--share`.** It's off by default. Once enabled, anyone who can reach the port can list and download its files and upload new ones straight to disk. Path traversal is blocked (all three share routes go through one validator that rejects `..`, absolute paths, backslashes, and NUL) and dotfiles/dot‑dirs (`.env`, `.git`, …) are never listed, served, or written, but everything else in that tree is exposed. Uploads never overwrite existing files, and the same `Origin` allow‑list that guards clipboard uploads guards share uploads. Point it somewhere deliberate with `--share <path>`.
- **Screen sharing is visible to everyone who can reach the port.** Without a passcode, any device on the network can join a share; the sharer sees each viewer's name in the banner. Video is sent peer to peer with WebRTC's built‑in DTLS‑SRTP encryption, but the handshake that sets it up travels over the same plain‑HTTP socket as everything else, so it is not protected against someone actively tampering with your network. The server relays handshake messages only between the sharer and its joined viewers, and stamps the sender itself so one client can't impersonate another.
- **Device names are self‑reported.** The device list shows what each browser or terminal says it is (cleaned of control and invisible characters). Treat it as a convenience, not an identity check.
- **Nothing from the clipboard is persisted.** Shared text and staged file blobs live in memory and are gone when the process exits. (Files you upload to the shared folder are, of course, written to disk on purpose.)

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
| Per‑socket screen‑share signaling rate limit | 300 events / 10 s |
| Screen‑share viewers | 8 |
| Concurrent `watch` streams | 16 |

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
