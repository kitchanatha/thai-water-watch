// Flood-avoiding directions via OpenRouteService (ORS).
// Strategy: get the normal route, find flood spots it passes, re-route with small "avoid" squares
// around exactly those spots, and repeat a few times. This keeps the avoid list short, well inside
// ORS limits (each avoid area max 200 km² / 20 km across), and relevant to the trip.

const envClean = (v) => (v || "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
const ORS_KEY = envClean(process.env.ORS_API_KEY);
const ORS = "https://api.openrouteservice.org";

const HIT_M = 45;          // a flood point this close to the route counts as "on the route"
const AVOID_M = 70;        // half-size of the square avoided around each flood point
const ENDPOINT_M = 250;    // floods this close to start/end can't be avoided, only warned about
const MAX_ROUNDS = 3;

// Which floods each vehicle should avoid (cat: 1 ≤10cm, 2 10–20, 3 20–30, 4 >30/closed, 5 depth unknown)
const AVOID_CATS = {
  motorbike: new Set([2, 3, 4, 5]),
  car: new Set([3, 4, 5]),
  suv: new Set([4]),
};

function roadCat(r) {
  if (r.closed) return 4;
  if (r.depth == null) return 5;
  return r.depth <= 10 ? 1 : r.depth <= 20 ? 2 : r.depth <= 30 ? 3 : 4;
}

// --- geometry in metres (equirectangular is plenty accurate at city scale) ---
const R = 6371000, rad = Math.PI / 180;
function toXY(lat, lng, lat0) { return [lng * rad * R * Math.cos(lat0 * rad), lat * rad * R]; }
function distToSegM(p, a, b, lat0) {
  const [px, py] = toXY(p[1], p[0], lat0), [ax, ay] = toXY(a[1], a[0], lat0), [bx, by] = toXY(b[1], b[0], lat0);
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}
function distM(a, b) { const lat0 = (a[1] + b[1]) / 2; const [x1, y1] = toXY(a[1], a[0], lat0), [x2, y2] = toXY(b[1], b[0], lat0); return Math.hypot(x2 - x1, y2 - y1); }

// Floods within HIT_M of the route line (coords are [lng,lat])
function floodsOnRoute(coords, floods) {
  let s = 90, w = 180, n = -90, e = -180;
  coords.forEach(([x, y]) => { s = Math.min(s, y); n = Math.max(n, y); w = Math.min(w, x); e = Math.max(e, x); });
  const pad = 0.001;
  const lat0 = (s + n) / 2;
  return floods.filter((f) => {
    if (f.lat < s - pad || f.lat > n + pad || f.lng < w - pad || f.lng > e + pad) return false;
    const p = [f.lng, f.lat];
    for (let i = 1; i < coords.length; i++) if (distToSegM(p, coords[i - 1], coords[i], lat0) <= HIT_M) return true;
    return false;
  });
}

function square(f) {
  const dLat = AVOID_M / 111320, dLng = AVOID_M / (111320 * Math.cos(f.lat * rad));
  const s = f.lat - dLat, n = f.lat + dLat, w = f.lng - dLng, e = f.lng + dLng;
  return [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
}

async function ors(path, opts = {}) {
  const r = await fetch(ORS + path, {
    ...opts,
    headers: { Authorization: ORS_KEY, "Content-Type": "application/json", Accept: "application/json, application/geo+json", ...(opts.headers || {}) },
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw Object.assign(new Error(`OpenRouteService HTTP ${r.status}`), { status: r.status }); }
  if (!r.ok || j.error) {
    const msg = (j.error && (j.error.message || j.error)) || `HTTP ${r.status}`;
    throw Object.assign(new Error(String(msg)), { status: r.status, code: j.error && j.error.code });
  }
  return j;
}

async function directions(from, to, avoid) {
  const body = { coordinates: [[from.lng, from.lat], [to.lng, to.lat]], instructions: false, preference: "recommended" };
  if (avoid.length) body.options = { avoid_polygons: { type: "MultiPolygon", coordinates: avoid.map(square) } };
  const j = await ors("/v2/directions/driving-car/geojson", { method: "POST", body: JSON.stringify(body) });
  const f = j.features && j.features[0];
  if (!f) throw new Error("No route found");
  return { coords: f.geometry.coordinates, distance: f.properties.summary.distance, duration: f.properties.summary.duration };
}

// Up to 3 points spread along the route so Google Maps follows the same roads
// (Google's phone app honours at most 3 waypoints in a link).
function googleLink(from, to, coords) {
  const pick = [0.25, 0.5, 0.75].map((q) => coords[Math.min(coords.length - 1, Math.round(q * (coords.length - 1)))]);
  const fmt = ([x, y]) => `${y.toFixed(6)},${x.toFixed(6)}`;
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api", "1");
  u.searchParams.set("origin", `${from.lat},${from.lng}`);
  u.searchParams.set("destination", `${to.lat},${to.lng}`);
  u.searchParams.set("waypoints", pick.map(fmt).join("|"));
  u.searchParams.set("travelmode", "driving");
  return u.toString();
}

const validPt = (p) => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng) && +p.lat > 5 && +p.lat < 21 && +p.lng > 97 && +p.lng < 106;

async function plan({ from, to, vehicle }, floods) {
  if (!ORS_KEY) return { status: 503, error: "Route planning is not set up yet (missing ORS_API_KEY)." };
  if (!validPt(from) || !validPt(to)) return { status: 400, error: "Start and destination must be in Thailand." };
  from = { lat: +from.lat, lng: +from.lng }; to = { lat: +to.lat, lng: +to.lng };
  if (distM([from.lng, from.lat], [to.lng, to.lat]) < 50) return { status: 400, error: "Start and destination are the same place." };
  const cats = AVOID_CATS[vehicle] || AVOID_CATS.car;

  const nearEnd = (f) => distM([f.lng, f.lat], [from.lng, from.lat]) < ENDPOINT_M || distM([f.lng, f.lat], [to.lng, to.lat]) < ENDPOINT_M;
  const avoidable = floods.filter((f) => cats.has(f.cat) && !nearEnd(f));

  let route = await directions(from, to, []);
  const plain = { distance: route.distance, duration: route.duration };
  const avoid = new Map();
  let note = null;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const hits = floodsOnRoute(route.coords, avoidable).filter((f) => !avoid.has(f.id));
    if (!hits.length) break;
    hits.forEach((f) => avoid.set(f.id, f));
    try {
      route = await directions(from, to, [...avoid.values()]);
    } catch (e) {
      // e.g. no way around, or avoid areas too spread out for ORS; keep the best route so far
      hits.forEach((f) => avoid.delete(f.id));
      note = "partial";
      break;
    }
  }

  // One warning per flooded road/report (line floods are sampled into many points)
  const seen = new Set();
  const stillOn = floodsOnRoute(route.coords, floods)
    .filter((f) => { const k = f.title && (f.title.th || f.title.en); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((f) => ({ id: f.id, lat: f.lat, lng: f.lng, cat: f.cat, depth: f.depth, title: f.title, mustPass: nearEnd(f) }));
  // Count avoided roads, not sampled points
  const avoidedCount = new Set([...avoid.values()].map((f) => (f.title && (f.title.th || f.title.en)) || f.id)).size;
  return {
    status: 200,
    body: {
      coords: route.coords.map(([x, y]) => [Math.round(y * 1e5) / 1e5, Math.round(x * 1e5) / 1e5]), // [lat,lng]
      distance: route.distance, duration: route.duration, plain,
      avoided: avoidedCount, stillOn, note,
      google: googleLink(from, to, route.coords),
    },
  };
}

async function geocode(text, focus) {
  if (!ORS_KEY) return { status: 503, error: "Place search is not set up yet (missing ORS_API_KEY)." };
  const q = String(text || "").trim().slice(0, 100);
  if (q.length < 2) return { status: 200, body: { places: [] } };
  const u = new URLSearchParams({ text: q, "boundary.country": "TH", size: "6", layers: "venue,address,street,neighbourhood,locality,borough,county" });
  if (focus && Number.isFinite(+focus.lat) && Number.isFinite(+focus.lng)) { u.set("focus.point.lat", focus.lat); u.set("focus.point.lon", focus.lng); }
  const j = await ors(`/geocode/autocomplete?${u}`, { method: "GET" });
  const places = (j.features || []).map((f) => ({ label: f.properties.label, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
  return { status: 200, body: { places } };
}

module.exports = { plan, geocode, roadCat, enabled: () => !!ORS_KEY };
