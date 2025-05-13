# Sync Splat

**Sync Splat** is a simple Node.js application that syncs clipboard content across devices on your local network in real time. It preserves rich text formatting and maintains an optional history buffer, providing a quick fallback when native shared clipboards or corporate VPNs block direct copy-paste.

## Features

- Real-time clipboard sync (HTML & text) across multiple clients via WebSockets
- In-memory history (configurable length)
- Health-check endpoint (`/ping`)
- Automatic display of LAN IP addresses on startup
- Customizable port (via `PORT` env var)
- Zero persistence: all data is cleared when the app stops

## Prerequisites

- Node.js v14+ (tested on v16+)
- npm (bundled with Node.js)
- Devices connected to the same LAN (e.g., Wi-Fi or Ethernet subnet)

## Installation

1. **Clone or copy** this folder to your machine (e.g. `sync-splat/`).
2. In the project root, install dependencies:

   ```bash
   npm install
   ```

## Configuration

- **PORT**: Default is `3001`. To change, set the `PORT` environment variable:
  ```bash
  PORT=8080 npm start
  ```

## Usage

1. **Start the server**:
   ```bash
   npm start
   ```
   You’ll see output like:
   ```text
   Sync Splat server running on port 3001
   Accessible on:
     http://192.168.0.194:3001
     http://10.0.0.55:3001
   ```
2. **Open the URL** on any device/browser in your LAN.
3. **Copy & paste** into the editable area. Click **Broadcast** or select a history entry to sync across all connected clients.
4. **Health check**: Visit `/ping` to verify the server is reachable (returns `pong`).

## Folder Structure

```
sync-splat/
├── package.json       # metadata & dependencies
├── server.js          # Express + Socket.io server
└── public/
    └── index.html     # client UI (HTML, CSS, JS)
```

## Customization

- **History length**: In `server.js`, modify `MAX_HISTORY` to adjust how many entries are stored.
- **Styling**: Edit `public/index.html` CSS or replace with your own assets.
- **Authentication**: Add middleware in `server.js` if you need access control.

## Troubleshooting

- **Cannot access on work PC**: Ensure firewall/VPN isn’t blocking non-standard ports. Try `curl -I http://<IP>:<PORT>/ping` to test connectivity.
- **WebSocket failures**: Check browser DevTools network tab for errors under `/socket.io`.

## Contributing

Feel free to open issues or pull requests! Ideas:

- Persist history to a file or database
- Dockerfile for containerized deployment
- Mobile-friendly UI enhancements
- Secure transport (HTTPS)

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

