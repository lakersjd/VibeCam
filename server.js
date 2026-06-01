const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const queue = [];
const peers = new Map();
const profiles = new Map();

function clean(value, fallback, max = 40) {
  return String(value || fallback).slice(0, max);
}

function removeFromQueue(id) {
  const index = queue.indexOf(id);
  if (index !== -1) queue.splice(index, 1);
}

function saveProfile(socket, profile) {
  profiles.set(socket.id, {
    gender: clean(profile?.gender, "Male", 10),
    wantsGender: clean(profile?.wantsGender, "Any", 10),
    country: clean(profile?.country, "Any", 30)
  });
}

function countryWorks(a, b) {
  return a.country === "Any" || b.country === "Any" || a.country === b.country;
}

function genderWorks(a, b) {
  return a.wantsGender === "Any" || a.wantsGender === b.gender;
}

function compatible(aId, bId) {
  const a = profiles.get(aId);
  const b = profiles.get(bId);

  if (!a || !b) return false;

  return countryWorks(a, b) && genderWorks(a, b) && genderWorks(b, a);
}

function enqueue(socket) {
  if (!socket || peers.has(socket.id) || queue.includes(socket.id)) return;

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

function endPair(id) {
  removeFromQueue(id);

  const partnerId = peers.get(id);
  if (!partnerId) return;

  peers.delete(id);
  peers.delete(partnerId);

  const partnerSocket = io.sockets.sockets.get(partnerId);
  if (partnerSocket) partnerSocket.emit("partner-left");
}

io.on("connection", socket => {
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
