# Bratislava Public Transport — Plan

A fast, clean web map of Bratislava city public transport (MHD). Personal-use tool,
not a demo — target the full feature set. Built as a **static site** (no backend for v1),
UI in **English**, transit data (stop/line names) stays **Slovak** as published.

---

## 1. Data source (verified 2026-07)

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
| Shape variants (geometries) | 371 |
| Trips | 36 196 |
| Service patterns (calendar) | 8 (weekday/weekend/holiday) |

Key files: `routes.txt`, `trips.txt`, `shapes.txt` (route geometry), `stops.txt`,
`stop_times.txt` (**44 MB** — the reason we preprocess), `calendar.txt` + `calendar_dates.txt`.

### No real-time (yet)

No public GTFS-RT / open live-position feed found. Live vehicle tracking is deferred
(see Phase 3). Architecture leaves room for a thin serverless proxy later.

---

## 2. Architecture

Fully static site + an offline **build step** that turns the 44 MB GTFS into small,
lazy-loadable JSON. The browser never touches raw GTFS.

```
[GTFS.zip @ ArcGIS]
      │  scripts/build-data (Node/TS), run at deploy time + weekly via CI
      ▼
  parse (proper CSV parser) → emit compact assets:
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

---

## 3. Tech stack

- **Frontend:** React + Vite + TypeScript.
- **Map:** MapLibre GL JS (WebGL, handles thousands of features). Tiles: **OpenFreeMap**
  (free vector tiles, no API key). Fallback: MapTiler free tier.
- **State:** lightweight (Zustand) + **URL as source of truth** (selected line/stop/view →
  shareable, bookmarkable links).
- **Build script:** Node + `csv-parse` + `adm-zip` (or `node-gtfs`).
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
- **M1 — Data pipeline:** `build-data` → `routes.json`, `stops.json`, `all-routes.geojson`.
- **M2 — Overview:** render all routes + all stops with layer toggles + clustering.
- **M3 — Line browser:** typed menu → select line → route highlight + direction toggle +
  stop list + fit bounds. *(the original core idea, done)*
- **M4 — Stop details:** click stop → serving lines + next scheduled departures.
- **M5 — Schedules:** full timetables per line and per stop, service-day aware.
- **M6 — Search:** lines + stops.
- **M7 — Personal:** favorites, near-me, URL state, dark mode.
- **M8 — PWA + polish + deploy:** offline, weekly data-refresh Action, attribution.

**Later phases**
- **P3 — Real-time:** vehicle positions + live delays (needs a live source; thin proxy).
- **P4 — Coverage:** merge regional buses + trains (S-lines).
- **P5 — Trip planner:** A→B routing (RAPTOR/CSA over the schedule; likely `sql.js`/WASM).

---

## 6. Technical notes & risks

- **44 MB `stop_times.txt`** → always preprocessed; never shipped raw. Per-stop/per-line JSON.
- **CSV quirks:** line names contain commas (`"platná aj 16.2.-19.4.…"`) → use a real quoted-CSV
  parser, never `split(',')`.
- **Directions:** group trips by `direction_id`; pick a representative full-length trip/shape
  per direction so the drawn route is the complete one.
- **Stops = platforms:** 1 356 points, no parent stations; group by `stop_code`/name for a clean
  physical-stop view.
- **Service days:** respect `calendar` + `calendar_dates` (exceptions/holidays) for correct
  "today's" departures.
- **Data freshness:** feed changes ~monthly; weekly CI re-fetch + redeploy keeps it current.
- **Licensing:** CC-BY-4.0 — keep the attribution visible.

---

## 7. Directory layout (target)

```
bratislava-public-transport/
├─ scripts/build-data.ts        # GTFS → compact JSON
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
