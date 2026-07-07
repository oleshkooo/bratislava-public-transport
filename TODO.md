# TODO / Backlog

Roadmap beyond the shipped M0–M9 plan (see [docs/PLAN.md](docs/PLAN.md)) and the
P1/P2 later phases (real-time feed, regional coverage — both blocked on external
data sources). Ordered roughly by value.

## In progress / this iteration

- [ ] **Dim other routes when a line or itinerary is selected** — the overview
      layer stays at full opacity behind the selected route; drop it to ~0.1 so
      the active path reads instantly.
- [ ] **Share-link for planner trips** — encode from/to/time in the URL hash
      (`#plan=…`) so a planned trip can be sent to someone.
- [ ] **Pedestrian graph** — walking legs currently draw (and are timed) as
      straight lines × 1.25 detour ÷ 1.3 m/s. Build an OSM footway graph in the
      data pipeline (like the tram-rail graph), route walk legs over it client-side.
- [ ] **Performance** — split maplibre into its own vendor chunk (stable across
      deploys), preconnect to the tile server; later: compact `stops/` (43 MB on
      disk) with legend arrays.
- [ ] **Pseudo-realtime vehicle positions** — no public GTFS-RT exists, but
      scheduled positions can be interpolated along route geometry and animated
      on the map (honest "scheduled, not live" badge). Kept in its own commit so
      it's easy to revert.

## Next up

- [ ] **Plan on a date + "Arrive by" mode** — planner only does "today, depart
      at HH:MM"; the feed is valid to 2026-12-31. Needs a date picker and either
      reverse-RAPTOR or binary search over departure times.
- [ ] **Saved trips** ("home", "work") in PersonalSection with one-tap replan;
      also surface `recents.stops` — already tracked in the store, never shown.

## Nice to have

- [ ] Accessibility badges (low-floor / `wheelchair_accessible`) if the feed
      fills them.
- [ ] IDS BK fare-zone info per itinerary.
- [ ] Address search for planner endpoints (needs an external geocoder — either
      accept the online dependency or skip).
- [ ] Reverse geocoding for dropped pins (same constraint).

## Known limitations (accepted for now)

- Walking time is a model (straight-line × 1.25 ÷ 1.3 m/s), not a routed path —
  the pedestrian-graph item above fixes the geometry; times stay model-based.
- No real-time delays; all times are scheduled (feed has no GTFS-RT).
- `Šk` school line + lines 53/57/69 (one direction) draw approximate GTFS
  geometry — no usable OSM relations.
