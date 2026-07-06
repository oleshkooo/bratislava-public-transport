# Bratislava Public Transport — Plan

A fast, clean web map of Bratislava city public transport (MHD). Personal-use tool,
not a demo — target the full feature set. Built as a **static site** (no backend for v1),
UI in **English**, transit data (stop/line names) stays **Slovak** as published.

---

## 1. Data sources (verified 2026-07-06 on live data)

Official GTFS feed from **Dopravný podnik Bratislava, a.s.**, published via IDS BK open data.

- **URL:** `https://www.arcgis.com/sharing/rest/content/items/aba12fd2cbac4843bc7406151bc66106/data`
- **Format:** GTFS static (zip, ~4.7 MB), refreshed regularly. Feed valid 2026-07-01 → 2026-12-31.
- **License:** CC-BY-4.0 → **attribution required** ("Dopravný podnik Bratislava / IDS BK").
- **Coverage:** city transport only (MHD). Regional buses (JDF/GTFS on Google Drive) and
  trains (S-lines) are separate feeds — deferred to a later phase.

### What's inside (measured)

| Item | Value |
|---|---|
| Lines total | **91** |
| — Trams (`route_type` 0) | 4 |
| — Trolleybuses (`route_type` 11) | 15 |
| — Buses (`route_type` 3) | 72 (incl. **20 night N-lines**) |
| Stops (all with coords) | **1 356** |
| Shape variants (geometries) | 371 — **sparse** (see below) |
| Trips | 36 196 |
| Stop-time rows | 689 343 (17 181 past midnight, max **29:04:45**) |
| Service patterns (calendar) | 8 (+ **519** `calendar_dates` exceptions) |

Key files: `routes.txt`, `trips.txt`, `shapes.txt` (route geometry), `stops.txt`,
`stop_times.txt` (**44 MB** — the reason we preprocess), `calendar.txt` + `calendar_dates.txt`.
`frequencies.txt`, `transfers.txt`, `pathways.txt`, `levels.txt` are present but **empty** — ignore.

Data-quality facts (verified on the live feed, 2026-07-06):

- **`route_color`/`route_text_color`: filled for all 91 routes** — official colors come free.
- **`direction_id`, `trip_headsign`, `shape_id`: filled for 100% of trips** — direction
  toggle and headsigns need no fallback logic.
- **`route_long_name` is NOT a display name.** It carries service notes
  (`"Výluka Centrum 2. etapa"`, `"platná aj 16.2.-19.4.2026…"`). Display
  `route_short_name` + terminal headsigns; surface long_name only as a
  "service note / diversion" badge.
- **All 1 356 stops are `location_type=0` with no `parent_station`** — grouping platforms
  by `stop_code`/name (as planned) is the only way to get physical stops.

### ⚠ `shapes.txt` is NOT street geometry

Measured: median **16** points per shape (min 2, max 39) — essentially stops joined by
straight segments. Drawn as-is, routes cut across buildings and the Danube.
**Requirement: precise street-following geometry** → the build step must enrich
geometry from an external source (see §2a). This is the main data-pipeline risk.

Checked alternatives:
- **City GIS layer** (`geoportal.bratislava.sk` → `doprava/Linky_MHD/MapServer/0`):
  street-following polylines, but **stale (~2021 network)** — missing 13 current lines,
  contains 76 defunct ones, one merged geometry per line (no directions). Unusable as a
  source; at best a cross-check.
- **OSM route relations** (verified via Overpass 2026-07-06): **chosen source.**
  `relation[route~"tram|trolleybus|bus"][network="MHD Bratislava"]` → **241 relations,
  100% PTv2** (separate relation per direction with `from`/`to`), covering **90 of 91**
  current lines (missing only school line `Šk`; extras `129`/`131` to ignore).
  License: **ODbL** → add "© OpenStreetMap contributors" attribution.

### No real-time (yet)

No public GTFS-RT / open live-position feed found. Live vehicle tracking is deferred
(see Phase 3). Architecture leaves room for a thin serverless proxy later.

---

## 2. Architecture

Fully static site + an offline **build step** that turns the 44 MB GTFS into small,
lazy-loadable JSON. The browser never touches raw GTFS.

```
[GTFS.zip @ ArcGIS]          [OSM route relations @ Overpass]
      │                             │
      └──────────┬──────────────────┘
                 │  scripts/build-data (Node/TS), run at deploy time + weekly via CI
                 ▼
  parse GTFS (proper CSV parser)
  + geometry enrichment (§2a: OSM relations → street-following polylines)
  → emit compact assets:
   • routes.json            index of 91 lines for the menu
   • stops.json             index of stops (id, name, code, lat, lon) for search + overview
   • all-routes.geojson     all geometries for the overview layer
   • routes/{id}.json       per line: directions, polylines, ordered stops, headsigns, timetable
   • stops/{id}.json        per stop: serving lines + departure board (service-day aware)
      ▼
[Static frontend]  MapLibre GL + OpenFreeMap tiles → Cloudflare Pages / Vercel (free)
```

Why per-file JSON: index files load upfront (small); a line's or stop's detail loads only
when opened. Keeps initial load light and the whole thing static/cacheable.
(If the trip planner later needs arbitrary queries, add a bundled SQLite via `sql.js`.)

### 2a. Geometry enrichment (precise street-following routes)

GTFS `shapes.txt` is stop-to-stop straight lines (§1), so the build step replaces it:

1. **Fetch** all `network="MHD Bratislava"` route relations from Overpass (one query,
   cached in the repo so CI doesn't depend on Overpass uptime).
2. **Assemble** each relation's member ways into a continuous polyline per direction
   (stitch ways end-to-end, flipping reversed ones).
3. **Match** OSM relation ↔ GTFS (route, `direction_id`) by `ref` = `route_short_name`
   plus terminus proximity (`from`/`to` vs. first/last stop of the modal trip).
4. **Fallbacks**, in order, for anything unmatched (line `Šk`, odd variants):
   snap the sparse GTFS shape onto the assembled OSM geometry of the same line;
   else map-match stop sequence via OSRM/Valhalla; else draw the raw shape and log
   a build warning. The pipeline must never fail the whole build over one line.
5. **Validate**: assembled length vs. GTFS shape length (±20%), every stop within
   ~50 m of the polyline. Violations → build warnings for manual review.

---

## 3. Tech stack

- **Frontend:** React + Vite + TypeScript + Shadcn UI.
- **Map:** MapLibre GL JS (WebGL, handles thousands of features). Tiles: **OpenFreeMap**
  (free vector tiles, no API key). Fallback: MapTiler free tier.
- **State:** lightweight (Zustand) + **URL as source of truth** (selected line/stop/view →
  shareable, bookmarkable links).
- **Build script:** Node + `csv-parse` + `adm-zip` (or `node-gtfs`); Overpass fetch +
  way-stitching for OSM geometries (§2a), response cached in-repo.
- **PWA:** `vite-plugin-pwa` — installable + offline (cache static data). Great at a stop on mobile.
- **Hosting / refresh:** Cloudflare Pages (or Vercel) + GitHub Action to re-fetch GTFS
  weekly and redeploy.

---

## 4. Feature set (full — this is a personal power-user tool)

**Map & overview**
- Full-screen map centered on Bratislava; all routes (faint) + all stops as toggleable layers.
- Stop clustering at low zoom; route drawn in its official line color.

**Line browser (core)**
- Menu grouped by type: Tram / Trolleybus / Bus, with **Night (N)** as a subgroup.
- Select a line → highlight full geometry, drop its stops, fit bounds.
- **Direction toggle** (there/back via `direction_id`) with terminal headsigns.
- Line panel: number, color, type, ordered stop list; click a stop → focus on map.

**Stops**
- Click any stop → panel: name, **which lines serve it**, next scheduled departures.
- Group platforms of the same physical stop (via `stop_code`/name) into one view.
- Full **departure board** per stop, service-day aware (weekday/weekend/holiday).

**Schedules (static timetables)**
- Per-line timetable per direction.
- Per-stop departures grid (line → times), from `stop_times` + `calendar`/`calendar_dates`.
- "Next departures now" — upcoming scheduled departures from current client time.

**Search**
- One box: find a line by number **or** a stop by name (fuzzy) → jump to it.

**Personalization**
- **Favorites** (lines + stops) in localStorage.
- **Near me** — geolocation → nearest stops + their upcoming departures.
- Recents / quick access.
- Shareable URL state.

**Quality of life**
- Mobile-first responsive (primary use is on the phone at a stop).
- Dark mode.
- PWA install + offline.
- Attribution footer (CC-BY-4.0).

---

## 5. Build milestones (order)

- **M0 — Scaffold:** Vite + React + TS; MapLibre map with OpenFreeMap tiles centered on BA.
- **M1 — Data pipeline:** `build-data` → `routes.json`, `stops.json`, `all-routes.geojson`;
  includes **geometry enrichment** (§2a) — precise polylines are a prerequisite for M2/M3,
  not a polish item.
- **M2 — Overview:** render all routes + all stops with layer toggles + clustering.
- **M3 — Line browser:** typed menu → select line → route highlight + direction toggle +
  stop list + fit bounds. *(the original core idea, done)*
- **M4 — Stop details:** click stop → serving lines + next scheduled departures.
- **M5 — Schedules:** full timetables per line and per stop, service-day aware.
- **M6 — Search:** lines + stops.
- **M7 — Personal:** favorites, near-me, URL state, dark mode.
- **M8 — PWA + polish + deploy:** offline, weekly data-refresh Action, attribution.
- **M9 — Trip planner:** A→B routing (RAPTOR/CSA over the schedule; likely `sql.js`/WASM).

**Later phases**
- **P1 — Real-time:** vehicle positions + live delays (needs a live source; thin proxy).
- **P2 — Coverage:** merge regional buses + trains (S-lines).

---

## 6. Technical notes & risks

- **44 MB `stop_times.txt`** → always preprocessed; never shipped raw. Per-stop/per-line JSON.
- **CSV quirks:** `route_long_name` contains commas (`"platná aj 16.2.-19.4.…"`) → use a real
  quoted-CSV parser, never `split(',')`. And remember it's a service note, not a name (§1).
- **Directions:** group trips by `direction_id`; pick the **modal (most frequent) shape** per
  direction as the representative — the *longest* trip may be a rare depot/diversion variant.
  Short-turn variants exist (371 shapes for ~182 line-directions).
- **Geometry matching (top risk):** OSM ↔ GTFS matching (§2a) can miss variants or drift after
  network changes; validation step + per-line fallbacks keep the build green. OSM edits lag
  official changes by days — acceptable for a personal tool.
- **After-midnight times:** 17 181 stop-time rows have times ≥ 24:00 (max 29:04:45) — night
  lines run on the *previous* service day. "Next departures now" must implement GTFS
  service-day semantics: at 01:30 the relevant departures are `25:30` of *yesterday's*
  service ID. All time math in **Europe/Bratislava** (DST-aware), never client-local or UTC.
- **Stops = platforms:** 1 356 points, all `location_type=0`, no parent stations (verified);
  group by `stop_code`/name for a clean physical-stop view.
- **Service days:** respect `calendar` + **519** `calendar_dates` exceptions for correct
  "today's" departures. Service-day resolution happens **client-side** (data is built weekly,
  so "today" can't be baked in at build time).
- **Data freshness:** feed changes ~monthly; weekly CI re-fetch + redeploy keeps it current.
  CI must fail loudly (keep serving old data) if the feed URL breaks or validation regresses.
- **Licensing:** GTFS **CC-BY-4.0** ("Dopravný podnik Bratislava / IDS BK") + geometry **ODbL**
  ("© OpenStreetMap contributors") + map tiles (OpenFreeMap/OSM) — all three visible in the
  attribution footer.

---

## 7. Directory layout (target)

```
bratislava-public-transport/
├─ scripts/build-data.ts        # GTFS + OSM geometry → compact JSON
├─ data-cache/osm-geometries.json # stitched per-relation polylines (committed, refreshed weekly)
├─ public/data/                 # generated assets (routes/, stops/, *.json, *.geojson)
├─ src/
│  ├─ map/                      # MapLibre setup, layers
│  ├─ features/{lines,stops,search,favorites,nearby}/
│  ├─ lib/                      # gtfs types, time/service-day utils
│  ├─ state/                    # store + URL sync
│  └─ App.tsx
├─ .github/workflows/refresh-data.yml
└─ README.md
```
