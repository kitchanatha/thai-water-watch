// Government data sources combined for Thai Water Watch:
//  - ThaiWater (HII) "thailand_main": 24-h rainfall from 7 agencies, major dams (RID/EGAT),
//    TMD weather radar images, HII rain-forecast maps
//  - Traffy Fondue (BMA citizen reports): flood-related complaints, last 6 hours
//  - BMA traffic cameras (bmatraffic.com): camera list + still images, fetched on demand
//  - Pattaya City cameras (livestream.pattaya.go.th): public camera list (video needs their own site)

const http = require("http");
const https = require("https");

const UA = "ThaiWaterWatch/1.0 (+https://thai-water-watch.onrender.com; flood travel map)";
const TW_MAIN = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/thailand_main";
const TW_IMAGE = "https://api-v3.thaiwater.net/api/v1/thaiwater30/shared/image?image=";
const TRAFFY = "https://publicapi.traffy.in.th/share/teamchadchart/search?limit=300";
const BMA = "http://www.bmatraffic.com";
const PATTAYA_MAP = "https://livestream.pattaya.go.th/kapi/live/map";

// Small HTTP(S) GET that returns { status, headers, body:Buffer }
function get(url, { headers = {}, timeout = 40000 } = {}) {
  const lib = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, { headers: { "User-Agent": UA, ...headers }, timeout }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out: " + url)));
    req.on("error", reject);
  });
}
async function getJson(url, opts) {
  const r = await get(url, opts);
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return JSON.parse(r.body.toString("utf8"));
}
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const bkkIso = (v) => (v ? new Date(v.replace(" ", "T") + "+07:00").toISOString() : null);

// ---------- ThaiWater: rain, dams, radar, forecast ----------
let twCache = { at: 0, body: null }, twBusy = null;
// The source is ~11 MB; after the first load, serve the last copy and refresh in the background
async function getThaiWater() {
  if (twCache.body && Date.now() - twCache.at < 10 * 60 * 1000) return twCache.body;
  if (!twBusy) twBusy = fetchThaiWater().finally(() => { twBusy = null; });
  if (twCache.body) { twBusy.catch((e) => console.warn("ThaiWater refresh failed:", e.message)); return twCache.body; }
  return twBusy;
}
async function fetchThaiWater() {
  const d = await getJson(TW_MAIN, { timeout: 90000 });
  const rain = ((d.rain && d.rain.data && d.rain.data.data) || [])
    .filter((r) => r.rain_24h > 0 && r.station && r.station.tele_station_lat)
    .map((r) => ({
      id: r.station.id,
      name: r.station.tele_station_name || {},
      lat: r.station.tele_station_lat, lng: r.station.tele_station_long,
      mm: num(r.rain_24h), mm1h: num(r.rain_1h),
      time: bkkIso(r.rainfall_datetime),
      agency: (r.agency && r.agency.agency_shortname) || {},
      province: (r.geocode && r.geocode.province_name) || {},
      amphoe: (r.geocode && r.geocode.amphoe_name) || {},
    }));
  const dams = ((d.dam && d.dam.data && d.dam.data.data) || []).filter((x) => x.dam && x.dam.dam_lat).map((x) => ({
    id: x.dam.id,
    name: x.dam.dam_name || {},
    lat: x.dam.dam_lat, lng: x.dam.dam_long,
    date: x.dam_date,
    pct: num(x.dam_storage_percent),          // storage as % of normal storage
    storage: num(x.dam_storage),             // million m³
    normal: num(x.dam.normal_storage), max: num(x.dam.max_storage),
    inflow: num(x.dam_inflow), released: num(x.dam_released), spilled: num(x.dam_spilled),
    usable: num(x.dam_uses_water_percent),
    agency: (x.agency && x.agency.agency_shortname) || {},
    province: (x.geocode && x.geocode.province_name) || {},
    basin: (x.basin && x.basin.basin_name) || {},
  }));
  const radar = ((d.radar && d.radar.data && d.radar.data.data) || []).filter((r) => r.media_path).map((r) => ({
    type: r.radar_type, name: r.radar_name,
    time: r.media_datetime ? new Date(r.media_datetime.replace(" ", "T") + (r.timezone === "UTC" ? "Z" : "+07:00")).toISOString() : null,
    img: TW_IMAGE + encodeURIComponent(r.media_path),
  }));
  const forecast = ((d.pre_rain && d.pre_rain.data && d.pre_rain.data.data) || []).filter((r) => r.media_path).map((r) => ({
    time: bkkIso(r.media_datetime), img: TW_IMAGE + encodeURIComponent(r.media_path),
  }));
  const body = JSON.stringify({ fetchedAt: new Date().toISOString(), rain, dams, radar, forecast });
  twCache = { at: Date.now(), body };
  return body;
}

// ---------- Traffy Fondue: flood complaints (accumulated, last 6 h) ----------
const TRAFFY_WINDOW_MS = 6 * 3600e3;
const RE_FLOOD = /น้ำท่วม|ท่วมขัง|น้ำขัง|รอระบาย|ระบายน้ำไม่|น้ำล้น|flood/i;
const traffy = new Map(); // ticket_id -> report
let traffyAt = 0, traffyBusy = null;
async function pollTraffy() {
  const j = await getJson(TRAFFY, { timeout: 90000 });
  for (const x of j.results || []) {
    if (!RE_FLOOD.test(x.description || "") || !Array.isArray(x.coords) || x.coords.length !== 2) continue;
    const time = Date.parse(String(x.timestamp).replace(" ", "T").replace(/\+00$/, "Z"));
    traffy.set(x.ticket_id, {
      id: x.ticket_id,
      lng: Number(x.coords[0]), lat: Number(x.coords[1]),
      text: String(x.description || "").replace(/\s+/g, " ").trim().slice(0, 280),
      address: String(x.address || "").slice(0, 120),
      photo: /^https:\/\/storage\.googleapis\.com\//.test(x.photo_url || "") ? x.photo_url : null,
      state: x.state || "",
      time: new Date(time).toISOString(),
    });
  }
  const cutoff = Date.now() - TRAFFY_WINDOW_MS;
  for (const [k, v] of traffy) if (Date.parse(v.time) < cutoff || /เสร็จสิ้น/.test(v.state)) traffy.delete(k);
  traffyAt = Date.now();
}
async function getTraffy() {
  if (Date.now() - traffyAt > 5 * 60 * 1000) {
    if (!traffyBusy) traffyBusy = pollTraffy().finally(() => { traffyBusy = null; });
    if (!traffy.size) await traffyBusy;      // first load waits; later loads serve what we have
  }
  return JSON.stringify({ fetchedAt: new Date(traffyAt || Date.now()).toISOString(), windowHours: 6, reports: [...traffy.values()] });
}

// ---------- BMA traffic cameras ----------
let bmaList = { at: 0, cams: [] };
let bmaCookie = "", bmaCookieAt = 0;
function cookieFrom(headers) {
  return (headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
}
async function bmaSession() {
  if (bmaCookie && Date.now() - bmaCookieAt < 10 * 60 * 1000) return bmaCookie;
  const r = await get(BMA + "/index.aspx", { timeout: 15000 });
  bmaCookie = cookieFrom(r.headers) || bmaCookie;
  bmaCookieAt = Date.now();
  // The home page also carries the camera list: ['id','name','name_en','where','from',lat,lng,'ip','icon']
  const html = r.body.toString("utf8");
  const re = /\[\s*'(\d+)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*(1[34]\.\d+)\s*,\s*(10[01]\.\d+)/g;
  const cams = new Map();
  let m;
  while ((m = re.exec(html))) {
    cams.set(m[1], { id: m[1], title: m[2].replace(/\s+/g, " ").trim(), dir: m[5] && m[5] !== "-" ? m[5] : (m[3] !== "-" ? m[3] : ""), lat: +m[6], lng: +m[7] });
  }
  if (cams.size) bmaList = { at: Date.now(), cams: [...cams.values()] };
  return bmaCookie;
}
// bmatraffic.com often doesn't answer requests from outside Thailand (where the site may be hosted),
// so fall back to a saved copy of the camera list and retry the live site hourly.
let bmaLiveTriedAt = 0, bmaLiveOk = false;
async function getBmaCameras() {
  const stale = !bmaList.cams.length || Date.now() - bmaList.at > 24 * 3600e3;
  if (stale && Date.now() - bmaLiveTriedAt > 3600e3) {
    bmaLiveTriedAt = Date.now();
    // Check the live site in the background; the saved list answers straight away meanwhile
    bmaCookieAt = 0;
    bmaSession().then(() => { bmaLiveOk = true; }, (e) => { bmaLiveOk = false; console.warn("bmatraffic.com unreachable:", e.message); });
  }
  if (!bmaList.cams.length) {
    const saved = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "public", "bma-cameras.json"), "utf8"));
    bmaList = { at: 0, cams: saved.cameras };
  }
  // live: whether this server can fetch BMA images; if not, the page links to BMA's own viewer
  return JSON.stringify({ cameras: bmaList.cams, live: bmaLiveOk });
}
// Images: one at a time (BMA's session tracks the camera being viewed), cached 30 s per camera
const bmaImg = new Map(); // id -> { at, buf }
let bmaQueue = Promise.resolve();
function getBmaImage(id) {
  const hit = bmaImg.get(id);
  if (hit && Date.now() - hit.at < 30000) return Promise.resolve(hit.buf);
  // Known unreachable from this server in the last hour: answer at once so the page can link to BMA instead
  if (bmaLiveTriedAt && !bmaLiveOk && Date.now() - bmaLiveTriedAt < 3600e3) return Promise.resolve(null);
  const job = bmaQueue.then(async () => {
    const again = bmaImg.get(id);
    if (again && Date.now() - again.at < 30000) return again.buf;
    for (let attempt = 0; attempt < 2; attempt++) {
      const cookie = await bmaSession();
      const h = { Cookie: cookie, Referer: `${BMA}/index.aspx` };
      await get(`${BMA}/PlayVideo.aspx?ID=${id}`, { headers: h, timeout: 20000 });
      const r = await get(`${BMA}/show.aspx?image=${id}&&time=${Date.now()}`, { headers: { ...h, Referer: `${BMA}/PlayVideo.aspx?ID=${id}` }, timeout: 20000 });
      const isJpeg = /image\/jpe?g/.test(r.headers["content-type"] || "");
      // A ~1.4 KB white JPEG means "no session / no picture"; refresh the session once and retry
      if (isJpeg && r.body.length > 3000) { bmaImg.set(id, { at: Date.now(), buf: r.body }); return r.body; }
      bmaCookieAt = 0;
      if (attempt === 1) return null;
    }
    return null;
  });
  bmaQueue = job.catch(() => {});
  return job;
}

// ---------- Pattaya City cameras ----------
let ptyCache = { at: 0, body: null };
async function getPattayaCameras() {
  if (ptyCache.body && Date.now() - ptyCache.at < 30 * 60 * 1000) return ptyCache.body;
  const j = await getJson(PATTAYA_MAP);
  const items = (j.details && (j.details.items || j.details)) || [];
  const cams = items.filter((c) => isFinite(c.lat) && isFinite(c.lng) && c.lat > 12 && c.lat < 14).map((c) => ({
    id: String(c.id), title: [c.name, c.location].filter(Boolean).join(" ").trim(), lat: +c.lat, lng: +c.lng,
    online: c.status !== false && c.monitorState !== "offline",
  }));
  const body = JSON.stringify({ cameras: cams });
  ptyCache = { at: Date.now(), body };
  return body;
}

module.exports = { getThaiWater, getTraffy, getBmaCameras, getBmaImage, getPattayaCameras };
