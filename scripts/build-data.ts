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
/** Stops farther than this from the matched polyline trigger geometry repair
 *  (e.g. GTFS runs a diversion that OSM doesn't have — trams 3/4 "Výluka Centrum"). */
const REPAIR_THRESHOLD_M = 150
/** Polyline ends farther than this from the route's terminus stop get trimmed
 *  back to the closest pass (OSM relations sometimes run past the GTFS terminus —
 *  79 dir 1 continues 3.3 km to Čiližská while GTFS ends at Stn. P. Biskupice). */
const TRIM_TAIL_M = 200
const OVERPASS_RAILS_QUERY = `
[out:json][timeout:120];
way["railway"="tram"](48.0,16.9,48.3,17.3);
out geom;
`

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
      console.warn(
        "  Overpass unavailable — falling back to committed geometry cache"
      )
      return JSON.parse(fs.readFileSync(cachePath, "utf8"))
    }
    throw new Error(
      "All Overpass endpoints failed and no cached geometries exist"
    )
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

// ---------- tram rail network (for geometry repair) ----------

async function loadTramRails(): Promise<LonLat[][]> {
  const cachePath = path.join(DATA_CACHE_DIR, "tram-rails.json")
  const refresh = process.env.OSM_REFRESH === "1"
  if (!refresh && fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"))
  }
  let raw: { elements: Record<string, unknown>[] } | undefined
  const rawCachePath = path.join(CACHE_DIR, "tram-rails-raw.json")
  if (!refresh && fs.existsSync(rawCachePath)) {
    raw = JSON.parse(fs.readFileSync(rawCachePath, "utf8"))
  }
  if (!raw) console.log("Fetching tram rails from Overpass…")
  for (const endpoint of raw ? [] : OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "data=" + encodeURIComponent(OVERPASS_RAILS_QUERY),
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
      console.warn("  Overpass unavailable — using committed tram-rails cache")
      return JSON.parse(fs.readFileSync(cachePath, "utf8"))
    }
    console.warn("  No tram rails available — tram repairs fall back to chords")
    return []
  }
  const ways: LonLat[][] = []
  for (const el of raw.elements) {
    const geometry = el.geometry as { lat: number; lon: number }[] | undefined
    if (!geometry || geometry.length < 2) continue
    ways.push(geometry.map((g) => [r6(g.lon), r6(g.lat)] as LonLat))
  }
  fs.mkdirSync(DATA_CACHE_DIR, { recursive: true })
  fs.writeFileSync(cachePath, JSON.stringify(ways))
  console.log(`  cached ${ways.length} tram rail ways`)
  return ways
}

interface RailGraph {
  nodes: Map<string, LonLat>
  adj: Map<string, [string, number][]>
}

/** ~1.1 m key precision merges near-coincident endpoints into one junction node. */
const railKey = (p: LonLat) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`

function buildRailGraph(ways: LonLat[][]): RailGraph {
  const nodes = new Map<string, LonLat>()
  const adj = new Map<string, [string, number][]>()
  const link = (a: string, b: string, w: number) => {
    let arr = adj.get(a)
    if (!arr) adj.set(a, (arr = []))
    arr.push([b, w])
  }
  for (const way of ways) {
    for (let i = 1; i < way.length; i++) {
      const a = way[i - 1]
      const b = way[i]
      const ka = railKey(a)
      const kb = railKey(b)
      if (ka === kb) continue
      nodes.set(ka, a)
      nodes.set(kb, b)
      const w = haversine(a, b)
      link(ka, kb, w)
      link(kb, ka, w)
    }
  }
  return { nodes, adj }
}

/** Up to k rail nodes within maxM of p, nearest first. Parallel tracks of one
 *  street are separate OSM ways, so the single nearest node can sit on the
 *  opposite-direction track — callers must get alternatives to choose from. */
function nearestRailNodes(
  graph: RailGraph,
  p: LonLat,
  maxM = 120,
  k = 6
): string[] {
  const near: [number, string][] = []
  for (const [key, coord] of graph.nodes) {
    const d = haversine(p, coord)
    if (d < maxM) near.push([d, key])
  }
  near.sort((a, b) => a[0] - b[0])
  return near.slice(0, k).map(([, key]) => key)
}

/** Dijkstra over the rail graph with a small binary heap; one source, many
 *  targets — returns length + reconstructed path for every reachable target. */
function railShortestPaths(
  graph: RailGraph,
  fromKey: string,
  toKeys: string[]
): Map<string, { len: number; path: LonLat[] }> {
  const targets = new Set(toKeys)
  const settled = new Set<string>()
  const dist = new Map<string, number>()
  const prev = new Map<string, string>()
  const heap: [number, string][] = [[0, fromKey]]
  dist.set(fromKey, 0)
  const push = (item: [number, string]) => {
    heap.push(item)
    let i = heap.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (heap[parent][0] <= heap[i][0]) break
      ;[heap[parent], heap[i]] = [heap[i], heap[parent]]
      i = parent
    }
  }
  const pop = (): [number, string] | undefined => {
    if (heap.length === 0) return undefined
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let min = i
        if (l < heap.length && heap[l][0] < heap[min][0]) min = l
        if (r < heap.length && heap[r][0] < heap[min][0]) min = r
        if (min === i) break
        ;[heap[min], heap[i]] = [heap[i], heap[min]]
        i = min
      }
    }
    return top
  }
  while (heap.length > 0) {
    const [d, key] = pop()!
    if (d > (dist.get(key) ?? Infinity)) continue
    if (targets.has(key)) {
      settled.add(key)
      if (settled.size === targets.size) break
    }
    for (const [next, w] of graph.adj.get(key) ?? []) {
      const nd = d + w
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd)
        prev.set(next, key)
        push([nd, next])
      }
    }
  }
  const out = new Map<string, { len: number; path: LonLat[] }>()
  for (const toKey of targets) {
    const len = dist.get(toKey)
    if (len === undefined) continue
    const path: LonLat[] = []
    let cur: string | undefined = toKey
    while (cur) {
      path.unshift(graph.nodes.get(cur)!)
      cur = prev.get(cur)
    }
    out.set(toKey, { len, path })
  }
  return out
}

/**
 * Route consecutive waypoints through the rail network; null if any hop fails.
 * Every waypoint gets several candidate nodes and the combination with the
 * shortest total path wins (DP leg by leg). Snapping each waypoint to its
 * single nearest node instead can land a stop on the opposite-direction track,
 * which forces a there-and-back spur in the spliced geometry.
 */
function railPathThrough(
  graph: RailGraph,
  waypoints: LonLat[]
): LonLat[] | null {
  const candidates = waypoints.map((p) => nearestRailNodes(graph, p))
  if (candidates.some((c) => c.length === 0)) return null
  let chordLen = 0
  for (let i = 1; i < waypoints.length; i++)
    chordLen += haversine(waypoints[i - 1], waypoints[i])

  // len includes waypoint→node attach distances so that, ceteris paribus,
  // the node right next to the stop still beats one farther down the track
  let states = candidates[0].map((key) => ({
    key,
    len: haversine(waypoints[0], graph.nodes.get(key)!),
    path: [graph.nodes.get(key)!],
  }))
  for (let i = 1; i < waypoints.length; i++) {
    const nextStates = candidates[i].map((key) => ({
      key,
      len: Infinity,
      path: [] as LonLat[],
    }))
    for (const s of states) {
      if (!Number.isFinite(s.len)) continue
      const legs = railShortestPaths(graph, s.key, candidates[i])
      for (const ns of nextStates) {
        const leg = legs.get(ns.key)
        if (!leg) continue
        const total =
          s.len + leg.len + haversine(waypoints[i], graph.nodes.get(ns.key)!)
        if (total < ns.len) {
          ns.len = total
          ns.path = [...s.path, ...leg.path.slice(1)]
        }
      }
    }
    states = nextStates
  }
  const best = states.reduce((a, b) => (b.len < a.len ? b : a))
  if (!Number.isFinite(best.len)) return null
  if (polylineLength(best.path) > chordLen * 3 + 500) return null // suspicious detour
  return best.path
}

const nearestVertexIdx = (coords: LonLat[], p: LonLat): number => {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < coords.length; i++) {
    const d = haversine(p, coords[i])
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * Cut polyline ends that run past the route's termini. Only ends farther than
 * TRIM_TAIL_M from the first/last stop are touched, cut at the polyline's
 * closest pass by that stop (ties resolved toward keeping more route). The trim
 * is reverted if it moves any stop away from the line — that guards loop-shaped
 * routes where first and last stop share a location.
 */
function trimToTermini(
  geometry: LonLat[],
  stopPts: { pt: LonLat; name: string }[]
): LonLat[] {
  if (geometry.length < 2 || stopPts.length < 2) return geometry
  const firstPt = stopPts[0].pt
  const lastPt = stopPts[stopPts.length - 1].pt
  let start = 0
  let end = geometry.length - 1
  if (haversine(firstPt, geometry[0]) > TRIM_TAIL_M) {
    const dists = geometry.map((v) => haversine(firstPt, v))
    const min = Math.min(...dists)
    start = dists.findIndex((d) => d <= min + 25)
  }
  if (haversine(lastPt, geometry[end]) > TRIM_TAIL_M) {
    const dists = geometry.map((v) => haversine(lastPt, v))
    const min = Math.min(...dists)
    for (let i = dists.length - 1; i >= 0; i--) {
      if (dists[i] <= min + 25) {
        end = i
        break
      }
    }
  }
  if (start === 0 && end === geometry.length - 1) return geometry
  if (end - start < 2) return geometry // degenerate cut — leave as is
  const trimmed = geometry.slice(start, end + 1)
  for (const s of stopPts) {
    if (pointToPolylineM(s.pt, trimmed) > pointToPolylineM(s.pt, geometry) + 1)
      return geometry
  }
  return trimmed
}

/**
 * Splice off-route stops into the polyline: for every run of consecutive stops
 * farther than REPAIR_THRESHOLD_M, replace the segment between the surrounding
 * on-route anchors with a path through those stops — via the tram rail network
 * when available, else straight chords.
 */
function repairGeometry(
  geometry: LonLat[],
  stopPts: { pt: LonLat; name: string }[],
  railGraph: RailGraph | null
): { geometry: LonLat[]; repairedStops: string[]; usedRails: boolean } {
  const repairedStops: string[] = []
  let usedRails = false
  for (let iter = 0; iter < 6; iter++) {
    const dists = stopPts.map((s) => pointToPolylineM(s.pt, geometry))
    const start = dists.findIndex((d) => d > REPAIR_THRESHOLD_M)
    if (start === -1) break
    let end = start
    while (end + 1 < stopPts.length && dists[end + 1] > REPAIR_THRESHOLD_M)
      end++

    const anchorA = start - 1 >= 0 ? stopPts[start - 1].pt : geometry[0]
    const anchorB =
      end + 1 < stopPts.length
        ? stopPts[end + 1].pt
        : geometry[geometry.length - 1]
    const iA = nearestVertexIdx(geometry, anchorA)
    const iB = nearestVertexIdx(geometry, anchorB)
    if (iA >= iB) break // can't splice safely (looped/reversed) — leave as is

    const run = stopPts.slice(start, end + 1)
    const waypoints: LonLat[] = [
      geometry[iA],
      ...run.map((s) => s.pt),
      geometry[iB],
    ]
    let insert: LonLat[] | null = null
    if (railGraph) {
      insert = railPathThrough(railGraph, waypoints)
      if (insert) usedRails = true
    }
    if (!insert) insert = waypoints
    geometry = [...geometry.slice(0, iA), ...insert, ...geometry.slice(iB + 1)]
    repairedStops.push(...run.map((s) => s.name))
  }
  return { geometry, repairedStops, usedRails }
}

// ---------- pedestrian graph (walking legs in the trip planner) ----------

/** Stops bbox + ~900 m margin (S,W,N,E) — recompute if the network grows. */
const WALK_BBOX = "48.0137,16.9623,48.2495,17.2393"
const OVERPASS_WALK_QUERY = `
[out:json][timeout:600];
way["highway"~"^(footway|path|pedestrian|steps|living_street|residential|service|track|cycleway|unclassified|tertiary|secondary|primary|tertiary_link|secondary_link|primary_link|corridor|bridleway|road)$"]["foot"!~"^(no|private)$"]["access"!~"^(no|private)$"](${WALK_BBOX});
out geom;
`
/** Simplification tolerance for drawn shape; edge lengths use the raw shape. */
const WALK_SIMPLIFY_M = 6

const r5 = (n: number) => Math.round(n * 1e5) / 1e5
/** ~1.1 m key precision merges shared OSM nodes (and near-touching ends). */
const walkKey = (p: LonLat) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`

/** Flat compact graph the client routes over: nodes [lon,lat,…], edges [a,b,m,…]. */
interface WalkGraphOut {
  nodes: number[]
  edges: number[]
}

/**
 * Keep way endpoints + required interior points (junctions), then
 * Douglas-Peucker the spans in between. Returns kept indices, ascending.
 */
function simplifyIndices(
  coords: LonLat[],
  requiredIdx: number[],
  tolM: number
): number[] {
  const keep = new Array<boolean>(coords.length).fill(false)
  keep[0] = true
  keep[coords.length - 1] = true
  for (const i of requiredIdx) keep[i] = true
  const kx = 111320 * Math.cos((coords[0][1] * Math.PI) / 180)
  const ky = 110574
  const dp = (a: number, b: number) => {
    if (b - a < 2) return
    const ax = coords[a][0] * kx
    const ay = coords[a][1] * ky
    const bx = coords[b][0] * kx
    const by = coords[b][1] * ky
    const dx = bx - ax
    const dy = by - ay
    const l2 = dx * dx + dy * dy
    let worst = -1
    let worstD = tolM
    for (let i = a + 1; i < b; i++) {
      const px = coords[i][0] * kx
      const py = coords[i][1] * ky
      let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2
      t = Math.max(0, Math.min(1, t))
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
      if (d > worstD) {
        worstD = d
        worst = i
      }
    }
    if (worst !== -1) {
      keep[worst] = true
      dp(a, worst)
      dp(worst, b)
    }
  }
  let prev = 0
  for (let i = 1; i < coords.length; i++) {
    if (keep[i]) {
      dp(prev, i)
      prev = i
    }
  }
  const out: number[] = []
  for (let i = 0; i < coords.length; i++) if (keep[i]) out.push(i)
  return out
}

function buildWalkGraphData(ways: LonLat[][]): WalkGraphOut {
  // Points seen more than once across all ways are junctions the
  // simplification must never drop, or crossings would disconnect.
  const usage = new Map<string, number>()
  for (const way of ways) {
    for (const p of way) {
      const k = walkKey(p)
      usage.set(k, (usage.get(k) ?? 0) + 1)
    }
  }
  const nodeIdx = new Map<string, number>()
  const nodes: number[] = []
  const nodeAt = (p: LonLat): number => {
    const k = walkKey(p)
    let idx = nodeIdx.get(k)
    if (idx === undefined) {
      idx = nodes.length / 2
      nodeIdx.set(k, idx)
      nodes.push(r5(p[0]), r5(p[1]))
    }
    return idx
  }
  const edges: number[] = []
  const edgeSeen = new Set<string>()
  for (const way of ways) {
    if (way.length < 2) continue
    const requiredIdx: number[] = []
    for (let i = 1; i < way.length - 1; i++) {
      if ((usage.get(walkKey(way[i])) ?? 0) >= 2) requiredIdx.push(i)
    }
    const kept = simplifyIndices(way, requiredIdx, WALK_SIMPLIFY_M)
    for (let j = 1; j < kept.length; j++) {
      const a = kept[j - 1]
      const b = kept[j]
      let len = 0
      for (let i = a + 1; i <= b; i++) len += haversine(way[i - 1], way[i])
      const na = nodeAt(way[a])
      const nb = nodeAt(way[b])
      if (na === nb || len < 0.5) continue
      const ek = na < nb ? `${na}_${nb}` : `${nb}_${na}`
      if (edgeSeen.has(ek)) continue
      edgeSeen.add(ek)
      edges.push(na, nb, Math.round(len))
    }
  }
  return { nodes, edges }
}

/** Compact pedestrian graph; null (with a warning) when no source is available. */
async function loadWalkGraph(): Promise<WalkGraphOut | null> {
  const cachePath = path.join(DATA_CACHE_DIR, "walk-graph.json")
  const refresh = process.env.OSM_REFRESH === "1"
  if (!refresh && fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"))
  }
  let raw: { elements: Record<string, unknown>[] } | undefined
  const rawCachePath = path.join(CACHE_DIR, "walk-raw.json")
  if (!refresh && fs.existsSync(rawCachePath)) {
    raw = JSON.parse(fs.readFileSync(rawCachePath, "utf8"))
  }
  if (!raw) console.log("Fetching walkable ways from Overpass…")
  for (const endpoint of raw ? [] : OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "data=" + encodeURIComponent(OVERPASS_WALK_QUERY),
        signal: AbortSignal.timeout(600_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      raw = JSON.parse(text) as typeof raw
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      fs.writeFileSync(rawCachePath, text)
      break
    } catch (e) {
      console.warn(`  Overpass ${endpoint} failed: ${e}`)
    }
  }
  if (!raw) {
    if (fs.existsSync(cachePath)) {
      console.warn("  Overpass unavailable — using committed walk-graph cache")
      return JSON.parse(fs.readFileSync(cachePath, "utf8"))
    }
    warn("no walk graph source — planner walking legs stay straight lines")
    return null
  }
  const ways: LonLat[][] = []
  for (const el of raw.elements) {
    const geometry = el.geometry as { lat: number; lon: number }[] | undefined
    if (!geometry || geometry.length < 2) continue
    ways.push(geometry.map((g) => [g.lon, g.lat] as LonLat))
  }
  const graph = buildWalkGraphData(ways)
  fs.mkdirSync(DATA_CACHE_DIR, { recursive: true })
  fs.writeFileSync(cachePath, JSON.stringify(graph))
  console.log(
    `  walk graph: ${graph.nodes.length / 2} nodes, ${graph.edges.length / 3} edges`
  )
  return graph
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

  const tramRails = await loadTramRails()
  const railGraph = tramRails.length > 0 ? buildRailGraph(tramRails) : null

  let osmMatched = 0
  let gtfsFallback = 0
  let repaired = 0

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

    // Among candidates whose termini roughly match, pick the one whose polyline
    // passes closest to the actual stops (mean distance) — termini alone can't
    // distinguish normal vs diversion variants that share endpoints.
    const modalStopPts = modalStops
      .map((sid) => stops.get(sid))
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map((s) => ({ pt: [s.lon, s.lat] as LonLat, name: s.name }))
    const shapeLen = polylineLength(
      shapes.get(trips.get(modal.tripId)!.shapeId) ?? []
    )
    let bestGeom: OsmGeometry | undefined
    let bestScore = Infinity
    let bestMean = Infinity
    for (const g of candidates) {
      const terminiScore =
        haversine(firstPt, g.coords[0]) +
        haversine(lastPt, g.coords[g.coords.length - 1])
      if (terminiScore >= MATCH_REJECT_M) continue
      // A round-trip/variant relation passes near every stop too — reject by
      // length before comparing stop proximity.
      if (shapeLen > 0) {
        const lenRatio = polylineLength(g.coords) / shapeLen
        if (lenRatio > 2 || lenRatio < 0.6) continue
      }
      const mean =
        modalStopPts.reduce(
          (sum, s) => sum + pointToPolylineM(s.pt, g.coords),
          0
        ) / Math.max(1, modalStopPts.length)
      if (mean < bestMean) {
        bestMean = mean
        bestScore = terminiScore
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
      const untrimmed = geometry
      geometry = trimToTermini(geometry, modalStopPts)
      if (geometry !== untrimmed) {
        warn(
          `line ${line.name} dir ${dirStr}: trimmed OSM polyline past the ` +
            `termini (${Math.round(polylineLength(untrimmed) - polylineLength(geometry))} m cut)`
        )
      }
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
        if (worst > REPAIR_THRESHOLD_M) {
          // GTFS runs where OSM doesn't (diversion) — splice those stops in
          const repair = repairGeometry(
            geometry,
            modalStopPts,
            line.type === "tram" ? railGraph : null
          )
          geometry = repair.geometry.map(([x, y]) => [r6(x), r6(y)] as LonLat)
          repaired++
          warn(
            `line ${line.name} dir ${dirStr}: repaired geometry through ` +
              `${[...new Set(repair.repairedStops)].join(", ")} ` +
              `(${repair.usedRails ? "via tram tracks" : "straight splice"})`
          )
          // A spliced terminus (151's Česká) only lands on the line now —
          // re-trim so the polyline doesn't reach back past it.
          geometry = trimToTermini(geometry, modalStopPts)
        } else if (worst > STOP_TO_LINE_WARN_M) {
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

  // --- planner dataset (RAPTOR over full timetable) ---
  console.log("Building planner dataset…")
  const stopIdxById = new Map<string, number>()
  const stopIdList: string[] = []
  const stopIdx = (id: string) => {
    let i = stopIdxById.get(id)
    if (i === undefined) {
      i = stopIdList.length
      stopIdxById.set(id, i)
      stopIdList.push(id)
    }
    return i
  }
  const serviceIdxById = new Map<string, number>()
  const serviceIdList: string[] = []
  const serviceIdx = (id: string) => {
    let i = serviceIdxById.get(id)
    if (i === undefined) {
      i = serviceIdList.length
      serviceIdxById.set(id, i)
      serviceIdList.push(id)
    }
    return i
  }

  interface PlannerPattern {
    line: string
    dir: number
    stops: number[]
    /** each trip: [serviceIdx, headsignIdx, t0, t1, …] departure seconds per stop */
    trips: number[][]
  }
  const patternByKey = new Map<string, PlannerPattern>()
  const headsigns: string[] = []
  const headsignIdxByText = new Map<string, number>()
  const headsignIdx = (h: string) => {
    let i = headsignIdxByText.get(h)
    if (i === undefined) {
      i = headsigns.length
      headsignIdxByText.set(h, i)
      headsigns.push(h)
    }
    return i
  }

  for (const [tripId, seq] of tripStops) {
    const t = trips.get(tripId)
    if (!t) continue
    const line = linesByRouteId.get(t.routeId)
    if (!line || seq.length < 2) continue
    const sig = seq.map((s) => s.stopId).join("|")
    const key = `${t.routeId}|${t.directionId}|${sig}`
    let pattern = patternByKey.get(key)
    if (!pattern) {
      pattern = {
        line: line.name,
        dir: t.directionId,
        stops: seq.map((s) => stopIdx(s.stopId)),
        trips: [],
      }
      patternByKey.set(key, pattern)
    }
    pattern.trips.push([
      serviceIdx(t.serviceId),
      headsignIdx(t.headsign),
      ...seq.map((s) => s.dep),
    ])
  }
  for (const p of patternByKey.values()) {
    p.trips.sort((a, b) => a[2] - b[2])
  }

  // Footpath transfers between platforms within walking distance.
  // Grid hash keeps the pairwise scan local.
  const WALK_RADIUS_M = 250
  const WALK_SPEED = 1.3 // m/s
  const MAX_TRANSFERS_PER_STOP = 8
  const servedStops = [...stopDepartures.keys()]
    .map((id) => stops.get(id))
    .filter((s): s is NonNullable<typeof s> => !!s)
  const cell = (lon: number, lat: number) =>
    `${Math.floor(lon / 0.003)}|${Math.floor(lat / 0.003)}`
  const grid = new Map<string, typeof servedStops>()
  for (const s of servedStops) {
    const key = cell(s.lon, s.lat)
    let arr = grid.get(key)
    if (!arr) grid.set(key, (arr = []))
    arr.push(s)
  }
  const transfers: [number, number, number][] = []
  for (const s of servedStops) {
    const candidates: { idx: number; sec: number }[] = []
    const cx = Math.floor(s.lon / 0.003)
    const cy = Math.floor(s.lat / 0.003)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const o of grid.get(`${cx + dx}|${cy + dy}`) ?? []) {
          if (o.id === s.id) continue
          const d = haversine([s.lon, s.lat], [o.lon, o.lat])
          if (d <= WALK_RADIUS_M) {
            // Same-name platforms are the same physical stop: minimal penalty
            const sec = o.name === s.name ? 45 : Math.round(d / WALK_SPEED) + 30
            candidates.push({ idx: stopIdx(o.id), sec })
          }
        }
      }
    }
    candidates.sort((a, b) => a.sec - b.sec)
    for (const c of candidates.slice(0, MAX_TRANSFERS_PER_STOP)) {
      transfers.push([stopIdx(s.id), c.idx, c.sec])
    }
  }

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

  // planner.json — compact timetable for client-side RAPTOR
  fs.writeFileSync(
    path.join(OUT_DIR, "planner.json"),
    JSON.stringify({
      stops: stopIdList,
      services: serviceIdList,
      headsigns,
      patterns: [...patternByKey.values()],
      transfers,
    })
  )

  // walk-graph.json — pedestrian network for routed walking legs
  const walkGraph = await loadWalkGraph()
  if (walkGraph) {
    fs.writeFileSync(
      path.join(OUT_DIR, "walk-graph.json"),
      JSON.stringify(walkGraph)
    )
  }

  // --- summary ---
  const dirCount = [...lineDirections.values()].reduce(
    (n, d) => n + d.length,
    0
  )
  console.log("\n== summary ==")
  console.log(`lines: ${allLines.length}, directions: ${dirCount}`)
  console.log(
    `geometry: ${osmMatched} OSM (${repaired} repaired), ${gtfsFallback} GTFS fallback`
  )
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
