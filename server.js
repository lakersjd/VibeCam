const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

const queue = [];
const peers = new Map();
const profiles = new Map();

const bansFile = path.join(__dirname, "bans.json");
const reportsFile = path.join(__dirname, "reports.json");

const FIVE_MINUTES = 5 * 60 * 1000;
const BAN_SALT = process.env.BAN_SALT || "xlinkvc-local-safety-salt";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-this-password";

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getIp(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  const raw = forwarded ? forwarded.split(",")[0].trim() : socket.handshake.address;
  return String(raw || "unknown").replace("::ffff:", "");
}

function hashIp(ip) {
  return crypto.createHash("sha256").update(ip + BAN_SALT).digest("hex");
}

function clean(value, fallback, max = 500) {
  return String(value || fallback).slice(0, max);
}

function adminAuth(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Xlink.VC Admin"');
    return res.status(401).send("Admin login required.");
  }

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const [user, pass] = decoded.split(":");

  if (user === "admin" && pass === ADMIN_PASSWORD) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Xlink.VC Admin"');
  return res.status(401).send("Wrong admin login.");
}

function isBanned(socket) {
  const ipHash = hashIp(getIp(socket));
  const bans = readJson(bansFile, {});
  const ban = bans[ipHash];

  if (!ban) return null;

  if (Date.now() > ban.expiresAt) {
    delete bans[ipHash];
    writeJson(bansFile, bans);
    return null;
  }

  return ban;
}

function createBan(socket, reason) {
  const ipHash = hashIp(getIp(socket));
  const bans = readJson(bansFile, {});

  bans[ipHash] = {
    reason,
    createdAt: Date.now(),
    expiresAt: Date.now() + FIVE_MINUTES
  };

  writeJson(bansFile, bans);
  return bans[ipHash];
}

function logReport(data) {
  const reports = readJson(reportsFile, []);

  reports.push({
    ...data,
    createdAt: Date.now()
  });

  writeJson(reportsFile, reports.slice(-1000));
}

function removeFromQueue(id) {
  const index = queue.indexOf(id);
  if (index !== -1) queue.splice(index, 1);
}

function saveProfile(socket, profile) {
  profiles.set(socket.id, {
    wantsGender: clean(profile?.wantsGender, "Any", 20),
    country: clean(profile?.country, "Any", 40),
    ipHash: hashIp(getIp(socket)),
    connectedAt: Date.now()
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
  const ban = createBan(socket, reason);

  logReport({
    type: "temporary_safety_ban",
    reason,
    userSocketId: socket.id,
    userIpHash: hashIp(getIp(socket)),
    expiresAt: ban.expiresAt
  });

  endPair(socket.id);
  removeFromQueue(socket.id);

  socket.emit("banned", {
    reason: ban.reason,
    expiresAt: ban.expiresAt
  });

  socket.disconnect(true);
}

function banPartnerOf(socket, reason) {
  const partnerId = peers.get(socket.id);
  if (!partnerId) return;

  const partnerSocket = io.sockets.sockets.get(partnerId);
  if (!partnerSocket) return;

  logReport({
    type: "partner_auto_safety_ban",
    reason,
    reporterSocketId: socket.id,
    reporterIpHash: hashIp(getIp(socket)),
    reportedSocketId: partnerSocket.id,
    reportedIpHash: hashIp(getIp(partnerSocket))
  });

  banSocket(partnerSocket, reason);
  socket.emit("partner-left");
}

function enqueue(socket) {
  if (!socket || peers.has(socket.id) || queue.includes(socket.id)) return;

  const ban = isBanned(socket);

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

/* Admin dashboard */
app.get("/admin", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "admin.html"));
});

app.get("/api/admin/stats", adminAuth, (req, res) => {
  const bans = readJson(bansFile, {});
  const reports = readJson(reportsFile, []);

  const activeBans = Object.entries(bans)
    .filter(([_, ban]) => Date.now() < ban.expiresAt)
    .map(([ipHash, ban]) => ({ ipHash, ...ban }))
    .sort((a, b) => b.createdAt - a.createdAt);

  res.json({
    activeUsers: io.engine.clientsCount,
    waitingUsers: queue.length,
    matchedPairs: peers.size / 2,
    profiles: Array.from(profiles.values()),
    activeBans,
    reports: reports.slice(-100).reverse()
  });
});

app.post("/api/admin/unban", adminAuth, (req, res) => {
  const ipHash = String(req.body?.ipHash || "");
  const bans = readJson(bansFile, {});

  if (bans[ipHash]) {
    delete bans[ipHash];
    writeJson(bansFile, bans);
    return res.json({ ok: true });
  }

  res.status(404).json({ ok: false, error: "Ban not found" });
});

app.post("/api/admin/clear-reports", adminAuth, (req, res) => {
  writeJson(reportsFile, []);
  res.json({ ok: true });
});

app.use(express.static("public"));

io.on("connection", socket => {
  const ban = isBanned(socket);

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

  socket.on("report-partner", reason => {
    const partnerId = peers.get(socket.id);
    const partnerSocket = partnerId ? io.sockets.sockets.get(partnerId) : null;

    logReport({
      type: "manual_report",
      reason: clean(reason, "No reason", 300),
      reporterSocketId: socket.id,
      reporterIpHash: hashIp(getIp(socket)),
      reportedSocketId: partnerSocket ? partnerSocket.id : null,
      reportedIpHash: partnerSocket ? hashIp(getIp(partnerSocket)) : null
    });

    endPair(socket.id);
    enqueue(socket);
  });

  socket.on("safety-exposure-self", () => {
    banSocket(socket, "Possible private-area exposure detected");
  });

  socket.on("safety-exposure-partner", () => {
    banPartnerOf(socket, "Possible private-area exposure detected");
  });

  socket.on("safety-language-self", () => {
    banSocket(socket, "Unsafe racist or sexual-exposure language detected");
  });

  socket.on("safety-language-partner", () => {
    banPartnerOf(socket, "Unsafe racist or sexual-exposure language detected");
  });

  socket.on("media-status", status => {
    const partnerId = peers.get(socket.id);
    if (!partnerId) return;

    io.to(partnerId).emit("partner-media-status", {
      micOn: !!status?.micOn,
      camOn: !!status?.camOn
    });
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
  console.log("Xlink.VC running on port " + PORT);
});
