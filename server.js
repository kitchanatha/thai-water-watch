// Thai Water Map — tiny local server.
// Serves the map page and proxies live water-level data from ThaiWater (HII),
// because the ThaiWater API does not send CORS headers, so browsers can't call it directly.
// Run: node server.js   then open http://localhost:3000

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const SOURCE = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/waterlevel_load";
const CACHE_MS = 5 * 60 * 1000;

let cache = { at: 0, body: null };

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode !== 200) return reject(new Error("ThaiWater HTTP " + res.statusCode));
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch (e) { reject(e); }
        });
      })
      .on("timeout", function () { this.destroy(new Error("ThaiWater timed out")); })
      .on("error", reject);
  });
}

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

// Keep only what the map needs (the raw feed is ~1.4 MB).
function slim(raw) {
  const rows = (raw.waterlevel_data && raw.waterlevel_data.data) || [];
  const stations = [];
  for (const r of rows) {
    const s = r.station || {};
    if (s.tele_station_lat == null || s.tele_station_long == null) continue;
    const g = r.geocode || {};
    stations.push({
      id: s.id,
      name: s.tele_station_name || {},
      lat: s.tele_station_lat,
      lng: s.tele_station_long,
      time: r.waterlevel_datetime,
      msl: num(r.waterlevel_msl),
      prev: num(r.waterlevel_msl_previous),
      pct: num(r.storage_percent),
      level: r.situation_level ?? null,
      bank: num(s.min_bank),
      ground: num(s.ground_level),
      critical: num(s.critical_level_msl),
      province: g.province_name || {},
      provinceCode: g.province_code || "",
      amphoe: g.amphoe_name || {},
      basin: (r.basin && r.basin.basin_name) || {},
      agency: (r.agency && r.agency.agency_shortname && r.agency.agency_shortname.en) || "",
    });
  }
  const provinces = ((raw.province && raw.province.data) || [])
    .map((p) => ({ code: p.province_code, name: p.province_name }))
    .sort((a, b) => (a.name.en || "").localeCompare(b.name.en || ""));
  return { fetchedAt: new Date().toISOString(), stations, provinces };
}

async function getData() {
  if (cache.body && Date.now() - cache.at < CACHE_MS) return cache.body;
  const body = JSON.stringify(slim(await fetchJson(SOURCE)));
  cache = { at: Date.now(), body };
  return body;
}

// --- Flooded-road reports (Longdo Traffic / iTIC open event feed, nationwide) ---
// Sources inside the feed: Department of Highways (DOH), iTIC staff relaying BMA Drainage Dept
// reports, and drivers using the iTIC / Longdo Traffic apps.
const ROAD_SOURCE = "https://event.longdo.com/feed/json";
let roadCache = { at: 0, body: null };

// "2026-09-26 13:49:10" is Bangkok local time
const bkkTime = (v) => (v ? new Date(v.replace(" ", "T") + "+07:00").toISOString() : null);

const RE_CM = /(\d{1,3})(?:\s*(?:-|–|~|ถึง)\s*(\d{1,3}))?\s*(?:ซ\.?\s?ม\.?|ซม|เซน(?:ติเมตร)?|cm)/gi;
const RE_CLOSED = /ผ่านไม่ได้|ไม่สามารถผ่าน|ไม่สามารถสัญจร|สัญจรไม่ได้|ปิดการจราจร|ปิดถนน|impassable|not passable|road closed/i;
const RE_RECEDED = /น้ำลด(ลง)?แล้ว|ระบายแล้ว|ระบายเสร็จ|แห้งแล้ว|กลับสู่ภาวะปกติ|สัญจรได้ตามปกติ|ผ่านได้ตามปกติ|receded/i;

// Pull the deepest "xx cm" / "xx-yy ซ.ม." figure out of free text.
function parseDepth(text) {
  let max = null, m;
  RE_CM.lastIndex = 0;
  while ((m = RE_CM.exec(text))) {
    const v = Math.max(Number(m[1]), m[2] ? Number(m[2]) : 0);
    if (v > 0 && v < 300) max = Math.max(max || 0, v);
  }
  return max;
}

function sourceOf(c) {
  if (/^DOH/i.test(c)) return "doh";
  if (/^itic\.[a-z]/i.test(c)) return "itic"; // iTIC staff, usually citing BMA
  return "user";
}

function slimRoad(raw) {
  const now = Date.now();
  const reports = (Array.isArray(raw) ? raw : [])
    .filter((e) => e.type === "6" || e.icon === "flood")
    .map((e) => {
      const text = `${e.title || ""} ${e.description || ""}`;
      // DOH puts the official status in the title, e.g. "(ผ่านได้)" / "(ผ่านไม่ได้)"; it wins over the description
      const titleSaysOpen = /\(\s*ผ่านได้\s*\)/.test(e.title || "");
      const titleSaysClosed = /\(\s*ผ่านไม่ได้\s*\)/.test(e.title || "");
      const closed = titleSaysClosed || (!titleSaysOpen && RE_CLOSED.test(text));
      return {
        id: e.eid,
        title: { th: (e.title || "").replace(/^น้ำท่วม\s*/, ""), en: (e.title_en || e.title || "").replace(/^(Flood (at )?|น้ำท่วม\s*)/i, "") },
        desc: { th: (e.description || "").trim(), en: (e.description_en || e.description || "").trim() },
        lat: Number(e.latitude),
        lng: Number(e.longitude),
        start: bkkTime(e.start),
        stop: bkkTime(e.stop),
        source: sourceOf(e.contributor || ""),
        depth: parseDepth(text),
        closed,
        passable: !closed && (titleSaysOpen || /ผ่านได้|passable/i.test(text)),
        receded: RE_RECEDED.test(text),
        image: (e.images && e.images[0]) || null,
      };
    })
    .filter((r) => isFinite(r.lat) && isFinite(r.lng) && (!r.stop || Date.parse(r.stop) > now))
    // DOH files reports with no real location at its headquarters (Ratchathewi); showing them there would mislead
    .filter((r) => !(r.source === "doh" && Math.abs(r.lat - DOH_HQ.lat) < 0.0005 && Math.abs(r.lng - DOH_HQ.lng) < 0.0005));
  // Updates are re-posted as new events at the same spot with the same title: keep only the newest
  const newest = new Map();
  for (const r of reports) {
    const key = `${r.title.th}|${r.lat.toFixed(4)},${r.lng.toFixed(4)}`;
    const prev = newest.get(key);
    if (!prev || Date.parse(r.start) > Date.parse(prev.start)) newest.set(key, r);
  }
  return { fetchedAt: new Date().toISOString(), reports: [...newest.values()] };
}
const DOH_HQ = { lat: 13.76402, lng: 100.53828 };

async function getRoadData() {
  if (roadCache.body && Date.now() - roadCache.at < CACHE_MS) return roadCache.body;
  const body = JSON.stringify(slimRoad(await fetchJson(ROAD_SOURCE)));
  roadCache = { at: Date.now(), body };
  return body;
}

// --- Live traffic cameras (iTIC Foundation / Department of Highways, via Longdo's public camera feed) ---
// Each camera has an HLS stream the browser plays directly (the stream servers allow cross-site playback).
const CAMERA_SOURCE = "https://camera.longdo.com/feed/?command=json";
let camCache = { at: 0, body: null };
async function getCameras() {
  if (camCache.body && Date.now() - camCache.at < 10 * 60 * 1000) return camCache.body;
  const raw = await fetchJson(CAMERA_SOURCE);
  const cams = (Array.isArray(raw) ? raw : [])
    .filter((c) => c.hls_url && /^https:\/\//.test(c.hls_url) && !/X\.X\.X\.X/.test(c.hls_url))
    .map((c) => ({
      id: String(c.camid),
      title: String(c.title || "").trim(),
      lat: Number(c.latitude), lng: Number(c.longitude),
      org: c.organization === "กรมทางหลวง" ? "doh" : "itic",
      hls: c.hls_url,
    }))
    .filter((c) => isFinite(c.lat) && isFinite(c.lng) && c.lat > 5 && c.lat < 21 && c.lng > 97 && c.lng < 106);
  const body = JSON.stringify({ fetchedAt: new Date().toISOString(), cameras: cams });
  camCache = { at: Date.now(), body };
  return body;
}

const reports = require("./reports");

function readBody(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

// Render sits behind a proxy; the first X-Forwarded-For entry is the visitor
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function handleReports(req, res, pathname) {
  try {
    if (pathname === "/api/reports" && req.method === "GET") return sendJson(res, 200, { reports: await reports.list() });
    if (pathname === "/api/reports" && req.method === "POST") {
      const out = await reports.create(await readBody(req), clientIp(req));
      return sendJson(res, out.status, out.body || { error: out.error });
    }
    const m = /^\/api\/reports\/([a-f0-9]{12})(\/vote)?$/.exec(pathname);
    if (m && req.method === "POST" && m[2]) {
      const out = await reports.vote(m[1], await readBody(req), clientIp(req));
      return sendJson(res, out.status, out.body || { error: out.error });
    }
    if (m && req.method === "DELETE" && !m[2]) {
      const out = await reports.remove(m[1], await readBody(req));
      return sendJson(res, out.status, out.body || { error: out.error });
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("Reports error:", e.message);
    sendJson(res, e.message === "too large" || e.message === "bad json" ? 400 : 500, { error: "Could not save your report. Please try again." });
  }
}

const routing = require("./routing");

// Simple per-IP limiter so one visitor can't use up the free OpenRouteService quota
const buckets = new Map();
function allowRate(key, limit, windowMs) {
  const now = Date.now();
  const list = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= limit) return false;
  list.push(now);
  buckets.set(key, list);
  return true;
}
setInterval(() => buckets.clear(), 60 * 60 * 1000).unref();

// BMA snapshot (sensor readings + district office reports) imported from a community page.
// It is a one-off snapshot, so it only counts while fresh (sensorTime + hideAfterHours).
let snapCache = null;
function snapshotFloods() {
  try {
    if (!snapCache) snapCache = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "bkk-snapshot.json"), "utf8"));
  } catch { return []; }
  const s = snapCache;
  if (Date.now() > Date.parse(s.sensorTime) + s.hideAfterHours * 3600e3) return [];
  // Flooded stretches are lines; sample a point every ~60 m so the router sees the whole stretch
  const sample = (line) => {
    const out = [];
    for (let i = 0; i < line.length; i++) {
      out.push(line[i]);
      if (i + 1 < line.length) {
        const [a, b] = [line[i], line[i + 1]];
        const m = Math.hypot((b[0] - a[0]) * 111320, (b[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180));
        for (let k = 1; k < Math.floor(m / 60); k++) { const t = k / Math.floor(m / 60); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
      }
    }
    return out;
  };
  const LV_CM = { H: 25, M: 15, L: 5 }; // district reports without a stated depth
  const out = [];
  // Sensor values mean "this deep or more", so BMA's deep level (R, over 15 cm) is treated as very deep (>20 cm)
  const sensorDepth = (r) => (r.level === "R" ? Math.max(r.maxCm, 25) : r.maxCm);
  s.roads.forEach((r, i) => r.lines.forEach((l) => sample(l).forEach(([lat, lng], j) =>
    out.push({ id: `s${i}-${j}-${out.length}`, lat, lng, depth: sensorDepth(r), closed: false, title: { th: `${r.name} (เซ็นเซอร์ กทม.)`, en: `${r.name} (BMA sensor)` } }))));
  s.reports.forEach((r, i) => {
    if (!r.geom) return;
    const depth = r.cm ?? LV_CM[r.level];
    const title = { th: `${r.name} (รายงานเขต${r.district})`, en: `${r.name} (${r.district} district report)` };
    const pts = r.kind === "point" ? [r.geom] : r.geom.flatMap(sample);
    pts.forEach(([lat, lng], j) => out.push({ id: `d${i}-${j}`, lat, lng, depth, closed: false, title }));
  });
  return out;
}

// Every flood we know of (agency feed + visitor reports + fresh BMA snapshot), with a severity category
async function allFloods() {
  const [official, community] = await Promise.all([
    getRoadData().then((b) => JSON.parse(b).reports).catch(() => []),
    reports.list().catch(() => []),
  ]);
  return [
    ...official.map((r) => ({ id: "o" + r.id, lat: r.lat, lng: r.lng, depth: r.depth, closed: r.closed, title: r.title })),
    ...community.map((r) => ({ id: "c" + r.id, lat: r.lat, lng: r.lng, depth: r.depth, closed: r.closed, title: { th: r.note || "รายงานจากผู้ใช้", en: r.note || "Visitor report" } })),
    ...snapshotFloods(),
  ].map((f) => ({ ...f, cat: routing.roadCat(f) }));
}

async function handleRouting(req, res, url) {
  const ip = clientIp(req);
  try {
    if (url.pathname === "/api/geocode" && req.method === "GET") {
      if (!allowRate("g" + ip, 120, 10 * 60 * 1000)) return sendJson(res, 429, { error: "Too many searches. Please wait a moment." });
      const out = await routing.geocode(url.searchParams.get("q"), { lat: url.searchParams.get("lat"), lng: url.searchParams.get("lng") });
      return sendJson(res, out.status, out.body || { error: out.error });
    }
    if (url.pathname === "/api/route" && req.method === "POST") {
      if (!allowRate("r" + ip, 20, 10 * 60 * 1000)) return sendJson(res, 429, { error: "Too many route requests. Please wait a few minutes." });
      const out = await routing.plan(await readBody(req), await allFloods());
      return sendJson(res, out.status, out.body || { error: out.error });
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("Routing error:", e.message);
    const status = e.status === 429 ? 429 : 502;
    const what = url.pathname === "/api/geocode" ? "Place search" : "Route planning";
    const msg = e.status === 429 ? `${what} is busy (daily limit reached). Please try again later.`
      : e.status === 401 || e.status === 403 ? `${what} is unavailable: the OpenRouteService key was rejected.`
      : /routable|could not find|no route/i.test(e.message) ? "No driving route found between these places."
      : `${what} failed: ${e.message}`;
    sendJson(res, status, { error: msg });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/route" || url.pathname === "/api/geocode") return handleRouting(req, res, url);
  if (url.pathname.startsWith("/api/reports")) return handleReports(req, res, url.pathname);
  if (url.pathname === "/api/waterlevel") {
    try {
      const body = await getData();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(body);
    } catch (e) {
      console.error("Fetch failed:", e.message);
      if (cache.body) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "X-Stale": "1" });
        return res.end(cache.body);
      }
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Could not reach ThaiWater: " + e.message }));
    }
    return;
  }
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(`ok (reports: ${await reports.check()}; routing: ${routing.enabled() ? "on" : "off, no ORS_API_KEY"})`);
  }
  if (url.pathname === "/api/cameras") {
    try {
      const body = await getCameras();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(body);
    } catch (e) {
      console.error("Camera feed failed:", e.message);
      if (camCache.body) { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); return res.end(camCache.body); }
      return sendJson(res, 502, { error: "Could not load the camera list: " + e.message });
    }
  }
  if (url.pathname === "/api/roadflood") {
    try {
      const body = await getRoadData();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(body);
    } catch (e) {
      console.error("Road flood fetch failed:", e.message);
      if (roadCache.body) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "X-Stale": "1" });
        return res.end(roadCache.body);
      }
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Could not reach Longdo Traffic: " + e.message }));
    }
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    // The Google Maps browser key is public by design (restrict it to this site in Google Cloud).
    const config = {
      googleKey: (process.env.GOOGLE_MAPS_API_KEY || "").trim().replace(/^(["'])(.*)\1$/, "$2") || null,
      routing: routing.enabled(),
    };
    const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8")
      .replace("{/*CONFIG*/}", JSON.stringify(config).replace(/</g, "\\u003c"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(html);
  }
  const STATIC = {
    "/map-adapter.js": "text/javascript", "/bangkok-districts.json": "application/json",
    "/bkk-snapshot.json": "application/json", "/flood-prone.json": "application/json",
  };
  if (STATIC[url.pathname]) {
    res.writeHead(200, { "Content-Type": STATIC[url.pathname] + "; charset=utf-8", "Cache-Control": "no-cache" });
    return fs.createReadStream(path.join(__dirname, "public", url.pathname.slice(1))).pipe(res);
  }
  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => console.log(`Thai Water Map running at http://localhost:${PORT} (reports stored in: ${reports.storeKind()})`));
