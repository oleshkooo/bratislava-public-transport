# Handoff — Bratislava Transit Map

Last updated: 2026-07-07. State: **all plan milestones M0–M9 shipped and deployed.**
Live: <https://oleshkooo.github.io/bratislava-public-transport/> · Plan: [docs/PLAN.md](docs/PLAN.md)

## What this is

Static web map of Bratislava MHD: all 91 lines (tram/trolleybus/bus/night) with
street-following geometry, 1 355 stops, live schedule-aware departure boards, printed-style
timetables, search, favorites/recents/near-me, dark mode, installable offline PWA, and a
client-side A→B trip planner (RAPTOR). No backend; UI in English, transit names in Slovak.

## Daily commands

```bash
npm run build:data   # GTFS + OSM caches → public/data/ (~46 MB, gitignored)
npm run dev          # vite dev server (preview config in .claude/launch.json, port 5173)
npm run build        # tsc -b && vite build (+ PWA)
npm run lint && npm run typecheck && npm run format
```

CI ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)): every push to `main` →
build data + site → GitHub Pages (`BASE_PATH=/bratislava-public-transport/`). Weekly cron
(Mon 03:30 UTC) additionally sets `OSM_REFRESH=1` (re-fetch OSM, commit changed
`data-cache/` with `[skip ci]`). GTFS is always fetched fresh in CI (`.cache/` is
gitignored). Pages was enabled via `gh api repos/…/pages -f build_type=workflow`.

## Architecture in one breath

`scripts/build-data.ts` (run by `tsx`) turns the official GTFS feed + OSM data into
lazy-loadable JSON under `public/data/`; the React app (Vite 8, TS, Tailwind v4,
shadcn **base-nova** on **@base-ui/react** — not radix, MapLibre GL, Zustand, vaul)
fetches those files on demand. URL hash is the source of truth for navigation
(`#line=9&dir=0`, `#stop=<id>`, `#plan`).

### Data pipeline outputs (`public/data/`)

| File | Purpose |
|---|---|
| `routes.json`, `stops.json`, `calendar.json` | small indexes, loaded at boot |
| `all-routes.geojson` | overview layer, one geometry per line |
| `routes/{line}.json` | per line: directions, headsigns, ordered stops, geometry (+source) |
| `stops/{platformId}.json` × 1355 | full departure board per platform (short keys `l,d,h,s,t`) |
| `planner.json` (4.5 MB, ~650 KB gz) | RAPTOR dataset: patterns + all trip times + footpath transfers |
| `build-warnings.json` | whatever the build flagged |

### Caches

- `.cache/` (gitignored): `gtfs.zip`, `osm-raw.json`, `tram-rails-raw.json` — delete to re-fetch.
- `data-cache/` (**committed**, CI fallback when Overpass is down): `osm-geometries.json`
  (241 stitched relation polylines), `tram-rails.json` (640 `railway=tram` ways).
- `OSM_REFRESH=1 npm run build:data` forces both OSM re-fetches, falls back to committed cache on failure.

## Hard-won domain knowledge (do not relearn)

**GTFS feed** (DPB/IDS BK via ArcGIS, CC-BY 4.0, URL in build script):
- `route_long_name` is a **service note** ("Výluka Centrum 2. etapa"), never a display name.
- Times exceed 24:00 (max 29:04:45, 17k rows). A service day runs past midnight: at 01:30
  the relevant departures are `25:30` of *yesterday's* service ids. All client time math is
  in Europe/Bratislava via `Intl` ([src/lib/service-day.ts](src/lib/service-day.ts)) —
  the same today/yesterday duality is implemented in the departure boards, timetables and RAPTOR.
- `calendar_dates` has ~519 exceptions; always resolve service ids per concrete date.
- All 1 356 stops are platforms (`location_type=0`, no parents). Physical stop = group by `stop_name`.
- `shapes.txt` is **stop-to-stop straight lines** (median 16 pts) — never draw it as the route.

**Geometry enrichment** (the heart of the build script):
1. OSM route relations `network="MHD Bratislava"` (all PTv2, one relation per direction) are
   stitched way-by-way and matched to GTFS (route, direction) by `ref` + termini <3 km,
   then by **mean stop distance**, with a length-ratio guard (0.6–2.0× of the GTFS shape)
   so round-trip variant relations don't win.
2. Validation demotes clearly-wrong matches to the GTFS shape (lines **53 dir 1, 57, 69**
   have a single OSM relation for both directions; **Šk** isn't in OSM at all → 7 directions
   are honest straight-line fallbacks, marked `geometrySource: "gtfs"` and shown as
   "approximate" in the UI).
3. **Repair**: if stops sit >150 m from the matched polyline (GTFS runs a diversion OSM
   doesn't map — currently trams 3/4 "Výluka Centrum" via Obchodná), the run of off-route
   stops is spliced in: routed over the OSM tram-rail graph via Dijkstra for trams,
   straight chords for buses (151, N61). When the výluka ends and GTFS reverts, the repair
   naturally stops triggering — no cleanup needed.

**Overpass quirks**: overpass-api.de sometimes returns 406/HTML — set a UA, retry, or use
mirrors (kumi.systems, private.coffee); all three are in `OVERPASS_ENDPOINTS`.

**Map/frontend gotchas**:
- `maplibre-gl.css` forces `position: relative` on the map container → the container must
  be a `size-full` child of an absolutely-positioned wrapper, or it collapses to 0 height.
- Theme switch calls `map.setStyle()`; **all** transit sources/layers are re-added in the
  `style.load` handler (`addTransitLayers`) and an `epoch` state bump makes every data
  effect re-feed the new sources. Interactions are registered once (delegated listeners survive).
- Styles: OpenFreeMap `positron` (light) / `dark`; both share Noto Sans glyphs.
- Mobile (<768px) uses a **vaul** drawer: `open modal={false} dismissible={false}`,
  snap points `[0.18, 0.55, 0.94]`, edge-to-edge; desktop keeps the floating panel.
  Map `fitBounds` padding assumes the half-open drawer (`fitPadding()` in MapView).
- base-ui differences: `ToggleGroup` value is an **array**; `Toggle` uses `pressed`/
  `onPressedChange`; nested `<button>` is a real hazard — `LineChip` renders a `<span>`
  when it has no `onClick` specifically so chips can live inside clickable cards.
- eslint runs react-hooks v7: no sync `setState` in effects — use the
  "adjust state during render" pattern (see `StopPanel`, `PlannerPanel`, `MobileDrawer`);
  `react-refresh/only-export-components` is off for `src/components/ui/**`.
- Dev console helper: `window.__appStore` (zustand store, DEV only).

**RAPTOR** ([src/lib/raptor.ts](src/lib/raptor.ts)): ≤5 rounds, 30 s board slack, footpaths
≤250 m (≤8 per stop, same-name platforms = 45 s), target pruning, journey reconstruction via
per-round parent pointers, pareto output (per-round best → up to 4 itineraries). Itinerary
map overlay slices the real line geometry between board/alight stops
(`sliceGeometry` in PlannerPanel), falling back to the stop-to-stop path.

## Known rough edges / next steps

- **P1 real-time** and **P2 regional coverage** (plan §5 "later phases") are blocked on
  external sources — no public GTFS-RT/vehicle feed existed as of 2026-07.
- JS bundle is ~1.3 MB (maplibre) — code-splitting would help first load.
- `stops/` is 43 MB on disk (fine for Pages; could be compacted with legend arrays).
- `recents.stops` is tracked in the store but PersonalSection currently shows only recent lines.
- Line 79 dir 1 has an OSM/GTFS length-ratio warning (1.89) — probably a long OSM variant; unverified.
- Timetable day selector covers 7 days ahead; feed itself is valid to 2026-12-31.
- PWA icons are generated from `public/favicon.svg` (rasterized via macOS `qlmanage`/`sips`
  — regenerate manually if the icon changes; CI does not rebuild them).

## Verification playbook

Preview flows that were tested and should keep working: overview → tap line chip →
direction toggle → stop timeline → clock icon → departures board (compare against
Europe/Bratislava wall clock, including after-midnight night lines); search "zochova"
(diacritic-folded); `#line=4&dir=0` deep link; timetable tab day switching; planner
Kútiky → Zlaté piesky at night (expects N-lines via Hlavná stanica) and ~10:00 daytime
(expects tram 9 + 4 vs direct 4 pareto pair); tram 4 stops Poštová/Vysoká/Blumentál/Centrum
must sit on the drawn line (regression check for the repair step); mobile drawer snaps and
map stays interactive above it.
