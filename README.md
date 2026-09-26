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
