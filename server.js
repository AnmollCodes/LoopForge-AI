require("dotenv").config(); // loads .env if present; harmless no-op if it doesn't exist

const express = require("express");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const helmet = require("helmet");
const { runLoopOnce, loadMemory, loadConfig } = require("./loop/agent");
const { extractProfileFromResume } = require("./loop/profileBuilderAgent");
const { extractTextFromFile } = require("./loop/resumeFileParser");

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const MATCHES_PATH = path.join(__dirname, "data", "matches.json");
const CONFIG_PATH = path.join(__dirname, "data", "config.json");

// Security headers — sets sane defaults (X-Content-Type-Options, disables
// X-Powered-By, restricts some cross-origin behavior). CSP is left in
// "report-only"-equivalent relaxed mode via a custom directive set below,
// since the dashboard loads Google Fonts and an iframe from a third-party
// domain (the Ask Lisa widget) — a strict default CSP would silently break
// both, which would be worse than not having a CSP at all.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      frameSrc: ["'self'", "https://app.trugen.ai"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
    },
  },
}));

// ---------------------------------------------------------------------------
// AUTH — off by default for local/dev use (no friction running on localhost),
// but if API_KEY is set in the environment, every /api/* route requires it.
// This is what makes it safe to expose beyond localhost — without this, any
// visitor who could reach the port could trigger scans or rewrite your config.
// ---------------------------------------------------------------------------
const API_KEY = process.env.API_KEY || null;

if (!API_KEY) {
  console.warn(
    "[Auth] WARNING: no API_KEY set. The API is unauthenticated. " +
    "This is fine for localhost-only use, but do NOT expose this port " +
    "to the public internet without setting API_KEY first."
  );
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAuth(req, res, next) {
  if (!API_KEY) return next(); // auth disabled — local/dev mode
  const provided = req.get("x-api-key");
  if (!provided || !timingSafeEqual(provided, API_KEY)) {
    return res.status(401).json({ ok: false, error: "Missing or invalid API key" });
  }
  next();
}

// ---------------------------------------------------------------------------
// RATE LIMITING — a basic in-memory sliding window per IP. Not a substitute
// for a real gateway/WAF at high scale, but it stops a naive flood of
// requests (accidental retry loops, a single abusive client) from hammering
// the free job APIs or pegging the CPU on scoring.
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30; // 30 requests/minute/IP for API routes
const requestLog = new Map(); // ip -> array of timestamps

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  if (timestamps.length > RATE_LIMIT_MAX) {
    return res.status(429).json({ ok: false, error: "Too many requests. Please slow down." });
  }
  next();
}

// Periodically clear stale IP entries so this map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of requestLog.entries()) {
    const fresh = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) requestLog.delete(ip);
    else requestLog.set(ip, fresh);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

app.use(express.json({ limit: "256kb" })); // cap body size against oversized payloads
app.use(express.static(path.join(__dirname, "public")));

// Health check — deliberately outside the /api prefix and the auth/rate-limit
// middleware below, since load balancers and uptime monitors (Render, Fly,
// UptimeRobot, etc.) need to reach this without an API key. It reveals
// nothing sensitive — just that the process is alive and can read its data dir.
app.get("/health", (req, res) => {
  const dataDirReadable = fs.existsSync(path.join(__dirname, "data"));
  res.status(dataDirReadable ? 200 : 503).json({
    ok: dataDirReadable,
    uptimeSeconds: Math.floor(process.uptime()),
    env: NODE_ENV,
  });
});

app.use("/api", rateLimit);
app.use("/api", requireAuth);

app.get("/api/matches", (req, res) => {
  if (!fs.existsSync(MATCHES_PATH)) return res.json([]);
  try {
    res.json(JSON.parse(fs.readFileSync(MATCHES_PATH, "utf-8")));
  } catch (err) {
    res.status(500).json({ ok: false, error: `data/matches.json is corrupted: ${err.message}` });
  }
});

app.get("/api/status", (req, res) => {
  res.json(loadMemory());
});

app.get("/api/config", (req, res) => {
  try {
    res.json(loadConfig());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/config", (req, res) => {
  const body = req.body || {};
  const errors = [];

  const isArrayOfStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

  if (body.mustHaveKeywords !== undefined && !isArrayOfStrings(body.mustHaveKeywords)) {
    errors.push("mustHaveKeywords must be an array of strings");
  }
  if (body.niceToHaveKeywords !== undefined && !isArrayOfStrings(body.niceToHaveKeywords)) {
    errors.push("niceToHaveKeywords must be an array of strings");
  }
  if (body.excludeKeywords !== undefined && !isArrayOfStrings(body.excludeKeywords)) {
    errors.push("excludeKeywords must be an array of strings");
  }
  if (body.greenhouseCompanies !== undefined && !isArrayOfStrings(body.greenhouseCompanies)) {
    errors.push("greenhouseCompanies must be an array of strings");
  }
  if (body.remoteOnly !== undefined && typeof body.remoteOnly !== "boolean") {
    errors.push("remoteOnly must be a boolean");
  }
  if (body.minScore !== undefined && typeof body.minScore !== "number") {
    errors.push("minScore must be a number");
  }

  if (errors.length > 0) {
    return res.status(400).json({ ok: false, errors });
  }

  // Merge onto the existing config rather than blind-overwrite, so a partial
  // update (e.g. just remoteOnly) can't wipe out the rest of the profile.
  let current;
  try {
    current = loadConfig();
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Existing config.json is invalid, refusing to merge: ${err.message}` });
  }
  const merged = { ...current, ...body };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  res.json({ ok: true, config: merged });
});

// Profile Builder Agent — paste a resume, get back extracted keywords.
// Does NOT save automatically; the person reviews and confirms first,
// same human-gatekeeper principle as everywhere else in this project.
app.post("/api/build-profile", (req, res) => {
  const { resumeText } = req.body || {};
  if (!resumeText || typeof resumeText !== "string" || resumeText.trim().length < 30) {
    return res.status(400).json({ ok: false, error: "Paste a longer resume/CV text (30+ characters)." });
  }
  if (resumeText.length > 50_000) {
    return res.status(400).json({ ok: false, error: "Resume text too long (50,000 char limit)." });
  }
  try {
    const result = extractProfileFromResume(resumeText);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// File upload variant of the Profile Builder Agent — accepts an actual
// resume file instead of pasted text. Memory storage only (no temp files
// written to disk for the upload itself — the PDF path writes its own
// short-lived temp file internally, cleaned up immediately after use).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB — generous for a text resume, not for arbitrary uploads
  fileFilter: (req, file, cb) => {
    const allowed = [".pdf", ".docx", ".txt"];
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (!allowed.includes(ext)) {
      return cb(new Error(`Unsupported file type "${ext}". Supported: .pdf, .docx, .txt`));
    }
    cb(null, true);
  },
});

app.post("/api/build-profile-file", (req, res) => {
  upload.single("resumeFile")(req, res, async (err) => {
    if (err) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ ok: false, error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded (expected field name 'resumeFile')." });
    }
    try {
      const text = await extractTextFromFile(req.file.buffer, req.file.originalname);
      const result = extractProfileFromResume(text);
      res.json({ ok: true, ...result, extractedTextLength: text.length });
    } catch (parseErr) {
      res.status(422).json({ ok: false, error: parseErr.message });
    }
  });
});

// Manual trigger — the "walk away and let it watch" button, but you can
// also just poke it whenever you want a fresh scan.
// BUGFIX: a lock prevents two overlapping runs from racing on the same
// memory.json/matches.json writes (e.g. double-tapping "Scan now", or a
// manual trigger landing mid-cron-run).
let scanInProgress = false;
app.post("/api/run-now", async (req, res) => {
  if (scanInProgress) {
    return res.status(409).json({ ok: false, error: "A scan is already running. Try again in a moment." });
  }
  scanInProgress = true;
  try {
    const matches = await runLoopOnce();
    res.json({ ok: true, newMatches: matches.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    scanInProgress = false;
  }
});

// Approve/dismiss a match — this is the human-gatekeeper action.
const VALID_STATUSES = new Set(["pending_review", "approved", "dismissed"]);
app.post("/api/matches/:id/status", (req, res) => {
  const { status } = req.body || {};
  if (!VALID_STATUSES.has(status)) {
    return res.status(400).json({ ok: false, error: `status must be one of: ${[...VALID_STATUSES].join(", ")}` });
  }
  if (!fs.existsSync(MATCHES_PATH)) {
    return res.status(404).json({ ok: false, error: "No matches exist yet — run a scan first." });
  }
  let matches;
  try {
    matches = JSON.parse(fs.readFileSync(MATCHES_PATH, "utf-8"));
  } catch (err) {
    return res.status(500).json({ ok: false, error: `data/matches.json is corrupted: ${err.message}` });
  }
  const idx = matches.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "No match with that id." });
  matches[idx].status = status;
  fs.writeFileSync(MATCHES_PATH, JSON.stringify(matches, null, 2));
  res.json({ ok: true });
});

// BUGFIX: without this, errors thrown by middleware BEFORE a route handler
// runs (oversized body, malformed JSON in the request) fall through to
// Express's default handler, which returns a raw HTML error page — breaking
// the promise that every /api/* response is JSON. This must be registered
// LAST, after all routes, per Express's error-middleware convention (4 args).
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ ok: false, error: "Request body too large (256kb limit)." });
  }
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json({ ok: false, error: "Request body is not valid JSON." });
  }
  console.error("[Server] Unhandled error:", err);
  res.status(500).json({ ok: false, error: "Internal server error." });
});

const server = app.listen(PORT, () => {
  console.log(`Dream Job Watcher running at http://localhost:${PORT} [env: ${NODE_ENV}]`);
});

// Graceful shutdown — matters in production: container platforms (Render,
// Fly, Docker, Kubernetes) send SIGTERM before killing a process on deploy
// or restart. Without this, an in-flight scan or file write could be cut off
// mid-write. This lets existing connections finish before exiting.
function shutdown(signal) {
  console.log(`[Server] ${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log("[Server] All connections closed. Exiting.");
    process.exit(0);
  });
  // Failsafe: if something hangs, don't let the process linger forever.
  setTimeout(() => {
    console.error("[Server] Forced exit after 10s timeout.");
    process.exit(1);
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Scheduled loop: runs every day at 8am server time.
// This is the actual "Loop Engineering" part — nobody has to type a prompt.
cron.schedule("0 8 * * *", () => {
  if (scanInProgress) {
    console.log("[Cron] Skipped — a scan is already in progress.");
    return;
  }
  scanInProgress = true;
  console.log("[Cron] Daily scheduled loop run firing...");
  runLoopOnce()
    .catch((err) => console.error("[Cron] run failed:", err))
    .finally(() => { scanInProgress = false; });
});
