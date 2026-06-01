const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const queue = [];
const peers = new Map();
const profiles = new Map();

const bansFile = path.join(__dirname, "bans.json");
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;

function loadBans() {
  try {
    if (!fs.existsSync(bansFile)) return {};
    return JSON.parse(fs.readFileSync(bansFile, "utf8"));
  } catch {
    return {};
  }
}

function saveBans(bans) {
  fs.writeFileSync(bansFile, JSON.stringify(bans, null, 2));
}

function getIp(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  const raw = forwarded ? forwarded.split(",")[0].trim() : socket.handshake.address;
  return String(raw || "unknown").replace("::ffff:", "");
}

function isBanned(ip) {
  const bans = loadBans();
  const ban = bans[ip];

  if (!ban) return false;

  if (Date.now() > ban.expiresAt) {
    delete bans[ip];
    saveBans(bans);
    return false;
  }

  return ban;
}

function banIp(ip, reason) {
  const bans = loadBans();

  bans[ip] = {
    reason,
    createdAt: Date.now(),
    expiresAt: Date.now() + ONE_WEEK
  };

  saveBans(bans);
}

function clean(value, fallback, max = 40) {
  return String(value || fallback).slice(0, max);
}

function removeFromQueue(id) {
  const index = queue.indexOf(id);
  if (index !== -1) queue.splice(index, 1);
}

function saveProfile(socket, profile) {
  profiles.set(socket.id, {
    wantsGender: clean(profile?.wantsGender, "Any", 10),
    country: clean(profile?.country, "Any", 30),
    ip: getIp(socket)
  });
}

function countryWorks(a, b) {
  return a.country === "Any" || b.country === "Any" || a.country === b.country;
}

function matchFilterWorks(a, b) {
  if (a.wantsGender === "Any" && b.wantsGender === "Any") return true;
  if (a.wantsGender === "Any" || b.wantsGender === "Any") return true;
  return a.wantsGender !== b.wantsGender;
}

function compatible(aId, bId) {
  const a = profiles.get(aId);
  const b = profiles.get(bId);

  if (!a || !b) return false;

  return countryWorks(a, b) && matchFilterWorks(a, b);
}

function endPair(id) {
  removeFromQueue(id);

  const partnerId = peers.get(id);
  if (!partnerId) return;

  peers.delete(id);
  peers.delete(partnerId);

  const partnerSocket = io.sockets.sockets.get(partnerId);
  if (partnerSocket) partnerSocket.emit("partner-left");
}

function banSocket(socket, reason) {
  const ip = getIp(socket);

  banIp(ip, reason);
  endPair(socket.id);
  removeFromQueue(socket.id);

  socket.emit("banned", {
    reason,
    expiresAt: Date.now() + ONE_WEEK
  });

  socket.disconnect(true);

  console.log("IP banned:", ip, reason);
}

function banPartnerOf(socket, reason) {
  const partnerId = peers.get(socket.id);
  if (!partnerId) return;

  const partnerSocket = io.sockets.sockets.get(partnerId);
  if (!partnerSocket) return;

  banSocket(partnerSocket, reason);

  socket.emit("partner-left");
}

function enqueue(socket) {
  if (!socket || peers.has(socket.id) || queue.includes(socket.id)) return;

  const ip = getIp(socket);
  const ban = isBanned(ip);

  if (ban) {
    socket.emit("banned", {
      reason: ban.reason,
      expiresAt: ban.expiresAt
    });
    socket.disconnect(true);
    return;
  }

  queue.push(socket.id);

  socket.emit("queued", {
    online: io.engine.clientsCount,
    waiting: queue.length
  });

  matchUsers();
}

function matchUsers() {
  for (let i = 0; i < queue.length; i++) {
    const aId = queue[i];

    for (let j = i + 1; j < queue.length; j++) {
      const bId = queue[j];

      if (!compatible(aId, bId)) continue;

      queue.splice(j, 1);
      queue.splice(i, 1);

      const a = io.sockets.sockets.get(aId);
      const b = io.sockets.sockets.get(bId);

      if (!a || !b) {
        if (a) enqueue(a);
        if (b) enqueue(b);
        return matchUsers();
      }

      peers.set(a.id, b.id);
      peers.set(b.id, a.id);

      a.emit("matched", {
        partnerId: b.id,
        initiator: true,
        partner: profiles.get(b.id)
      });

      b.emit("matched", {
        partnerId: a.id,
        initiator: false,
        partner: profiles.get(a.id)
      });

      return matchUsers();
    }
  }
}

io.on("connection", socket => {
  const ip = getIp(socket);
  const ban = isBanned(ip);

  if (ban) {
    socket.emit("banned", {
      reason: ban.reason,
      expiresAt: ban.expiresAt
    });

    socket.disconnect(true);
    return;
  }

  socket.on("join", profile => {
    saveProfile(socket, profile);
    endPair(socket.id);
    enqueue(socket);
  });

  socket.on("next", profile => {
    saveProfile(socket, profile);
    endPair(socket.id);
    enqueue(socket);
  });

  socket.on("stop", () => {
    removeFromQueue(socket.id);
    endPair(socket.id);
    socket.emit("stopped");
  });

  socket.on("safety-exposure-self", () => {
    banSocket(socket, "Private area exposure detected");
  });

  socket.on("safety-exposure-partner", () => {
    banPartnerOf(socket, "Private area exposure detected");
  });

  socket.on("signal", payload => {
    const partnerId = peers.get(socket.id);
    if (!partnerId || payload.to !== partnerId) return;

    io.to(partnerId).emit("signal", {
      from: socket.id,
      data: payload.data
    });
  });

  socket.on("chat-message", message => {
    const partnerId = peers.get(socket.id);
    if (!partnerId) return;

    io.to(partnerId).emit("chat-message", {
      from: socket.id,
      text: clean(message, "", 500)
    });
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    profiles.delete(socket.id);
    endPair(socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("VibeCam running on port " + PORT);
});
