const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS = 12;
const ROUND_SECONDS = 150;
const rooms = new Map();

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, service: "braains-reborn-server" }));
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Braains Reborn multiplayer server is running.");
});

const wss = new WebSocket.Server({ server });

function makeRoom(code) {
  return {
    code,
    players: new Map(),
    zombies: [],
    startedAt: Date.now(),
    nextZombieId: 1
  };
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function snapshot(room) {
  return {
    type: "state",
    room: room.code,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y,
      role: p.role, health: p.health
    })),
    zombies: room.zombies.map(z => ({ ...z })),
    remaining: Math.max(0, ROUND_SECONDS - Math.floor((Date.now() - room.startedAt) / 1000))
  };
}

function broadcast(room) {
  const data = JSON.stringify(snapshot(room));
  for (const player of room.players.values()) {
    if (player.ws.readyState === WebSocket.OPEN) player.ws.send(data);
  }
}

function removePlayer(ws) {
  const room = ws.room;
  if (!room) return;
  room.players.delete(ws.playerId);
  ws.room = null;
  if (room.players.size === 0) rooms.delete(room.code);
  else broadcast(room);
}

wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "join") {
      const code = String(msg.room || "LOBBY").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "LOBBY";
      let room = rooms.get(code);
      if (!room) {
        room = makeRoom(code);
        rooms.set(code, room);
      }
      if (room.players.size >= MAX_PLAYERS) {
        return send(ws, { type: "error", message: "Room is full." });
      }

      const id = Math.random().toString(36).slice(2, 10);
      const humans = [...room.players.values()].filter(p => p.role === "human").length;
      const role = room.players.size > 0 && humans === 0 ? "human" : "human";
      const player = {
        id, ws, name: String(msg.name || "Player").slice(0, 16),
        x: 100 + Math.random() * 500, y: 100 + Math.random() * 300,
        role, health: 100
      };
      ws.playerId = id;
      ws.room = room;
      room.players.set(id, player);

      // A small initial zombie population gives the round an infection threat.
      if (room.zombies.length === 0) {
        room.zombies.push({ id: "z" + room.nextZombieId++, x: 650, y: 350, health: 100 });
      }
      send(ws, { type: "joined", id, room: code, maxPlayers: MAX_PLAYERS });
      broadcast(room);
      return;
    }

    const room = ws.room;
    if (!room) return;
    const player = room.players.get(ws.playerId);
    if (!player) return;

    if (msg.type === "move") {
      const x = Number(msg.x), y = Number(msg.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        player.x = Math.max(12, Math.min(788, x));
        player.y = Math.max(12, Math.min(588, y));
      }
    }

    if (msg.type === "shoot") {
      // Simple server-checked nearby hit detection; no graphic effects.
      const target = room.zombies.find(z => Math.hypot(z.x - player.x, z.y - player.y) < 150);
      if (target) {
        target.health -= 35;
        if (target.health <= 0) room.zombies = room.zombies.filter(z => z.id !== target.id);
      }
    }
  });

  ws.on("close", () => removePlayer(ws));
  ws.on("error", () => removePlayer(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  for (const room of rooms.values()) {
    // Zombies slowly move toward the nearest human.
    for (const zombie of room.zombies) {
      const humans = [...room.players.values()].filter(p => p.role === "human");
      if (!humans.length) continue;
      humans.sort((a, b) => Math.hypot(a.x-zombie.x, a.y-zombie.y) - Math.hypot(b.x-zombie.x, b.y-zombie.y));
      const target = humans[0];
      const dx = target.x - zombie.x, dy = target.y - zombie.y;
      const distance = Math.hypot(dx, dy) || 1;
      zombie.x += dx / distance * 1.1;
      zombie.y += dy / distance * 1.1;
      if (distance < 18) {
        target.role = "zombie";
        target.health = 100;
      }
    }
    broadcast(room);
  }
}, 50);

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
process.on("SIGTERM", () => { clearInterval(heartbeat); server.close(); });
