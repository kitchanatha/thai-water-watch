# Thai Water Watch

Live map for planning travel around floods in Thailand:

- **Flooded roads**: live reports from the Longdo Traffic / iTIC event feed (Department of Highways,
  BMA Drainage Dept via iTIC, and driver reports), nationwide. Depth in cm is read from the report text when given.
- **Rivers & canals**: ~800 ThaiWater.net (HII) telemetry stations, % of riverbank capacity.

## Run

    node server.js

Then open http://localhost:3000. No npm install needed (Node standard library only).

## Road colours (rough guide for drivers, not official)

- Yellow: up to 10 cm, passable, drive slowly
- Orange: 10–20 cm, motorbikes avoid
- Red: 20–30 cm, small cars avoid
- Purple: over 30 cm or reported closed
- Slate "?": flooding reported, depth not given

## Community reports

Visitors can tap **+ รายงานน้ำท่วม** to report flooding: pick a spot, choose a depth, add a note.
Reports show for 6 hours; others can vote "still flooded" (extends it) or "water is gone"
(hidden after 2+ such votes outnumber "still"). The poster can delete their own report.
Limits: 5 reports per visitor per 30 minutes, locations inside Thailand only, notes up to 200 characters.

Storage: set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (free Upstash Redis database)
so reports survive restarts. Without them, reports are kept in `data/reports.json`, which Render's
free plan wipes whenever the service sleeps.

## Google Maps + live traffic (optional)

Set `GOOGLE_MAPS_API_KEY` (a browser key with the Maps JavaScript API enabled, restricted to your
site's address) and the site uses Google Maps with a live traffic layer. Visitors can switch between
Google Maps and OpenStreetMap in the side panel. If Google rejects the key or fails to load, the page
falls back to OpenStreetMap automatically.

## Flood-avoiding directions (optional)

Set `ORS_API_KEY` (free key from openrouteservice.org) to enable the route planner. The server asks
OpenRouteService for a driving route, finds flood reports within ~45 m of it, and re-routes with small
"avoid" squares around those spots (up to 3 rounds). What each vehicle avoids:
motorbike > 10 cm or unknown depth; car > 20 cm or unknown; pickup/SUV only > 30 cm or closed.
Floods within 250 m of the start or destination can't be avoided and are shown as warnings.
"Navigate in Google Maps" opens the route with 3 waypoints so Google follows the same roads.
Limits: 20 routes and 120 place searches per visitor per 10 minutes.

## BMA snapshot + flood-prone roads

`public/bkk-snapshot.json` holds a one-off import (26 Sep 2569: 56 BMA road-sensor readings at 19:40 and
135 district office reports at 17:43) from a community-made page
(https://claude.ai/artifact/N6umcENfSgoY6GMkhVKwZs). It is shown with its timestamp, used by the route
planner, and hides itself 12 hours after the sensor time. `public/flood-prone.json` keeps the 36 sensor
road segments as a permanent "flood-prone roads" layer. To refresh from a newer copy of that page, save
its HTML and run `node tools/convert-snapshot.js <saved.html>`, then update the times in the script.

## Live traffic cameras

`/api/cameras` relays Longdo's public camera list (https://camera.longdo.com/feed/?command=json):
iTIC Foundation and Department of Highways cameras with HLS streams, placeholder entries removed,
cached 10 minutes. Tapping a camera opens a live viewer (hls.js from jsDelivr, or native HLS on older
iPhones). Flood popups show "watch nearby camera" when one is within 1.5 km. Streams are about 3 Mbps,
so playback pauses after 90 seconds and when the tab is hidden. Video © iTIC Foundation / DOH.

## More government sources (gov.js)

- `/api/gov/thaiwater` — ThaiWater `thailand_main` (HII): 24-h rainfall from TMD, RID, DWR, EGAT, HII,
  Royal Forest Dept and DDPM gauges; 35 major dams (RID/EGAT); TMD radar images; HII rain forecast. Cached 10 min.
- `/api/gov/traffy` — Traffy Fondue (BMA) complaints matching flood keywords, accumulated over 6 hours.
- `/api/gov/bma-cameras`, `/api/gov/bma-cam/<id>.jpg` — BMA traffic cameras (bmatraffic.com): list from the
  public home page, still images fetched on demand one at a time, cached 30 s, identified as ThaiWaterWatch.
- `/api/gov/pattaya-cameras` — Pattaya City camera list. Video requires Pattaya's own site (it uses a bot
  check), so we link there instead of embedding.
- Not included: TMD warnings (need a registered TMD API key), BMA drainage sensors (block automated access),
  GISTDA flood maps (need an API key).

## Rain radar over the map

The browser loads RainViewer's public radar frames (https://api.rainviewer.com/public/weather-maps.json):
a composite of national weather radars, last 2 hours in 10-minute frames, with a play/pause slider.
Free tiles exist up to zoom 7; closer in, the zoom-7 tile is enlarged (map-adapter `tileOverlay`).

BMA cameras: `public/bma-cameras.json` is a saved copy of the camera list, used when bmatraffic.com
doesn't answer the server (it often drops requests from outside Thailand). In that case the viewer links
to the camera on BMA's own site instead of showing the picture.

## BMA camera relay (relay.js)

bmatraffic.com only answers computers in Thailand, while the site is hosted abroad. `relay.js` runs on a PC
in Thailand: it long-polls `/api/relay/poll` for camera ids visitors opened, fetches those pictures from
BMA and uploads them to `/api/relay/upload/<id>`. Both sides share a secret: `BMA_RELAY_KEY` on Render and
`relay.key` next to relay.js (git-ignored). Start it with `start-relay.cmd`. When the relay is off, the
viewer links to the camera on BMA's site. `/healthz` shows whether the relay is connected.

## Visitor statistics

`stats.js` counts page views, unique visitors per day, device, browser language, referrer site and feature
use, without cookies or stored IPs (a daily-rotating salted hash recognises a visitor within one day only).
Data goes to Upstash (`tww:stats:<date>:*`, kept 120 days). The private dashboard is `/stats.html`; it needs
`STATS_KEY` (set in Render). Bots, health checks and the relay are not counted.
