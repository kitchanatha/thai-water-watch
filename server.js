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
        closed: RE_CLOSED.test(text),
        passable: !RE_CLOSED.test(text) && /ผ่านได้|passable/i.test(text),
        receded: RE_RECEDED.test(text),
        image: (e.images && e.images[0]) || null,
      };
    })
    .filter((r) => isFinite(r.lat) && isFinite(r.lng) && (!r.stop || Date.parse(r.stop) > now));
  return { fetchedAt: new Date().toISOString(), reports };
}

async function getRoadData() {
  if (roadCache.body && Date.now() - roadCache.at < CACHE_MS) return roadCache.body;
  const body = JSON.stringify(slimRoad(await fetchJson(ROAD_SOURCE)));
  roadCache = { at: Date.now(), body };
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
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
    return res.end(`ok (reports: ${await reports.check()})`);
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
    const config = { googleKey: (process.env.GOOGLE_MAPS_API_KEY || "").trim().replace(/^(["'])(.*)\1$/, "$2") || null };
    const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8")
      .replace("{/*CONFIG*/}", JSON.stringify(config).replace(/</g, "\\u003c"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(html);
  }
  if (url.pathname === "/map-adapter.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
    return fs.createReadStream(path.join(__dirname, "public", "map-adapter.js")).pipe(res);
  }
  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => console.log(`Thai Water Map running at http://localhost:${PORT} (reports stored in: ${reports.storeKind()})`));
