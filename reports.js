// Community flood reports: people tap the map and say how deep the water is.
// Storage: Upstash Redis (REST) when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set,
// otherwise a local JSON file (fine for local use; Render's free disk is wiped on restart).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TTL_MS = 6 * 60 * 60 * 1000; // a report shows for 6 hours
const MAX_NOTE = 200;
const KEY = "tww:reports";
// Rough box around Thailand
const BOUNDS = { minLat: 5.3, maxLat: 20.8, minLng: 97.2, maxLng: 105.9 };
// Depth choices the form offers (cm); "closed" means impassable
const DEPTHS = { 5: 5, 15: 15, 25: 25, 40: 40 };

const UP_URL = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const FILE = path.join(__dirname, "data", "reports.json");

// ---------- storage ----------
async function redis(cmd) {
  const r = await fetch(UP_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`Upstash HTTP ${r.status}: ${text.slice(0, 120)}`); }
  if (j.error) throw new Error(`Upstash HTTP ${r.status}: ${j.error}`);
  return j.result;
}

// Connection self-test for /healthz (never includes the token)
async function check() {
  if (!(UP_URL && UP_TOKEN)) return "file";
  try {
    await redis(["PING"]);
    await redis(["HLEN", KEY]);
    return "upstash, connection OK";
  } catch (e) {
    const hints = [];
    if (/^["']|["']$/.test(UP_URL) || /^["']|["']$/.test(UP_TOKEN)) hints.push("remove the quote marks around the values in Render");
    if (!/^https:\/\//.test(UP_URL.replace(/^["']/, ""))) hints.push("URL should start with https://");
    return `upstash, connection FAILED: ${e.message}${hints.length ? " | hint: " + hints.join("; ") : ""}`;
  }
}

const store = UP_URL && UP_TOKEN
  ? {
      kind: "upstash",
      async all() {
        const flat = (await redis(["HGETALL", KEY])) || [];
        const out = [];
        for (let i = 0; i < flat.length; i += 2) {
          try { out.push(JSON.parse(flat[i + 1])); } catch {}
        }
        return out;
      },
      put: (r) => redis(["HSET", KEY, r.id, JSON.stringify(r)]),
      del: (ids) => (ids.length ? redis(["HDEL", KEY, ...ids]) : null),
    }
  : {
      kind: "file",
      read() {
        try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; }
      },
      write(obj) {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(obj));
      },
      async all() { return Object.values(this.read()); },
      async put(r) { const o = this.read(); o[r.id] = r; this.write(o); },
      async del(ids) { const o = this.read(); ids.forEach((id) => delete o[id]); this.write(o); },
    };

// ---------- abuse limits (in memory, per IP) ----------
const hits = new Map(); // ip -> [timestamps]
function allow(ip, limit, windowMs) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (list.length >= limit) return false;
  list.push(now);
  hits.set(ip, list);
  return true;
}
const voted = new Set(); // `${ip}|${id}`
setInterval(() => { hits.clear(); voted.clear(); }, 6 * 60 * 60 * 1000).unref();

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// What the browser gets (never the owner token hash)
const publicView = (r) => ({
  id: r.id, lat: r.lat, lng: r.lng, depth: r.depth, closed: r.closed, note: r.note,
  start: new Date(r.createdAt).toISOString(), stop: new Date(r.expiresAt).toISOString(),
  still: r.still, cleared: r.cleared,
});

async function list() {
  const now = Date.now();
  const all = await store.all();
  const expired = all.filter((r) => r.expiresAt <= now).map((r) => r.id);
  if (expired.length) store.del(expired).catch(() => {});
  // Hide reports the crowd says have dried up
  return all
    .filter((r) => r.expiresAt > now && !(r.cleared >= 2 && r.cleared > r.still))
    .map(publicView);
}

async function create(body, ip) {
  if (!allow(ip, 5, 30 * 60 * 1000)) return { status: 429, error: "Too many reports. Please wait a while and try again." };
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!(lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lng >= BOUNDS.minLng && lng <= BOUNDS.maxLng))
    return { status: 400, error: "Location must be in Thailand." };
  const closed = body.depth === "closed";
  if (!closed && !DEPTHS[body.depth]) return { status: 400, error: "Choose how deep the water is." };
  const note = String(body.note || "").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE);
  const token = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  const r = {
    id: crypto.randomBytes(6).toString("hex"),
    lat: Math.round(lat * 1e5) / 1e5,
    lng: Math.round(lng * 1e5) / 1e5,
    depth: closed ? null : DEPTHS[body.depth],
    closed,
    note,
    createdAt: now,
    expiresAt: now + TTL_MS,
    still: 0,
    cleared: 0,
    owner: sha(token),
  };
  await store.put(r);
  return { status: 201, body: { report: publicView(r), token } };
}

async function find(id) {
  return (await store.all()).find((r) => r.id === id);
}

async function vote(id, body, ip) {
  const kind = body.vote === "still" ? "still" : body.vote === "cleared" ? "cleared" : null;
  if (!kind) return { status: 400, error: "Unknown vote." };
  if (voted.has(ip + "|" + id)) return { status: 409, error: "You already voted on this report." };
  const r = await find(id);
  if (!r || r.expiresAt <= Date.now()) return { status: 404, error: "Report not found or expired." };
  voted.add(ip + "|" + id);
  r[kind] += 1;
  // "Still flooded" votes keep the report alive for longer
  if (kind === "still") r.expiresAt = Math.max(r.expiresAt, Date.now() + TTL_MS);
  await store.put(r);
  return { status: 200, body: { report: publicView(r) } };
}

async function remove(id, body) {
  const r = await find(id);
  if (!r) return { status: 404, error: "Report not found." };
  if (!body.token || sha(String(body.token)) !== r.owner) return { status: 403, error: "Only the person who posted this report can delete it." };
  await store.del([id]);
  return { status: 200, body: { ok: true } };
}

module.exports = { list, create, vote, remove, check, storeKind: () => store.kind };
