/**
 * GTFS + OSM → compact static JSON for the frontend (see docs/PLAN.md §2/§2a).
 *
 * Inputs (cached):
 *   .cache/gtfs.zip                  raw GTFS feed (fetched if missing)
 *   data-cache/osm-geometries.json   stitched per-relation polylines (fetched+processed if missing)
 *
 * Outputs (public/data/, gitignored — regenerated at build time):
 *   routes.json, stops.json, calendar.json, all-routes.geojson,
 *   routes/{line}.json, stops/{stopId}.json
 */
import AdmZip from "adm-zip"
import { parse as parseCsv } from "csv-parse/sync"
import { parse as parseCsvStream } from "csv-parse"
import { Readable } from "node:stream"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const CACHE_DIR = path.join(ROOT, ".cache")
const DATA_CACHE_DIR = path.join(ROOT, "data-cache")
const OUT_DIR = path.join(ROOT, "public", "data")

const GTFS_URL =
  "https://www.arcgis.com/sharing/rest/content/items/aba12fd2cbac4843bc7406151bc66106/data"
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
]
const OVERPASS_QUERY = `
[out:json][timeout:180];
relation["route"~"^(tram|trolleybus|bus)$"]["network"="MHD Bratislava"](48.0,16.9,48.3,17.3);
out geom;
`
const USER_AGENT = "bratislava-transit-map/1.0 (static build script)"

/** Combined start+end terminus distance above which an OSM match is rejected. */
const MATCH_REJECT_M = 3000
/** Validation: warn if any stop of a direction is farther than this from its polyline. */
const STOP_TO_LINE_WARN_M = 80
/** Validation: warn if OSM length / GTFS shape length falls outside these bounds. */
const LENGTH_RATIO_BOUNDS: [number, number] = [0.9, 1.8]

const ROUTE_TYPE: Record<string, "tram" | "bus" | "trolleybus"> = {
  "0": "tram",
  "3": "bus",
  "11": "trolleybus",
}

type LonLat = [number, number]

interface OsmGeometry {
  id: number
  ref: string
  mode: string
  from: string
  to: string
  coords: LonLat[]
  maxGapM: number
}

const warnings: string[] = []
function warn(msg: string) {
  warnings.push(msg)
  console.warn(`  ⚠ ${msg}`)
}

// ---------- geo helpers ----------

function haversine(a: LonLat, b: LonLat): number {
  const R = 6371000
  const dLat = ((b[1] - a[1]) * Math.PI) / 180
  const dLon = ((b[0] - a[0]) * Math.PI) / 180
  const la1 = (a[1] * Math.PI) / 180
  const la2 = (b[1] * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function polylineLength(coords: LonLat[]): number {
  let len = 0
  for (let i = 1; i < coords.length; i++)
    len += haversine(coords[i - 1], coords[i])
  return len
}

/** Approximate min distance (m) from a point to a polyline, in a local flat projection. */
function pointToPolylineM(p: LonLat, coords: LonLat[]): number {
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180)
  const ky = 110574
  const px = p[0] * kx
  const py = p[1] * ky
  let best = Infinity
  for (let i = 1; i < coords.length; i++) {
    const ax = coords[i - 1][0] * kx
    const ay = coords[i - 1][1] * ky
    const bx = coords[i][0] * kx
    const by = coords[i][1] * ky
    const dx = bx - ax
    const dy = by - ay
    const l2 = dx * dx + dy * dy
    let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2
    t = Math.max(0, Math.min(1, t))
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    if (d < best) best = d
  }
  return best
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6

// ---------- GTFS loading ----------

async function loadGtfs(): Promise<Record<string, Buffer>> {
  const zipPath = path.join(CACHE_DIR, "gtfs.zip")
  if (!fs.existsSync(zipPath)) {
    console.log("Fetching GTFS feed…")
    const res = await fetch(GTFS_URL)
    if (!res.ok) throw new Error(`GTFS fetch failed: ${res.status}`)
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()))
  }
  const zip = new AdmZip(zipPath)
  const files: Record<string, Buffer> = {}
  for (const entry of zip.getEntries()) files[entry.entryName] = entry.getData()
  return files
}

function csv(
  files: Record<string, Buffer>,
  name: string
): Record<string, string>[] {
  const buf = files[name]
  if (!buf) return []
  return parseCsv(buf, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true,
  })
}

// ---------- OSM geometries ----------

interface OsmWayMember {
  type: string
  role: string
  geometry?: { lat: number; lon: number }[]
}

function stitchWays(ways: { lat: number; lon: number }[][]): {
  coords: LonLat[]
  maxGapM: number
} {
  let coords: LonLat[] = []
  let maxGapM = 0
  let firstOriented = false
  for (const way of ways) {
    let pts: LonLat[] = way.map((g) => [g.lon, g.lat])
    if (coords.length === 0) {
      coords = pts
      continue
    }
    if (!firstOriented) {
      // Decide whether the very first way needs flipping, using this second way.
      const head = coords[0]
      const tail = coords[coords.length - 1]
      const bestFromTail = Math.min(
        haversine(tail, pts[0]),
        haversine(tail, pts[pts.length - 1])
      )
      const bestFromHead = Math.min(
        haversine(head, pts[0]),
        haversine(head, pts[pts.length - 1])
      )
      if (bestFromHead < bestFromTail) coords.reverse()
      firstOriented = true
    }
    const tail = coords[coords.length - 1]
    const dStart = haversine(tail, pts[0])
    const dEnd = haversine(tail, pts[pts.length - 1])
    if (dEnd < dStart) pts = pts.slice().reverse()
    const gap = Math.min(dStart, dEnd)
    if (gap > maxGapM) maxGapM = gap
    coords.push(...(gap < 1 ? pts.slice(1) : pts))
  }
  return { coords, maxGapM }
}

async function loadOsmGeometries(): Promise<OsmGeometry[]> {
  const cachePath = path.join(DATA_CACHE_DIR, "osm-geometries.json")
  // OSM_REFRESH=1 (weekly CI) re-fetches from Overpass but keeps the committed
  // cache as fallback when all endpoints fail.
  const refresh = process.env.OSM_REFRESH === "1"
  if (!refresh && fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"))
  }
  let raw: { elements: Record<string, unknown>[] } | undefined
  const rawCachePath = path.join(CACHE_DIR, "osm-raw.json")
  if (!refresh && fs.existsSync(rawCachePath)) {
    raw = JSON.parse(fs.readFileSync(rawCachePath, "utf8"))
  }
  if (!raw) console.log("Fetching OSM route relations from Overpass…")
  for (const endpoint of raw ? [] : OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "data=" + encodeURIComponent(OVERPASS_QUERY),
        signal: AbortSignal.timeout(300_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      raw = (await res.json()) as typeof raw
      break
    } catch (e) {
      console.warn(`  Overpass ${endpoint} failed: ${e}`)
    }
  }
  if (!raw) {
    if (fs.existsSync(cachePath)) {
      console.warn("  Overpass unavailable — falling back to committed geometry cache")
      return JSON.parse(fs.readFileSync(cachePath, "utf8"))
    }
    throw new Error("All Overpass endpoints failed and no cached geometries exist")
  }

  const geometries: OsmGeometry[] = []
  for (const el of raw.elements) {
    const tags = (el.tags ?? {}) as Record<string, string>
    const members = (el.members ?? []) as OsmWayMember[]
    const ways = members
      .filter((m) => m.type === "way" && m.role === "" && m.geometry?.length)
      .map((m) => m.geometry as { lat: number; lon: number }[])
    if (ways.length === 0) continue
    const { coords, maxGapM } = stitchWays(ways)
    if (maxGapM > 100) {
      warn(
        `OSM relation ${el.id} (${tags.route} ${tags.ref}): stitch gap ${Math.round(maxGapM)} m`
      )
    }
    geometries.push({
      id: el.id as number,
      ref: tags.ref ?? "",
      mode: tags.route ?? "",
      from: tags.from ?? "",
      to: tags.to ?? "",
      coords: coords.map(([x, y]) => [r6(x), r6(y)] as LonLat),
      maxGapM: Math.round(maxGapM),
    })
  }
  fs.mkdirSync(DATA_CACHE_DIR, { recursive: true })
  fs.writeFileSync(cachePath, JSON.stringify(geometries))
  console.log(`  cached ${geometries.length} stitched relation geometries`)
  return geometries
}

// ---------- main ----------

async function main() {
  console.log("== build-data ==")
  const files = await loadGtfs()

  const routesRows = csv(files, "routes.txt")
  const tripsRows = csv(files, "trips.txt")
  const stopsRows = csv(files, "stops.txt")
  const shapesRows = csv(files, "shapes.txt")
  const calendarRows = csv(files, "calendar.txt")
  const calendarDatesRows = csv(files, "calendar_dates.txt")
  const feedInfoRows = csv(files, "feed_info.txt")

  // --- shapes ---
  const shapes = new Map<string, LonLat[]>()
  {
    const grouped = new Map<string, { seq: number; pt: LonLat }[]>()
    for (const r of shapesRows) {
      let arr = grouped.get(r.shape_id)
      if (!arr) grouped.set(r.shape_id, (arr = []))
      arr.push({
        seq: Number(r.shape_pt_sequence),
        pt: [Number(r.shape_pt_lon), Number(r.shape_pt_lat)],
      })
    }
    for (const [id, arr] of grouped) {
      arr.sort((a, b) => a.seq - b.seq)
      shapes.set(
        id,
        arr.map((x) => x.pt)
      )
    }
  }

  // --- stops ---
  interface Stop {
    id: string
    code: string
    name: string
    lat: number
    lon: number
  }
  const stops = new Map<string, Stop>()
  for (const r of stopsRows) {
    stops.set(r.stop_id, {
      id: r.stop_id,
      code: r.stop_code,
      name: r.stop_name,
      lat: r6(Number(r.stop_lat)),
      lon: r6(Number(r.stop_lon)),
    })
  }

  // --- routes & trips ---
  interface Line {
    id: string
    name: string
    type: "tram" | "bus" | "trolleybus"
    night: boolean
    color: string
    textColor: string
    note: string
    routeId: string
  }
  const linesByRouteId = new Map<string, Line>()
  for (const r of routesRows) {
    const type = ROUTE_TYPE[r.route_type]
    if (!type) {
      warn(
        `route ${r.route_short_name}: unknown route_type ${r.route_type}, treating as bus`
      )
    }
    linesByRouteId.set(r.route_id, {
      id: r.route_short_name,
      name: r.route_short_name,
      type: type ?? "bus",
      night: /^N\d/.test(r.route_short_name),
      color: r.route_color || "888888",
      textColor: r.route_text_color || "FFFFFF",
      note: r.route_long_name || "",
      routeId: r.route_id,
    })
  }

  interface Trip {
    routeId: string
    serviceId: string
    directionId: number
    headsign: string
    shapeId: string
  }
  const trips = new Map<string, Trip>()
  for (const r of tripsRows) {
    trips.set(r.trip_id, {
      routeId: r.route_id,
      serviceId: r.service_id,
      directionId: Number(r.direction_id),
      headsign: r.trip_headsign,
      shapeId: r.shape_id,
    })
  }

  // --- stop_times (streamed: 689k rows / 44 MB) ---
  console.log("Parsing stop_times.txt…")
  const tripStops = new Map<
    string,
    { stopId: string; seq: number; dep: number }[]
  >()
  {
    const parser = Readable.from(files["stop_times.txt"]).pipe(
      parseCsvStream({
        columns: true,
        bom: true,
        skip_empty_lines: true,
        trim: true,
      })
    )
    for await (const r of parser as AsyncIterable<Record<string, string>>) {
      const [h, m, s] = r.departure_time.split(":").map(Number)
      let arr = tripStops.get(r.trip_id)
      if (!arr) tripStops.set(r.trip_id, (arr = []))
      arr.push({
        stopId: r.stop_id,
        seq: Number(r.stop_sequence),
        dep: h * 3600 + m * 60 + s,
      })
    }
    for (const arr of tripStops.values()) arr.sort((a, b) => a.seq - b.seq)
  }

  // --- group trips per (line, direction); find modal stop pattern ---
  interface Direction {
    id: number
    headsign: string
    stops: string[]
    geometry: LonLat[]
    geometrySource: "osm" | "gtfs"
    shapeId: string
  }
  const lineDirections = new Map<string, Direction[]>() // key: line name

  const tripsByRouteDir = new Map<string, string[]>() // routeId|dir → tripIds
  for (const [tripId, t] of trips) {
    const key = `${t.routeId}|${t.directionId}`
    let arr = tripsByRouteDir.get(key)
    if (!arr) tripsByRouteDir.set(key, (arr = []))
    arr.push(tripId)
  }

  const osmGeometries = await loadOsmGeometries()
  const osmByKey = new Map<string, OsmGeometry[]>()
  for (const g of osmGeometries) {
    const key = `${g.mode}|${g.ref}`
    let arr = osmByKey.get(key)
    if (!arr) osmByKey.set(key, (arr = []))
    arr.push(g)
  }

  let osmMatched = 0
  let gtfsFallback = 0

  for (const [key, tripIds] of tripsByRouteDir) {
    const [routeId, dirStr] = key.split("|")
    const line = linesByRouteId.get(routeId)
    if (!line) continue

    // Modal stop pattern
    const patternCount = new Map<string, { count: number; tripId: string }>()
    for (const tripId of tripIds) {
      const seq = tripStops.get(tripId)
      if (!seq?.length) continue
      const sig = seq.map((s) => s.stopId).join("|")
      const e = patternCount.get(sig)
      if (e) e.count++
      else patternCount.set(sig, { count: 1, tripId })
    }
    if (patternCount.size === 0) continue
    const modal = [...patternCount.values()].sort(
      (a, b) => b.count - a.count
    )[0]
    const modalStops = tripStops.get(modal.tripId)!.map((s) => s.stopId)

    // Modal headsign among trips of this direction
    const headsignCount = new Map<string, number>()
    for (const tripId of tripIds) {
      const h = trips.get(tripId)!.headsign
      headsignCount.set(h, (headsignCount.get(h) ?? 0) + 1)
    }
    const headsign = [...headsignCount.entries()].sort(
      (a, b) => b[1] - a[1]
    )[0][0]

    // Geometry: best OSM relation by terminus proximity, else GTFS shape
    const first = stops.get(modalStops[0])!
    const last = stops.get(modalStops[modalStops.length - 1])!
    const firstPt: LonLat = [first.lon, first.lat]
    const lastPt: LonLat = [last.lon, last.lat]
    // OSM tags night buses as route=bus
    const osmMode = line.type === "trolleybus" ? "trolleybus" : line.type
    const candidates =
      osmByKey.get(`${osmMode}|${line.name}`) ??
      osmByKey.get(`bus|${line.name}`) ??
      []

    let bestGeom: OsmGeometry | undefined
    let bestScore = Infinity
    for (const g of candidates) {
      const score =
        haversine(firstPt, g.coords[0]) +
        haversine(lastPt, g.coords[g.coords.length - 1])
      if (score < bestScore) {
        bestScore = score
        bestGeom = g
      }
    }

    const shapeId = trips.get(modal.tripId)!.shapeId
    let geometry: LonLat[]
    let geometrySource: "osm" | "gtfs"
    if (bestGeom && bestScore < MATCH_REJECT_M) {
      geometry = bestGeom.coords
      geometrySource = "osm"
      osmMatched++
    } else {
      geometry = (shapes.get(shapeId) ?? []).map(
        ([x, y]) => [r6(x), r6(y)] as LonLat
      )
      geometrySource = "gtfs"
      gtfsFallback++
      warn(
        `line ${line.name} dir ${dirStr}: no OSM match ` +
          `(${candidates.length} candidates, best score ${Math.round(bestScore)} m) — GTFS shape fallback`
      )
    }

    // Validation — demote to GTFS shape when the OSM match is clearly wrong
    // (e.g. lines 53/57/69 have a single OSM relation; the other direction must not reuse it)
    if (geometrySource === "osm") {
      const gtfsShape = shapes.get(shapeId) ?? []
      const gtfsLen = polylineLength(gtfsShape)
      const osmLen = polylineLength(geometry)
      const ratio = gtfsLen > 0 ? osmLen / gtfsLen : 1
      let worst = 0
      for (const sid of modalStops) {
        const s = stops.get(sid)!
        const d = pointToPolylineM([s.lon, s.lat], geometry)
        if (d > worst) worst = d
      }
      if (ratio > 2.5 || ratio < 0.5 || worst > 500) {
        warn(
          `line ${line.name} dir ${dirStr}: OSM match rejected by validation ` +
            `(length ratio ${ratio.toFixed(2)}, worst stop ${Math.round(worst)} m) — GTFS shape fallback`
        )
        geometry = gtfsShape.map(([x, y]) => [r6(x), r6(y)] as LonLat)
        geometrySource = "gtfs"
        osmMatched--
        gtfsFallback++
      } else {
        if (ratio < LENGTH_RATIO_BOUNDS[0] || ratio > LENGTH_RATIO_BOUNDS[1]) {
          warn(
            `line ${line.name} dir ${dirStr}: OSM/GTFS length ratio ${ratio.toFixed(2)}`
          )
        }
        if (worst > STOP_TO_LINE_WARN_M) {
          warn(
            `line ${line.name} dir ${dirStr}: stop up to ${Math.round(worst)} m from polyline`
          )
        }
      }
    }

    let dirs = lineDirections.get(line.name)
    if (!dirs) lineDirections.set(line.name, (dirs = []))
    dirs.push({
      id: Number(dirStr),
      headsign,
      stops: modalStops,
      geometry,
      geometrySource,
      shapeId,
    })
  }

  // --- departures per stop (platform) ---
  console.log("Building per-stop departure boards…")
  interface Departure {
    l: string
    d: number
    h: string
    s: string
    t: number
  }
  const stopDepartures = new Map<string, Departure[]>()
  for (const [tripId, seq] of tripStops) {
    const t = trips.get(tripId)
    if (!t) continue
    const line = linesByRouteId.get(t.routeId)
    if (!line) continue
    for (const s of seq) {
      let arr = stopDepartures.get(s.stopId)
      if (!arr) stopDepartures.set(s.stopId, (arr = []))
      arr.push({
        l: line.name,
        d: t.directionId,
        h: t.headsign,
        s: t.serviceId,
        t: s.dep,
      })
    }
  }
  for (const arr of stopDepartures.values()) arr.sort((a, b) => a.t - b.t)

  // --- emit ---
  console.log("Writing public/data…")
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(path.join(OUT_DIR, "routes"), { recursive: true })
  fs.mkdirSync(path.join(OUT_DIR, "stops"), { recursive: true })

  const naturalKey = (name: string) => {
    const n = name.match(/\d+/)
    return [n ? Number(n[0]) : 9999, name] as const
  }
  const allLines = [
    ...new Map([...linesByRouteId.values()].map((l) => [l.name, l])).values(),
  ].sort((a, b) => {
    const ka = naturalKey(a.name)
    const kb = naturalKey(b.name)
    return ka[0] - kb[0] || ka[1].localeCompare(kb[1])
  })

  const feedInfo = feedInfoRows[0] ?? {}
  fs.writeFileSync(
    path.join(OUT_DIR, "routes.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      feedStart: feedInfo.feed_start_date ?? null,
      feedEnd: feedInfo.feed_end_date ?? null,
      lines: allLines.map((l) => ({
        id: l.name,
        type: l.type,
        night: l.night,
        color: l.color,
        textColor: l.textColor,
        note: l.note,
      })),
    })
  )

  // stops.json — platform index with serving lines
  const stopIndex = [...stops.values()]
    .map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      lines: [
        ...new Set((stopDepartures.get(s.id) ?? []).map((d) => d.l)),
      ].sort(),
    }))
    .filter((s) => s.lines.length > 0) // drop stops served by nothing in this feed
  fs.writeFileSync(
    path.join(OUT_DIR, "stops.json"),
    JSON.stringify({ stops: stopIndex })
  )

  // calendar.json
  const services: Record<
    string,
    { days: number[]; start: string; end: string }
  > = {}
  for (const r of calendarRows) {
    services[r.service_id] = {
      days: [
        r.monday,
        r.tuesday,
        r.wednesday,
        r.thursday,
        r.friday,
        r.saturday,
        r.sunday,
      ].map(Number),
      start: r.start_date,
      end: r.end_date,
    }
  }
  const exceptions: Record<string, { added: string[]; removed: string[] }> = {}
  for (const r of calendarDatesRows) {
    const e = (exceptions[r.date] ??= { added: [], removed: [] })
    if (r.exception_type === "1") e.added.push(r.service_id)
    else e.removed.push(r.service_id)
  }
  fs.writeFileSync(
    path.join(OUT_DIR, "calendar.json"),
    JSON.stringify({ services, exceptions })
  )

  // all-routes.geojson — one representative geometry per line (direction 0 preferred)
  const overviewFeatures = allLines
    .map((l) => {
      const dirs = lineDirections.get(l.name)
      if (!dirs?.length) return null
      const dir = dirs.find((d) => d.id === 0) ?? dirs[0]
      return {
        type: "Feature" as const,
        properties: {
          line: l.name,
          type: l.type,
          night: l.night,
          color: `#${l.color}`,
        },
        geometry: { type: "LineString" as const, coordinates: dir.geometry },
      }
    })
    .filter(Boolean)
  fs.writeFileSync(
    path.join(OUT_DIR, "all-routes.geojson"),
    JSON.stringify({ type: "FeatureCollection", features: overviewFeatures })
  )

  // routes/{line}.json
  for (const l of allLines) {
    const dirs = (lineDirections.get(l.name) ?? []).sort((a, b) => a.id - b.id)
    fs.writeFileSync(
      path.join(OUT_DIR, "routes", `${l.name}.json`),
      JSON.stringify({
        id: l.name,
        type: l.type,
        night: l.night,
        color: l.color,
        textColor: l.textColor,
        note: l.note,
        directions: dirs.map((d) => ({
          id: d.id,
          headsign: d.headsign,
          stops: d.stops,
          geometrySource: d.geometrySource,
          geometry: d.geometry,
        })),
      })
    )
  }

  // stops/{id}.json
  for (const [stopId, deps] of stopDepartures) {
    const s = stops.get(stopId)
    if (!s) continue
    fs.writeFileSync(
      path.join(OUT_DIR, "stops", `${stopId}.json`),
      JSON.stringify({ id: s.id, name: s.name, code: s.code, departures: deps })
    )
  }

  // --- summary ---
  const dirCount = [...lineDirections.values()].reduce(
    (n, d) => n + d.length,
    0
  )
  console.log("\n== summary ==")
  console.log(`lines: ${allLines.length}, directions: ${dirCount}`)
  console.log(`geometry: ${osmMatched} OSM, ${gtfsFallback} GTFS fallback`)
  console.log(`stops with service: ${stopIndex.length} of ${stops.size}`)
  console.log(`warnings: ${warnings.length}`)
  if (warnings.length) {
    fs.writeFileSync(
      path.join(OUT_DIR, "build-warnings.json"),
      JSON.stringify(warnings, null, 2)
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
