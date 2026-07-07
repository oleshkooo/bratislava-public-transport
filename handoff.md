# Handoff — Bratislava Transit Map

Last updated: 2026-07-07 (third iteration). State: **all plan milestones M0–M9 shipped
and deployed**, plus a post-plan round: location→location planner with routed walking
legs, share links, schedule-interpolated vehicle positions, overview dimming, bundle
split. This iteration: vehicles filtered to the map focus, two mobile-drawer bugfixes
(iOS keyboard, body pointer-events race), dismissible attribution card.
Backlog lives in [TODO.md](TODO.md).
Live: <https://oleshkooo.github.io/bratislava-public-transport/> · Plan: [docs/PLAN.md](docs/PLAN.md)

## What this is

Static web map of Bratislava MHD: all 91 lines (tram/trolleybus/bus/night) with
street-following geometry, 1 355 stops, live schedule-aware departure boards, printed-style
timetables, search, favorites/recents/near-me, dark mode, installable offline PWA, a
client-side **location→location trip planner** (RAPTOR + walking legs routed over an OSM
footway graph, shareable trip links), and **scheduled vehicle positions** animated on the
map. No backend; UI in English, transit names in Slovak.

## Daily commands

```bash
npm run build:data   # GTFS + OSM caches → public/data/ (~55 MB, gitignored)
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
(`#line=9&dir=0`, `#stop=<id>`, `#plan&from=s:<stop>|p:<lat,lon>&to=…&at=HH:MM`).

### Data pipeline outputs (`public/data/`)

| File | Purpose |
|---|---|
| `routes.json`, `stops.json`, `calendar.json` | small indexes, loaded at boot |
| `all-routes.geojson` | overview layer, one geometry per line |
| `routes/{line}.json` | per line: directions, headsigns, ordered stops, geometry (+source) |
| `stops/{platformId}.json` × 1355 | full departure board per platform (short keys `l,d,h,s,t`) |
| `planner.json` (4.5 MB, ~650 KB gz) | RAPTOR dataset: patterns + all trip times + footpath transfers |
| `walk-graph.json` (5 MB, ~1.7 MB gz) | pedestrian graph (142k nodes/180k edges) for routed walking legs |
| `build-warnings.json` | whatever the build flagged |

### Caches

- `.cache/` (gitignored): `gtfs.zip`, `osm-raw.json`, `tram-rails-raw.json`,
  `walk-raw.json` (~47 MB) — delete to re-fetch.
- `data-cache/` (**committed**, CI fallback when Overpass is down): `osm-geometries.json`
  (241 stitched relation polylines), `tram-rails.json` (640 `railway=tram` ways),
  `walk-graph.json` (processed pedestrian graph, 5 MB).
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
3. **Trim**: matched OSM polylines whose ends run >200 m past the first/last GTFS stop
   are cut back to the closest pass by that stop (`trimToTermini`) — OSM relations
   sometimes keep a longer historical routing (79 dir 1 ran 3.2 km past Stn. P.
   Biskupice toward Čiližská; 21/23/30/56/67/151 had similar tails). The trim reverts
   itself if it would pull any stop off the line, and re-runs after repair so spliced
   termini (151's Česká) get a clean end too.
4. **Repair**: if stops sit >150 m from the matched polyline (GTFS runs a diversion OSM
   doesn't map — currently trams 3/4 "Výluka Centrum" via Obchodná), the run of off-route
   stops is spliced in: routed over the OSM tram-rail graph via Dijkstra for trams,
   straight chords for buses (151, N61). When the výluka ends and GTFS reverts, the repair
   naturally stops triggering — no cleanup needed. Each waypoint considers **several
   candidate rail nodes** (up to 6 within 120 m) and a leg-by-leg DP picks the combination
   with the shortest total path — snapping to the single nearest node used to land stops
   on the opposite-direction track and produced there-and-back hairpin spurs (seen on
   tram 4 at Poštová). Legitimate out-and-back spurs still exist on bus lines
   (36, 25/26/92 VW gate, 67/78 Astronomická…) — those come from the OSM relations
   themselves and are real.

**Overpass quirks**: overpass-api.de sometimes returns 406/HTML — set a UA, retry, or use
mirrors (kumi.systems, private.coffee); all three are in `OVERPASS_ENDPOINTS`. The
walkable-ways query is the heavy one (~47 MB response, 600 s timeout) — it only runs on
`OSM_REFRESH=1` or when both caches are missing; day-to-day builds read the committed
`data-cache/walk-graph.json`.

**Map/frontend gotchas**:
- `maplibre-gl.css` forces `position: relative` on the map container → the container must
  be a `size-full` child of an absolutely-positioned wrapper, or it collapses to 0 height.
- Theme switch calls `map.setStyle()`; **all** transit sources/layers are re-added in the
  `style.load` handler (`addTransitLayers`) and an `epoch` state bump makes every data
  effect re-feed the new sources. Interactions are registered once (delegated listeners survive).
- Styles: OpenFreeMap `positron` (light) / `dark`; both share Noto Sans glyphs.
- Mobile (<768px) uses a **vaul** drawer: `open modal={false} dismissible={false}
  handleOnly`, snap points `SNAP_POINTS = [0.18, 0.55, 0.94]` (peek/half/full,
  exported from the store), edge-to-edge; desktop keeps the floating panel.
  Dragging works **only via `Drawer.Handle`** (so lists scroll freely); the handle's
  hit area is stretched to the full drawer width in index.css
  (`[data-vaul-handle-hitarea]`). Tapping the handle cycles peek→half→full→peek —
  vaul's cycle returns `undefined` past the last snap, which `setActiveSnapPoint`
  maps back to peek. The snap position lives in the store (`drawerSnap`):
  selectLine/selectStop/goPlan pull a peeking drawer to half, the planner's
  "choose on map" collapses it to peek and `pickPlace` restores half. Map
  `fitBounds` padding assumes the half-open drawer (`fitPadding()` in MapView).
  **iOS keyboard**: vaul's `repositionInputs` (default on) recomputes the
  transform against the shrunken visualViewport and throws a snap-point drawer
  off-screen — it is disabled; instead a focusin on any `input`/`textarea`
  inside `Drawer.Content` pulls the drawer to the full snap so the field sits
  above the keyboard.
  **Body pointer-events**: vaul doesn't forward `modal={false}` to the radix
  Dialog underneath, so radix marks the always-open drawer modal and sets
  `pointer-events: none` on `<body>`; vaul counter-restores `auto` via one
  requestAnimationFrame per open — a race it sometimes loses, leaving the map
  dead to touches. index.css pins `body { pointer-events: auto !important }`
  (safe: the app has no real modals — revisit if one is ever added).
- Attribution is a custom dismissible card ([src/map/MapAttribution.tsx](src/map/MapAttribution.tsx)),
  not maplibre's control (whose default spot the drawer covers on mobile):
  top-left on mobile / bottom-right on desktop, credits DPB/IDS BK (CC-BY),
  OSM (ODbL), OpenFreeMap, OpenMapTiles. The ✕ collapses it to an ⓘ button and
  persists in localStorage (`attribution-dismissed`) — it must never disappear
  entirely, ODbL requires the credits to stay reachable. The panel footer
  (App.tsx) carries the same line, fully visible at the full drawer snap.
- base-ui differences: `ToggleGroup` value is an **array**; `Toggle` uses `pressed`/
  `onPressedChange`; nested `<button>` is a real hazard — `LineChip` renders a `<span>`
  when it has no `onClick` specifically so chips can live inside clickable cards.
- eslint runs react-hooks v7: no sync `setState` in effects — use the
  "adjust state during render" pattern (see `StopPanel`) or an editing-flag
  (`PlaceField` in PlannerPanel); it also rejects *forward references* from
  effects to functions declared later in the component (declare first, then use);
  `react-refresh/only-export-components` is off for `src/components/ui/**`.
- **Vehicle positions** (header BusFront toggle) are schedule-interpolated, not live:
  every active trip is placed along its direction geometry between the two stops it is
  between right now ([src/features/vehicles/vehicles.ts](src/features/vehicles/vehicles.ts)),
  refreshed every 5 s; direction geometries lazy-load per line. Falls back to
  stop-to-stop interpolation while geometry loads. Mirroring the overview-dimming rule,
  vehicles are filtered to the selected line (or the drawn itinerary's lines;
  walk-only itinerary → none) — `vehicleFilterKey` in MapView + `lineFilter` in
  `computeVehicles`. Sits in its own commit for easy revert.
- The JS bundle is split: maplibre lives in its own vendor chunk (~273 KB gz, stable
  across deploys); app code is ~124 KB gz.
- Micro-animations use **tw-animate-css** (`animate-in fade-in slide-in-from-* duration-*`):
  panel switches (keyed wrapper in App), search/place dropdowns, planner results and
  expanded details, lines-grid tab switches. A global `prefers-reduced-motion` rule in
  index.css collapses all animations/transitions to instant.
- Dev console helpers (DEV only): `window.__appStore` (zustand store) and
  `window.__map` (maplibre Map instance).
- Vite dev server honors `PORT` (see vite.config.ts) and `.claude/launch.json` has
  `autoPort: true`, so a second session gets a free port instead of failing on 5173.

**RAPTOR** ([src/lib/raptor.ts](src/lib/raptor.ts)): ≤5 rounds, 30 s board slack, footpaths
≤250 m (≤8 per stop, same-name platforms = 45 s), target pruning, journey reconstruction via
per-round parent pointers, pareto output (per-round best → itineraries). The planner is
**location→location**: endpoints are `PlannerPlace` (a stop name, "My location" via
geolocation, or a map-picked point — store: `planFrom/planTo/mapPick/pickPlace`).
`PlanQuery` takes `sources`/`targets` = candidate stops **with access/egress walk seconds**
(PlannerPanel `endCandidates`: ≤8 stops within 600 m, else 3 nearest ≤3 km; walk model
1.3 m/s × 1.25 detour, matching the build script). Target pruning and reconstruction use
final arrival (stop arrival + egress); itineraries get walk legs with `fromStopId`/
`toStopId = null` for the origin/destination points, and depart/arrive include the walks.
A pure-walk itinerary is added when the places are ≤2.5 km apart; back-to-back walk legs
(access walk + platform transfer) are merged into one during reconstruction. Endpoint
markers render via the `plan-places` map source (green origin / red destination); the
itinerary overlay slices the real line geometry between board/alight stops
(`sliceGeometry` in PlannerPanel), falling back to the stop-to-stop path. **Walk legs are
drawn along real streets** via A* over the lazy-loaded footway graph
([src/lib/walk.ts](src/lib/walk.ts)); the straight dashed line remains the fallback, and
walking *times* stay on the straight-line model shared with RAPTOR. While an itinerary is
drawn (or a line selected), the overview layer dims to 0.08 and stop dots hide.
Departure time uses a native `<input type="time">` (iOS wheel). The planner toolbar icon
toggles the planner open/closed, and the global search box is hidden in the plan view.
Trips are shareable: `#plan&from=s:<stop>|p:<lat,lon>&to=…&at=HH:MM` tracks the current
trip (share button in the header; opening a link auto-searches). Results sort by trip
duration.

## Known rough edges / next steps

The prioritized backlog is [TODO.md](TODO.md). Standing constraints:

- **P1 real-time** and **P2 regional coverage** (plan §5 "later phases") are blocked on
  external sources — no public GTFS-RT/vehicle feed existed as of 2026-07 (the vehicle
  toggle is schedule-interpolated, not live).
- Walking *times* are a model (straight-line × 1.25 ÷ 1.3 m/s) even though walking
  *paths* are routed — routing times too would mean running A* per candidate stop
  inside the RAPTOR query (~dozens of searches per plan) or precomputing tables.
- `stops/` is 43 MB on disk (fine for Pages; could be compacted with legend arrays).
- `recents.stops` is tracked in the store but PersonalSection currently shows only recent lines.
- Timetable day selector covers 7 days ahead; feed itself is valid to 2026-12-31.
- PWA icons are generated from `public/favicon.svg` (rasterized via macOS `qlmanage`/`sips`
  — regenerate manually if the icon changes; CI does not rebuild them).
- Dropped pins have no reverse geocoding (labels are raw coordinates) — an external
  geocoder would break the fully-static/offline design; accepted for now.
- **Diagnosed, not fixed**: `selectLine`'s `loadLineDetail(...).then(...)` has no
  `.catch` — one failed fetch leaves `lineDetail` null forever (no fitBounds, panel
  stuck on skeleton) until the line is re-selected or the page reloaded. Second
  suspect for "map didn't center": GeolocateControl's track-lock re-centering can
  cancel a running `fitBounds`. Add a retry/error surface when it bites again.

## Verification playbook

Preview flows that were tested and should keep working: overview → tap line chip →
direction toggle → stop timeline → clock icon → departures board (compare against
Europe/Bratislava wall clock, including after-midnight night lines); search "zochova"
(diacritic-folded); `#line=4&dir=0` deep link; timetable tab day switching; planner
Kútiky → Zlaté piesky at night (expects N-lines via Hlavná stanica) and ~10:00 daytime
(expects tram 9 + 4 vs direct 4 pareto pair, sorted by trip duration); planner with two
map-picked points (expects access/egress walk legs **routed along streets**, endpoint
markers, dimmed overview while the itinerary is drawn, walk-only option for nearby
points); share link round-trip: with a trip set, copy the URL, open it in a fresh tab —
it must restore both places + time and auto-search; vehicles toggle (BusFront in the
header) shows a few hundred colored dots moving along their lines at daytime, and only
the selected line's dots while a line is open (itinerary drawn → only its lines); tram 4
stops Poštová/Vysoká/Blumentál/Centrum must sit on the drawn line **with no
there-and-back hairpin near Poštová** (regression checks for the repair step); mobile
drawer: drag works only on the handle (lists scroll without collapsing it), handle tap
cycles peek→half→full, opening content pulls a peeking drawer to half, focusing a
planner/search field pulls it to full (keyboard must not push the drawer off-screen —
regression check on a real iPhone), and the map behind the drawer keeps taking taps
(body pointer-events race); attribution card shows on first visit (top-left on
mobile), ✕ collapses it to ⓘ and that survives reload, ⓘ reopens it.
