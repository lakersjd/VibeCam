const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const hpp = require("hpp");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);
app.disable("x-powered-by");

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (!allowedOrigins.length) return true;
  return allowedOrigins.includes(origin);
}

const io = new Server(server, {
  maxHttpBufferSize: 100000,
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error("Origin not allowed"));
    },
    methods: ["GET", "POST"]
  }
});

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "blob:"],
      "media-src": ["'self'", "blob:"],
      "connect-src": ["'self'", "ws:", "wss:"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use((req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), fullscreen=(self)"
  );
  next();
});

app.use(hpp());
app.use(express.json({ limit: "20kb" }));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 350,
  standardHeaders: true,
  legacyHeaders: false
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 80,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(globalLimiter);
app.use("/api", apiLimiter);
app.use("/admin", adminLimiter);
app.use("/api/admin", adminLimiter);

const queue = [];
const peers = new Map();
const profiles = new Map();
const socketBuckets = new Map();
const partnerSafetySignals = new Map();

const bansFile = path.join(__dirname, "bans.json");
const reportsFile = path.join(__dirname, "reports.json");

const FIVE_MINUTES = 5 * 60 * 1000;
const SIGNAL_WINDOW = 10 * 60 * 1000;
const BAN_SALT = process.env.BAN_SALT || "xlinkvc-local-safety-salt";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
    })
  : null;

const unsafePatterns = [
  "\u006e\u0069\u0067\u0067\u0065\u0072",
  "\u006e\u0069\u0067\u0067\u0061",
  "\u0063\u006f\u006f\u006e",
  "\u0063\u0068\u0069\u006e\u006b",
  "\u0073\u0070\u0069\u0063",
  "\u0077\u0065\u0074\u0062\u0061\u0063\u006b",
  "\u006b\u0069\u006b\u0065",
  "\u0072\u0061\u0067\u0068\u0065\u0061\u0064",
  "\u0073\u0061\u006e\u0064\u006e\u0069\u0067\u0067\u0065\u0072",
  "white power",
  "heil hitler",
  "go back to your country",
  "show you my dick",
  "show my dick",
  "show you my penis",
  "show my penis",
  "show you my pussy",
  "show my pussy",
  "show you my tits",
  "show my tits",
  "show you my titties",
  "show my titties",
  "show you my boobs",
  "show my boobs",
  "pop my titty",
  "pop a titty",
  "pop my tits",
  "pop your dick",
  "pull my dick out",
  "pull your dick out",
  "jerk off",
  "jacking off",
  "masturbate",
  "flash you",
  "send nudes",
  "show nudes",
  "show you nudes",
  "show my nude",
  "show you my id",
  "show my id",
  "show you my license",
  "show my license",
  "show you my passport",
  "show my passport"
];

async function initDatabase() {
  if (!pool) {
    console.log("DATABASE_URL not set. Using local JSON fallback.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS safety_bans (
      ip_hash TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS safety_reports (
      id SERIAL PRIMARY KEY,
      type TEXT,
      reason TEXT,
      reporter_socket_id TEXT,
      reported_socket_id TEXT,
      user_socket_id TEXT,
      reporter_ip_hash TEXT,
      reported_ip_hash TEXT,
      user_ip_hash TEXT,
      signal_count INTEGER,
      expires_at BIGINT,
      created_at BIGINT NOT NULL
    )
  `);

  console.log("Database ready.");
}

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

function safeCompare(a, b) {
  const one = Buffer.from(String(a || ""));
  const two = Buffer.from(String(b || ""));

  if (one.length !== two.length) return false;
  return crypto.timingSafeEqual(one, two);
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[@]/g, "a")
    .replace(/[!1|]/g, "i")
    .replace(/[$5]/g, "s")
    .replace(/[0]/g, "o")
    .replace(/[3]/g, "e")
    .replace(/\s+/g, " ")
    .trim();
}

function containsUnsafeLanguage(text) {
  const cleanText = normalizeText(text);
  const compact = cleanText.replace(/[^a-z0-9]/g, "");

  return unsafePatterns.some(pattern => {
    const cleanPattern = normalizeText(pattern);
    const compactPattern = cleanPattern.replace(/[^a-z0-9]/g, "");
    return cleanText.includes(cleanPattern) || compact.includes(compactPattern);
  });
}

function clean(value, fallback, max = 500) {
  return String(value || fallback).slice(0, max);
}

function socketLimit(socket, key, max, windowMs) {
  const now = Date.now();
  const bucketKey = socket.id + ":" + key;
  let bucket = socketBuckets.get(bucketKey);

  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0 };
  }

  bucket.count += 1;
  socketBuckets.set(bucketKey, bucket);

  if (bucket.count > max) {
    logReport({
      type: "socket_rate_limit",
      reason: key,
      socketId: socket.id,
      userIpHash: hashIp(getIp(socket))
    });

    socket.emit("rate-limited");
    return false;
  }

  return true;
}

async function getBanByIpHash(ipHash) {
  const now = Date.now();

  if (pool) {
    const result = await pool.query(
      "SELECT ip_hash, reason, created_at, expires_at FROM safety_bans WHERE ip_hash = $1",
      [ipHash]
    );

    const ban = result.rows[0];
    if (!ban) return null;

    if (now > Number(ban.expires_at)) {
      await pool.query("DELETE FROM safety_bans WHERE ip_hash = $1", [ipHash]);
      return null;
    }

    return {
      ipHash: ban.ip_hash,
      reason: ban.reason,
      createdAt: Number(ban.created_at),
      expiresAt: Number(ban.expires_at)
    };
  }

  const bans = readJson(bansFile, {});
  const ban = bans[ipHash];

  if (!ban) return null;

  if (now > ban.expiresAt) {
    delete bans[ipHash];
    writeJson(bansFile, bans);
    return null;
  }

  return ban;
}

async function isBanned(socket) {
  const ipHash = hashIp(getIp(socket));
  return await getBanByIpHash(ipHash);
}

async function createBan(socket, reason) {
  const ipHash = hashIp(getIp(socket));
  const ban = {
    reason,
    createdAt: Date.now(),
    expiresAt: Date.now() + FIVE_MINUTES
  };

  if (pool) {
    await pool.query(
      `
      INSERT INTO safety_bans (ip_hash, reason, created_at, expires_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (ip_hash)
      DO UPDATE SET reason = EXCLUDED.reason, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
      `,
      [ipHash, ban.reason, ban.createdAt, ban.expiresAt]
    );
  } else {
    const bans = readJson(bansFile, {});
    bans[ipHash] = ban;
    writeJson(bansFile, bans);
  }

  return ban;
}

async function logReport(data) {
  const report = {
    type: data.type || "report",
    reason: clean(data.reason, "", 500),
    reporterSocketId: data.reporterSocketId || null,
    reportedSocketId: data.reportedSocketId || null,
    userSocketId: data.userSocketId || null,
    reporterIpHash: data.reporterIpHash || null,
    reportedIpHash: data.reportedIpHash || null,
    userIpHash: data.userIpHash || null,
    signalCount: Number(data.signalCount || 0),
    expiresAt: data.expiresAt || null,
    createdAt: Date.now()
  };

  if (pool) {
    await pool.query(
      `
      INSERT INTO safety_reports
      (type, reason, reporter_socket_id, reported_socket_id, user_socket_id, reporter_ip_hash, reported_ip_hash, user_ip_hash, signal_count, expires_at, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,
      [
        report.type,
        report.reason,
        report.reporterSocketId,
        report.reportedSocketId,
        report.userSocketId,
        report.reporterIpHash,
        report.reportedIpHash,
        report.userIpHash,
        report.signalCount,
        report.expiresAt,
        report.createdAt
      ]
    );
  } else {
    const reports = readJson(reportsFile, []);
    reports.push(report);
    writeJson(reportsFile, reports.slice(-1000));
  }
}

async function getActiveBans() {
  const now = Date.now();

  if (pool) {
    await pool.query("DELETE FROM safety_bans WHERE expires_at < $1", [now]);

    const result = await pool.query(
      "SELECT ip_hash, reason, created_at, expires_at FROM safety_bans ORDER BY created_at DESC"
    );

    return result.rows.map(row => ({
      ipHash: row.ip_hash,
      reason: row.reason,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at)
    }));
  }

  const bans = readJson(bansFile, {});
  return Object.entries(bans)
    .filter(([_, ban]) => now < ban.expiresAt)
    .map(([ipHash, ban]) => ({ ipHash, ...ban }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function getReports() {
  if (pool) {
    const result = await pool.query(
      `
      SELECT * FROM safety_reports
      ORDER BY created_at DESC
      LIMIT 100
      `
    );

    return result.rows.map(row => ({
      type: row.type,
      reason: row.reason,
      reporterSocketId: row.reporter_socket_id,
      reportedSocketId: row.reported_socket_id,
      userSocketId: row.user_socket_id,
      reporterIpHash: row.reporter_ip_hash,
      reportedIpHash: row.reported_ip_hash,
      userIpHash: row.user_ip_hash,
      signalCount: row.signal_count,
      expiresAt: row.expires_at ? Number(row.expires_at) : null,
      createdAt: Number(row.created_at)
    }));
  }

  const reports = readJson(reportsFile, []);
  return reports.slice(-100).reverse();
}

async function removeBan(ipHash) {
  if (pool) {
    const result = await pool.query("DELETE FROM safety_bans WHERE ip_hash = $1", [ipHash]);
    return result.rowCount > 0;
  }

  const bans = readJson(bansFile, {});
  if (bans[ipHash]) {
    delete bans[ipHash];
    writeJson(bansFile, bans);
    return true;
  }

  return false;
}

async function clearReports() {
  if (pool) {
    await pool.query("DELETE FROM safety_reports");
    return;
  }

  writeJson(reportsFile, []);
}

function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send("ADMIN_PASSWORD is not set.");
  }

  const header = req.headers.authorization || "";

  if (!header.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Xlink.VC Admin"');
    return res.status(401).send("Admin login required.");
  }

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const index = decoded.indexOf(":");
  const user = decoded.slice(0, index);
  const pass = decoded.slice(index + 1);

  if (safeCompare(user, "admin") && safeCompare(pass, ADMIN_PASSWORD)) {
    return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Xlink.VC Admin"');
  return res.status(401).send("Wrong admin login.");
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

async function banSocket(socket, reason) {
  const ban = await createBan(socket, reason);

  await logReport({
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

async function recordPartnerSafetySignal(socket, reason) {
  const partnerId = peers.get(socket.id);
  if (!partnerId) return;

  const partnerSocket = io.sockets.sockets.get(partnerId);
  if (!partnerSocket) return;

  const reporterHash = hashIp(getIp(socket));
  const reportedHash = hashIp(getIp(partnerSocket));
  const now = Date.now();

  const oldSignals = partnerSafetySignals.get(reportedHash) || [];
  const freshSignals = oldSignals.filter(signal => now - signal.createdAt < SIGNAL_WINDOW);

  if (!freshSignals.some(signal => signal.reporterIpHash === reporterHash)) {
    freshSignals.push({
      reporterIpHash: reporterHash,
      createdAt: now,
      reason
    });
  }

  partnerSafetySignals.set(reportedHash, freshSignals);

  await logReport({
    type: "client_safety_signal",
    reason,
    reporterSocketId: socket.id,
    reporterIpHash: reporterHash,
    reportedSocketId: partnerSocket.id,
    reportedIpHash: reportedHash,
    signalCount: freshSignals.length
  });

  endPair(socket.id);
  await enqueue(socket);

  if (freshSignals.length >= 2) {
    await banSocket(partnerSocket, reason);
  }
}

async function enqueue(socket) {
  if (!socket || peers.has(socket.id) || queue.includes(socket.id)) return;

  const ban = await isBanned(socket);

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

  await matchUsers();
}

async function matchUsers() {
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
        if (a) await enqueue(a);
        if (b) await enqueue(b);
        return await matchUsers();
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

      return await matchUsers();
    }
  }
}

app.get("/healthz", (req, res) => {
  res.json({ ok: true, database: pool ? "postgres" : "json" });
});

app.get("/admin", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "admin.html"));
});

app.get("/api/admin/stats", adminAuth, async (req, res) => {
  const activeBans = await getActiveBans();
  const reports = await getReports();

  res.json({
    activeUsers: io.engine.clientsCount,
    waitingUsers: queue.length,
    matchedPairs: peers.size / 2,
    profiles: Array.from(profiles.values()),
    activeBans,
    reports
  });
});

app.post("/api/admin/unban", adminAuth, async (req, res) => {
  const ipHash = String(req.body?.ipHash || "");
  const ok = await removeBan(ipHash);

  if (ok) return res.json({ ok: true });

  res.status(404).json({ ok: false, error: "Ban not found" });
});

app.post("/api/admin/clear-reports", adminAuth, async (req, res) => {
  await clearReports();
  res.json({ ok: true });
});

app.use(express.static("public", {
  dotfiles: "deny",
  etag: true,
  maxAge: "1h",
  index: "index.html"
}));

io.on("connection", async socket => {
  const origin = socket.handshake.headers.origin;

  if (!isOriginAllowed(origin)) {
    socket.disconnect(true);
    return;
  }

  const ban = await isBanned(socket);

  if (ban) {
    socket.emit("banned", {
      reason: ban.reason,
      expiresAt: ban.expiresAt
    });

    socket.disconnect(true);
    return;
  }

  socket.on("join", async profile => {
    if (!socketLimit(socket, "join", 20, 60 * 1000)) return;

    saveProfile(socket, profile);
    endPair(socket.id);
    await enqueue(socket);
  });

  socket.on("next", async profile => {
    if (!socketLimit(socket, "next", 30, 60 * 1000)) return;

    saveProfile(socket, profile);
    endPair(socket.id);
    await enqueue(socket);
  });

  socket.on("stop", () => {
    if (!socketLimit(socket, "stop", 30, 60 * 1000)) return;

    removeFromQueue(socket.id);
    endPair(socket.id);
    socket.emit("stopped");
  });

  socket.on("report-partner", async reason => {
    if (!socketLimit(socket, "report", 8, 5 * 60 * 1000)) return;

    const partnerId = peers.get(socket.id);
    const partnerSocket = partnerId ? io.sockets.sockets.get(partnerId) : null;

    await logReport({
      type: "manual_report",
      reason: clean(reason, "No reason", 300),
      reporterSocketId: socket.id,
      reporterIpHash: hashIp(getIp(socket)),
      reportedSocketId: partnerSocket ? partnerSocket.id : null,
      reportedIpHash: partnerSocket ? hashIp(getIp(partnerSocket)) : null
    });

    endPair(socket.id);
    await enqueue(socket);
  });

  socket.on("safety-exposure-self", async () => {
    if (!socketLimit(socket, "safety-self", 5, 60 * 1000)) return;

    await banSocket(socket, "Possible private-area exposure detected");
  });

  socket.on("safety-exposure-partner", async () => {
    if (!socketLimit(socket, "safety-partner", 5, 60 * 1000)) return;

    await recordPartnerSafetySignal(socket, "Possible private-area exposure detected");
  });

  socket.on("safety-language-self", async () => {
    if (!socketLimit(socket, "safety-language-self", 5, 60 * 1000)) return;

    await banSocket(socket, "Unsafe racist or sexual-exposure language detected");
  });

  socket.on("safety-language-partner", async () => {
    if (!socketLimit(socket, "safety-language-partner", 5, 60 * 1000)) return;

    await recordPartnerSafetySignal(socket, "Unsafe racist or sexual-exposure language detected");
  });

  socket.on("media-status", status => {
    if (!socketLimit(socket, "media-status", 60, 60 * 1000)) return;

    const partnerId = peers.get(socket.id);
    if (!partnerId) return;

    io.to(partnerId).emit("partner-media-status", {
      micOn: !!status?.micOn,
      camOn: !!status?.camOn
    });
  });

  socket.on("signal", payload => {
    if (!socketLimit(socket, "signal", 180, 60 * 1000)) return;

    const partnerId = peers.get(socket.id);
    if (!partnerId || payload.to !== partnerId) return;

    io.to(partnerId).emit("signal", {
      from: socket.id,
      data: payload.data
    });
  });

  socket.on("chat-message", async message => {
    if (!socketLimit(socket, "chat", 40, 60 * 1000)) return;

    const text = clean(message, "", 500);

    if (containsUnsafeLanguage(text)) {
      await banSocket(socket, "Unsafe racist or sexual-exposure language detected");
      return;
    }

    const partnerId = peers.get(socket.id);
    if (!partnerId) return;

    io.to(partnerId).emit("chat-message", {
      from: socket.id,
      text
    });
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    profiles.delete(socket.id);
    endPair(socket.id);

    for (const key of socketBuckets.keys()) {
      if (key.startsWith(socket.id + ":")) {
        socketBuckets.delete(key);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log("Xlink.VC running on port " + PORT);
    });
  })
  .catch(error => {
    console.error("Database startup failed:", error);
    process.exit(1);
  });
