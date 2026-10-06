// BMA camera relay — run this on a computer in Thailand.
//
// bmatraffic.com only answers computers in Thailand, but the website is hosted abroad. This program
// keeps a connection open to the website, and whenever a visitor opens a BMA camera it fetches that
// picture from bmatraffic.com and uploads it to the website.
//
// Setup (once): put the same secret in relay.key (next to this file) and in Render as BMA_RELAY_KEY.
// Run:  node relay.js            (or double-click start-relay.cmd)
// Optional: SITE=https://... to point at another copy of the website.

const fs = require("fs");
const path = require("path");
const gov = require("./gov");

const SITE = (process.env.SITE || "https://thai-water-watch.onrender.com").replace(/\/$/, "");
const KEY = (process.env.BMA_RELAY_KEY || readKeyFile()).trim();
function readKeyFile() {
  try { return fs.readFileSync(path.join(__dirname, "relay.key"), "utf8"); } catch { return ""; }
}
if (!KEY) {
  console.error("No relay key. Put the secret in relay.key next to relay.js (same value as BMA_RELAY_KEY on Render).");
  process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString("en-GB");
let served = 0, connectedOnce = false;

async function handle(id) {
  let buf = null;
  try { buf = await gov.getBmaImage(id); } catch (e) { console.warn(stamp(), "BMA fetch failed for", id, e.message); }
  const r = await fetch(`${SITE}/api/relay/upload/${id}`, {
    method: "POST",
    headers: { "X-Relay-Key": KEY, "Content-Type": "image/jpeg" },
    body: buf || Buffer.alloc(0),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`upload HTTP ${r.status}`);
  served++;
  if (served % 20 === 1) console.log(stamp(), `served ${served} camera picture(s) so far`);
}

(async function main() {
  console.log(stamp(), "BMA relay starting for", SITE);
  for (;;) {
    try {
      const r = await fetch(`${SITE}/api/relay/poll`, { headers: { "X-Relay-Key": KEY }, signal: AbortSignal.timeout(40000) });
      if (r.status === 403) { console.error(stamp(), "The website rejected the relay key. Check relay.key matches BMA_RELAY_KEY on Render."); await wait(60000); continue; }
      if (!r.ok) throw new Error(`poll HTTP ${r.status}`);
      if (!connectedOnce) { connectedOnce = true; console.log(stamp(), "Connected. Leave this window open to show BMA camera pictures on the website."); }
      const { ids } = await r.json();
      // BMA's site serves one camera per session at a time, so handle requests in order
      for (const id of ids || []) await handle(id).catch((e) => console.warn(stamp(), "relay error for", id, e.message));
    } catch (e) {
      console.warn(stamp(), "connection problem:", e.message, "- retrying in 5 s");
      await wait(5000);
    }
  }
})();
