const express = require("express");
const http = require("http");
const os = require("os");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// In-memory history (optional)
const history = [];
const MAX_HISTORY = 20;

app.use(express.static("public"));

io.on("connection", (socket) => {
  // Send existing history on connect
  socket.emit("history", history);

  // Listen for clipboard updates
  socket.on("update", (data) => {
    // Store HTML content
    history.unshift(data);
    if (history.length > MAX_HISTORY) history.pop();
    // Broadcast to all clients
    io.emit("update", data);
  });
});

// Use a less common port to avoid conflicts
const PORT = process.env.PORT || 3001;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Sync Splat server running on port ${PORT}`);

  // Display local network addresses
  const interfaces = os.networkInterfaces();
  console.log("Accessible on:");
  Object.values(interfaces).forEach((ifaceList) => {
    ifaceList.forEach((iface) => {
      if (iface.family === "IPv4" && !iface.internal) {
        console.log(`  http://${iface.address}:${PORT}`);
      }
    });
  });
});
