# Bratislava Transit Map

**Live: <https://oleshkooo.github.io/bratislava-public-transport/>**

A fast, clean web map of Bratislava public transport (MHD): all tram, trolleybus and bus
routes with precise street-following geometry, stops, schedule-aware departure boards,
printed-style timetables, favorites, dark mode, offline PWA and a client-side A→B trip
planner (RAPTOR). Fully static — no backend. See [docs/PLAN.md](docs/PLAN.md) for the plan.

## Quick start

```bash
npm install
npm run build:data   # GTFS + OSM → public/data/ (first run downloads the GTFS feed)
npm run dev
```

## How it works

- **Schedules** come from the official [IDS BK / DPB GTFS feed](https://www.arcgis.com/sharing/rest/content/items/aba12fd2cbac4843bc7406151bc66106/data) (CC-BY 4.0).
- **Route geometries** come from OpenStreetMap route relations (`network="MHD Bratislava"`,
  ODbL), because the GTFS `shapes.txt` only contains straight stop-to-stop lines.
- `scripts/build-data.ts` matches OSM relations to GTFS directions, validates them, and
  emits compact lazy-loadable JSON into `public/data/` (gitignored, rebuilt on deploy).
  Stitched OSM polylines are cached in `data-cache/` so CI does not depend on Overpass.
- Frontend: Vite + React + TypeScript, MapLibre GL with OpenFreeMap tiles, shadcn/ui,
  Zustand with URL-hash state (`#line=9&dir=0` links are shareable).
- Departure boards are computed client-side with proper GTFS service-day semantics
  (calendar + exceptions, after-midnight `25:30`-style times, Europe/Bratislava).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | dev server |
| `npm run build:data` | regenerate `public/data/` from GTFS + OSM caches |
| `npm run build` | typecheck + production build |
| `npm run lint` / `npm run typecheck` / `npm run format` | the usual |

## Attribution

Schedules: Dopravný podnik Bratislava / IDS BK (CC-BY 4.0). Route geometry and map data
© OpenStreetMap contributors (ODbL). Tiles: OpenFreeMap.
