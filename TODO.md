# TODO / Backlog

Roadmap beyond the shipped M0–M9 plan (see [docs/PLAN.md](docs/PLAN.md)) and the
P1/P2 later phases (real-time feed, regional coverage — both blocked on external
data sources). Ordered roughly by value.

## Shipped 2026-07-07

- [x] **Dim other routes when a line or itinerary is selected** (overview → 0.08,
      stop dots hidden while focused).
- [x] **Share-link for planner trips** — `#plan&from=…&to=…&at=HH:MM`, share
      button, auto-search on open.
- [x] **Pedestrian graph** — OSM footway graph in the pipeline
      (`walk-graph.json`, 1.7 MB gz), walk legs drawn along real streets via
      client-side A*. Walking *times* still use the straight-line model.
- [x] **Performance** — maplibre in its own vendor chunk, tile-server
      preconnect. Still open: compact `stops/` (43 MB on disk) with legend arrays.
- [x] **Pseudo-realtime vehicle positions** — schedule-interpolated markers
      (header toggle, refreshed every 5 s, honest "not live" title). Own commit
      for easy revert.

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
