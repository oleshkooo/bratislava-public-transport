import type { Feature } from "geojson"
import type { PlannerData } from "@/lib/raptor"
import { haversineM } from "@/lib/geo"

/**
 * Pseudo-realtime vehicle positions: every trip of the schedule is
 * interpolated along its line geometry between the two stops it is currently
 * between. Purely schedule-derived — there is no live feed (yet), which the
 * UI labels honestly.
 */

type LonLat = [number, number]

export interface VehicleContext {
  planner: PlannerData
  /** service activity per planner.services index */
  todayActive: boolean[]
  yesterdayActive: boolean[]
  /** seconds since local midnight (Europe/Bratislava) */
  nowSec: number
  /** planner stop index → coordinates */
  stopCoord: (stopIdx: number) => LonLat | null
  /** direction geometry, or null while it is still loading */
  patternGeom: (line: string, dir: number) => LonLat[] | null
  lineColor: (line: string) => { color: string; textColor: string }
  /** when set, only these lines get vehicles (selected line / itinerary) */
  lineFilter?: ReadonlySet<string> | null
}

const TRIP_TIMES_OFFSET = 2

/** Per-pattern prep: stop coords + their vertex index on the line geometry. */
interface PatternTrack {
  stops: (LonLat | null)[]
  geom: LonLat[] | null
  vIdx: number[] | null
}

const trackCache = new WeakMap<PlannerData, Map<number, PatternTrack>>()

function patternTrack(ctx: VehicleContext, p: number): PatternTrack {
  let byPattern = trackCache.get(ctx.planner)
  if (!byPattern) trackCache.set(ctx.planner, (byPattern = new Map()))
  const cached = byPattern.get(p)
  // rebuild while the geometry hasn't arrived yet; final once it has
  if (cached?.geom) return cached
  const pattern = ctx.planner.patterns[p]
  const stops = pattern.stops.map((s) => ctx.stopCoord(s))
  const geom = ctx.patternGeom(pattern.line, pattern.dir)
  let vIdx: number[] | null = null
  if (geom) {
    vIdx = stops.map((pt) => {
      if (!pt) return -1
      let best = -1
      let bestD = 300
      for (let i = 0; i < geom.length; i++) {
        const d = haversineM(pt[0], pt[1], geom[i][0], geom[i][1])
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      return best
    })
  }
  const track = { stops, geom, vIdx }
  byPattern.set(p, track)
  return track
}

/** Point `frac` of the way along geom[a..b] by distance. */
function alongGeometry(
  geom: LonLat[],
  a: number,
  b: number,
  frac: number
): LonLat {
  let total = 0
  for (let i = a + 1; i <= b; i++)
    total += haversineM(geom[i - 1][0], geom[i - 1][1], geom[i][0], geom[i][1])
  if (total === 0) return geom[a]
  let target = total * frac
  for (let i = a + 1; i <= b; i++) {
    const seg = haversineM(
      geom[i - 1][0],
      geom[i - 1][1],
      geom[i][0],
      geom[i][1]
    )
    if (target <= seg) {
      const t = seg === 0 ? 0 : target / seg
      return [
        geom[i - 1][0] + (geom[i][0] - geom[i - 1][0]) * t,
        geom[i - 1][1] + (geom[i][1] - geom[i - 1][1]) * t,
      ]
    }
    target -= seg
  }
  return geom[b]
}

const lerp = (a: LonLat, b: LonLat, t: number): LonLat => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
]

export function computeVehicles(ctx: VehicleContext): Feature[] {
  const features: Feature[] = []
  const { planner, nowSec } = ctx
  for (let p = 0; p < planner.patterns.length; p++) {
    const pattern = planner.patterns[p]
    if (ctx.lineFilter && !ctx.lineFilter.has(pattern.line)) continue
    const nStops = pattern.stops.length
    let track: PatternTrack | null = null
    for (const trip of pattern.trips) {
      const svc = trip[0]
      for (const offset of [0, -86400]) {
        if (offset === 0 && !ctx.todayActive[svc]) continue
        if (offset === -86400) {
          // yesterday's service running past midnight
          if (!ctx.yesterdayActive[svc]) continue
          if (trip[TRIP_TIMES_OFFSET] < 86400 - 4 * 3600) continue
        }
        const t0 = trip[TRIP_TIMES_OFFSET] + offset
        const tEnd = trip[TRIP_TIMES_OFFSET + nStops - 1] + offset
        if (nowSec < t0 || nowSec > tEnd) continue

        // segment the vehicle is currently on
        let i = 0
        while (
          i + 1 < nStops &&
          trip[TRIP_TIMES_OFFSET + i + 1] + offset < nowSec
        )
          i++
        if (i + 1 >= nStops) continue
        const depA = trip[TRIP_TIMES_OFFSET + i] + offset
        const depB = trip[TRIP_TIMES_OFFSET + i + 1] + offset
        const frac =
          depB > depA
            ? Math.min(1, Math.max(0, (nowSec - depA) / (depB - depA)))
            : 0

        track ??= patternTrack(ctx, p)
        const sa = track.stops[i]
        const sb = track.stops[i + 1]
        if (!sa || !sb) continue
        let pos: LonLat
        const va = track.vIdx?.[i] ?? -1
        const vb = track.vIdx?.[i + 1] ?? -1
        if (track.geom && va !== -1 && vb !== -1 && va < vb) {
          pos = alongGeometry(track.geom, va, vb, frac)
        } else {
          pos = lerp(sa, sb, frac)
        }
        const { color, textColor } = ctx.lineColor(pattern.line)
        features.push({
          type: "Feature",
          properties: { line: pattern.line, color, textColor },
          geometry: { type: "Point", coordinates: pos },
        })
      }
    }
  }
  return features
}
