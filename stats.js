// Privacy-friendly visitor statistics for Thai Water Watch.
// - No cookies and no IP addresses stored. A visitor is recognised within one day only, by hashing
//   (daily random salt + IP + browser string); the salt is regenerated each day and never saved,
//   so hashes can't be linked across days or back to a person.
// - Counts per Bangkok day: page views, unique visitors (HyperLogLog), device, language, referrer site,
//   and feature events (routes, reports, cameras, layers).
// - Stored in Upstash Redis when configured (same env as reports.js), otherwise in memory.

const crypto = require("crypto");

const envClean = (v) => (v || "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
const UP_URL = envClean(process.env.UPSTASH_REDIS_REST_URL);
const UP_TOKEN = envClean(process.env.UPSTASH_REDIS_REST_TOKEN);
const STATS_KEY = envClean(process.env.STATS_KEY);
const KEEP_DAYS = 120;

// Events the page may report (anything else is ignored)
const EVENTS = new Set([
  "route_planned", "report_sent", "cam_itic", "cam_bma", "cam_pty", "radar_play",
  "layer_rain", "layer_pty", "district_pick", "lang_en", "lang_th", "share_gmaps",
]);
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|uptime|curl|wget|python|node-fetch|headless|render\//i;

// ---------- storage ----------
async function redisPipeline(cmds) {
  const r = await fetch(UP_URL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: `Bearer ${UP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("Upstash: " + (j.error || r.status));
  return j.map((x) => x.result);
}
const mem = { counters: new Map(), sets: new Map(), hashes: new Map() };
const useRedis = !!(UP_URL && UP_TOKEN);

const day = (d = new Date()) => new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 10); // Bangkok date
const K = (d, what) => `tww:stats:${d}:${what}`;

let salt = { day: "", value: "" };
function visitorHash(ip, ua) {
  const d = day();
  if (salt.day !== d) salt = { day: d, value: crypto.randomBytes(16).toString("hex") };
  return crypto.createHash("sha256").update(`${salt.value}|${ip}|${ua}`).digest("hex").slice(0, 20);
}

async function write(d, ops) {
  // ops: [["incr", what], ["hincr", what, field], ["pfadd", what, member]]
  if (useRedis) {
    const ttl = KEEP_DAYS * 86400;
    const cmds = [];
    for (const [op, what, a] of ops) {
      const key = K(d, what);
      if (op === "incr") cmds.push(["INCR", key]);
      if (op === "hincr") cmds.push(["HINCRBY", key, a, 1]);
      if (op === "pfadd") cmds.push(["PFADD", key, a]);
      cmds.push(["EXPIRE", key, ttl]);
    }
    await redisPipeline(cmds);
    return;
  }
  for (const [op, what, a] of ops) {
    const key = K(d, what);
    if (op === "incr") mem.counters.set(key, (mem.counters.get(key) || 0) + 1);
    if (op === "hincr") { const h = mem.hashes.get(key) || {}; h[a] = (h[a] || 0) + 1; mem.hashes.set(key, h); }
    if (op === "pfadd") { const s = mem.sets.get(key) || new Set(); s.add(a); mem.sets.set(key, s); }
  }
}

function refSite(referer, host) {
  try {
    const h = new URL(referer).hostname.replace(/^www\.|^m\.|^l\.|^lm\./, "");
    if (!h || h === host) return null;
    if (/facebook|fb\.com|messenger/.test(h)) return "facebook";
    if (/line\.me|line-apps|naver\.jp/.test(h)) return "line";
    if (/google\./.test(h)) return "google";
    if (/t\.co$|twitter|x\.com/.test(h)) return "x";
    if (/tiktok/.test(h)) return "tiktok";
    if (/claude\.ai/.test(h)) return "claude.ai";
    return h.slice(0, 40);
  } catch { return null; }
}

// Called for each page load of "/"
function trackPage(req, ip) {
  const ua = String(req.headers["user-agent"] || "");
  if (!ua || BOT_RE.test(ua)) return;
  const d = day();
  const mobile = /mobi|android|iphone|ipad/i.test(ua);
  const lang = /^th\b|,\s*th\b/i.test(String(req.headers["accept-language"] || "")) ? "th" : "other";
  const ops = [
    ["incr", "pv"],
    ["pfadd", "uv", visitorHash(ip, ua)],
    ["hincr", "device", mobile ? "mobile" : "desktop"],
    ["hincr", "browser_lang", lang],
  ];
  const ref = refSite(req.headers.referer || "", String(req.headers.host || "").split(":")[0]);
  ops.push(["hincr", "ref", ref || "direct / other"]);
  write(d, ops).catch((e) => console.warn("stats write failed:", e.message));
}

// Feature events from the page (sendBeacon) or the server itself
function trackEvent(name, ua = "") {
  if (!EVENTS.has(name) || BOT_RE.test(ua)) return false;
  write(day(), [["hincr", "events", name]]).catch((e) => console.warn("stats write failed:", e.message));
  return true;
}

function statsAuth(key) {
  if (!STATS_KEY || typeof key !== "string" || key.length !== STATS_KEY.length) return false;
  return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(STATS_KEY));
}

// Summary for the last n days (newest first)
async function summary(n = 30) {
  n = Math.max(1, Math.min(KEEP_DAYS, n | 0));
  const days = [];
  for (let i = 0; i < n; i++) days.push(day(new Date(Date.now() - i * 86400e3)));
  let rows;
  if (useRedis) {
    const cmds = [];
    for (const d of days) {
      cmds.push(["GET", K(d, "pv")], ["PFCOUNT", K(d, "uv")], ["HGETALL", K(d, "device")], ["HGETALL", K(d, "browser_lang")], ["HGETALL", K(d, "ref")], ["HGETALL", K(d, "events")]);
    }
    // all unique visitors across the period (union of the daily HyperLogLogs)
    cmds.push(["PFCOUNT", ...days.map((d) => K(d, "uv"))]);
    const res = await redisPipeline(cmds);
    const obj = (flat) => { const o = {}; for (let i = 0; i < (flat || []).length; i += 2) o[flat[i]] = +flat[i + 1]; return o; };
    rows = days.map((d, i) => {
      const r = res.slice(i * 6, i * 6 + 6);
      return { day: d, pageviews: +r[0] || 0, visitors: +r[1] || 0, device: obj(r[2]), lang: obj(r[3]), ref: obj(r[4]), events: obj(r[5]) };
    });
    return { days: rows, periodVisitors: +res[res.length - 1] || 0, storage: "upstash" };
  }
  const union = new Set();
  rows = days.map((d) => {
    (mem.sets.get(K(d, "uv")) || new Set()).forEach((v) => union.add(v));
    return {
      day: d, pageviews: mem.counters.get(K(d, "pv")) || 0, visitors: (mem.sets.get(K(d, "uv")) || new Set()).size,
      device: mem.hashes.get(K(d, "device")) || {}, lang: mem.hashes.get(K(d, "browser_lang")) || {},
      ref: mem.hashes.get(K(d, "ref")) || {}, events: mem.hashes.get(K(d, "events")) || {},
    };
  });
  return { days: rows, periodVisitors: union.size, storage: "memory (resets on restart)" };
}

module.exports = { trackPage, trackEvent, statsAuth, summary, enabled: () => !!STATS_KEY };
