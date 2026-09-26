// Pull the embedded data out of the shared Bangkok flood page and write two files for Thai Water Watch:
//   bkk-snapshot.json  - sensor readings (19:40) + district office reports (17:43), 26 Sep 2569, time-stamped
//   flood-prone.json   - the road segments that have BMA flood sensors (permanent reference layer)
const fs = require("fs");
const SRC = process.argv[2]; // path to the saved HTML of the source page
const OUT = require("path").join(__dirname, "..", "public") + require("path").sep;
const s = fs.readFileSync(SRC, "utf8");

// Extract a `const NAME = <json-ish literal>` block by bracket matching, then parse it as data (no eval)
function grab(name) {
  const i = s.indexOf("const " + name + " =");
  if (i < 0) throw new Error("missing " + name);
  let j = s.indexOf("=", i) + 1;
  while (/\s/.test(s[j])) j++;
  const open = s[j], close = open === "[" ? "]" : "}";
  let d = 0, k = j, inStr = false;
  for (; k < s.length; k++) {
    const c = s[k];
    if (inStr) { if (c === "\\") k++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) d++;
    else if (c === close && --d === 0) break;
  }
  const txt = s.slice(j, k + 1)
    .replace(/(^|[\s,\[{])\/\/[^\n]*/g, "$1")   // line comments
    .replace(/,\s*([\]}])/g, "$1");              // trailing commas
  return JSON.parse(txt);
}

const ROADS = grab("ROADS"), GEO = grab("GEO"), REPORTS = grab("REPORTS");

// GEO entries are either one polyline or a list of polylines; normalise to a list of polylines [[lat,lng],...]
const lines = (g) => !g ? [] : Array.isArray(g[0][0]) ? g : [g];
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const clean = (ls) => ls.map((l) => l.map(([a, b]) => [r5(a), r5(b)])).filter((l) => l.length >= 1);

const credit = {
  th: "สรุปน้ำท่วมถนน กทม. (หน้าเว็บที่ผู้ใช้จัดทำ)",
  en: "Bangkok road-flood summary (community-made page)",
  url: "https://claude.ai/artifact/N6umcENfSgoY6GMkhVKwZs",
  sources: "BMA road flood sensors (via flood.larry-cctv.com), BMA district office reports (น้ำท่วมขัง_กทม_26ก.ย.69_1743.xlsx), road extents from Google Maps traffic, map data © OpenStreetMap contributors",
};

const roads = ROADS.map((r) => ({
  name: r.n, span: r.s || "", district: r.d, zone: r.z,
  level: r.l,                 // R: >15 cm, r: 10–15 cm, a: 5–10 cm
  maxCm: r.m,                 // sensor value, "this deep or more"
  points: r.k.map((k) => ({ code: k[0], spot: k[1], cm: k[2], level: k[3], extentM: k[5] || 0 })),
  lines: clean(lines(GEO[r.n])),
}));

const reports = (REPORTS.items || []).map((x) => ({
  district: x.d, level: x.lv,  // H heavy, M moderate, L light
  name: x.n, seg: x.seg || "", water: x.w || "", pending: !!x.u,
  // deepest figure in the free-text water depth, e.g. "30–50 ซม." -> 50
  cm: (() => { const m = [...String(x.w || "").matchAll(/(\d{1,3})/g)].map((a) => +a[1]).filter((v) => v > 0 && v < 300); return m.length ? Math.max(...m) : null; })(),
  kind: x.g ? x.k : "none",   // "none": reported by name only, no location to draw
  geom: !x.g ? null : x.k === "point" ? [r5(x.g[0]), r5(x.g[1])] : clean(lines(x.g)),
}));

const snapshot = {
  credit,
  sensorTime: "2026-09-26T19:40:00+07:00",
  reportTime: "2026-09-26T17:43:00+07:00",
  hideAfterHours: 12,
  roads, reports,
};
const prone = {
  credit,
  roads: roads.map((r) => ({ name: r.name, span: r.span, district: r.district, codes: r.points.map((p) => p.code), spots: r.points.map((p) => p.spot), lines: r.lines })),
};
fs.writeFileSync(OUT + "bkk-snapshot.json", JSON.stringify(snapshot));
fs.writeFileSync(OUT + "flood-prone.json", JSON.stringify(prone));
const noGeo = roads.filter((r) => !r.lines.length).map((r) => r.name);
console.log("roads", roads.length, "sensors", roads.reduce((a, r) => a + r.points.length, 0), "levels", JSON.stringify(roads.reduce((m, r) => (m[r.level] = (m[r.level] || 0) + 1, m), {})));
console.log("reports", reports.length, "kinds", JSON.stringify(reports.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {})), "levels", JSON.stringify(reports.reduce((m, r) => (m[r.level] = (m[r.level] || 0) + 1, m), {})), "pending", reports.filter((r) => r.pending).length);
console.log("roads without geometry:", noGeo.length ? noGeo.join(", ") : "none");
console.log("sizes", fs.statSync(OUT + "bkk-snapshot.json").size, fs.statSync(OUT + "flood-prone.json").size);
