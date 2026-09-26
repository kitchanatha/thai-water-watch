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
