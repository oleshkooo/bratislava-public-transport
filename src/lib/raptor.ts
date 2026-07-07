import type { CalendarData } from "./types"
import { activeServiceIds, previousDateKey } from "./service-day"

/**
 * Client-side RAPTOR (round-based public transit routing) over the compact
 * planner dataset. Service-day aware: trips of yesterday's service running
 * past midnight (times >= 24:00) are considered with a -24 h offset.
 */

export interface PlannerData {
  stops: string[]
  services: string[]
  headsigns: string[]
  patterns: {
    line: string
    dir: number
    stops: number[]
    /** [serviceIdx, headsignIdx, t0, t1, …] */
    trips: number[][]
  }[]
  transfers: [number, number, number][]
}

export interface TransitLeg {
  kind: "transit"
  line: string
  dir: number
  headsign: string
  stopIds: string[]
  boardTime: number
  alightTime: number
}

export interface WalkLeg {
  kind: "walk"
  /** null = the origin point (access walk) */
  fromStopId: string | null
  /** null = the destination point (egress walk) */
  toStopId: string | null
  seconds: number
}

export type Leg = TransitLeg | WalkLeg

export interface Itinerary {
  legs: Leg[]
  depart: number
  arrive: number
  transfers: number
}

export interface PlanQuery {
  /** candidate boarding stops with the walk time from the origin (0 = at the stop) */
  sources: { stopId: string; walkSeconds: number }[]
  /** candidate alighting stops with the walk time to the destination */
  targets: { stopId: string; walkSeconds: number }[]
  /** seconds since local midnight (today) */
  departSeconds: number
  /** YYYYMMDD of "today" */
  dateKey: string
}

const INF = 0x7fffffff
const MAX_ROUNDS = 5
const BOARD_SLACK = 30
const TRIP_TIMES_OFFSET = 2 // trips[i] = [serviceIdx, headsignIdx, t0, …]

type Parent =
  | { type: "origin"; walkSeconds: number }
  | {
      type: "trip"
      patternIdx: number
      tripIdx: number
      offset: number
      boardPos: number
      alightPos: number
    }
  | { type: "walk"; fromStop: number; seconds: number }

interface Indexed {
  patternsByStop: Map<number, { p: number; pos: number }[]>
  transfersByStop: Map<number, [number, number][]>
  stopIdxById: Map<string, number>
}

const indexCache = new WeakMap<PlannerData, Indexed>()

function buildIndex(data: PlannerData): Indexed {
  let idx = indexCache.get(data)
  if (idx) return idx
  const patternsByStop = new Map<number, { p: number; pos: number }[]>()
  data.patterns.forEach((pattern, p) => {
    pattern.stops.forEach((s, pos) => {
      let arr = patternsByStop.get(s)
      if (!arr) patternsByStop.set(s, (arr = []))
      arr.push({ p, pos })
    })
  })
  const transfersByStop = new Map<number, [number, number][]>()
  for (const [from, to, sec] of data.transfers) {
    let arr = transfersByStop.get(from)
    if (!arr) transfersByStop.set(from, (arr = []))
    arr.push([to, sec])
  }
  const stopIdxById = new Map(data.stops.map((id, i) => [id, i]))
  idx = { patternsByStop, transfersByStop, stopIdxById }
  indexCache.set(data, idx)
  return idx
}

export function planTrips(
  data: PlannerData,
  calendar: CalendarData,
  query: PlanQuery
): Itinerary[] {
  const { patternsByStop, transfersByStop, stopIdxById } = buildIndex(data)
  const n = data.stops.length

  const todayServices = activeServiceIds(calendar, query.dateKey)
  const yesterdayServices = activeServiceIds(
    calendar,
    previousDateKey(query.dateKey)
  )
  const todayActive = data.services.map((id) => todayServices.has(id))
  const yesterdayActive = data.services.map((id) => yesterdayServices.has(id))

  const best = new Int32Array(n).fill(INF)
  const rounds: Int32Array[] = []
  const parents: Parent[][] = []

  // Egress walk per target stop; bestTarget tracks the best FINAL arrival
  // (stop arrival + egress walk), so pruning on stop arrival stays safe.
  const egress = new Map<number, number>()
  for (const { stopId, walkSeconds } of query.targets) {
    const t = stopIdxById.get(stopId)
    if (t === undefined) continue
    const cur = egress.get(t)
    if (cur === undefined || walkSeconds < cur) egress.set(t, walkSeconds)
  }
  let bestTarget = INF
  const noteTarget = (s: number, arr: number) => {
    const eg = egress.get(s)
    if (eg !== undefined && arr + eg < bestTarget) bestTarget = arr + eg
  }

  // Round 0: origin (+ access walks) + initial footpaths
  const r0 = new Int32Array(n).fill(INF)
  const p0: Parent[] = new Array(n)
  let marked = new Set<number>()
  for (const { stopId, walkSeconds } of query.sources) {
    const s = stopIdxById.get(stopId)
    if (s === undefined) continue
    const t = query.departSeconds + walkSeconds
    if (t >= r0[s]) continue
    r0[s] = t
    p0[s] = { type: "origin", walkSeconds }
    best[s] = t
    marked.add(s)
  }
  for (const s of [...marked]) {
    for (const [to, sec] of transfersByStop.get(s) ?? []) {
      const t = r0[s] + sec
      if (t < r0[to] && t < best[to]) {
        r0[to] = t
        best[to] = t
        p0[to] = { type: "walk", fromStop: s, seconds: sec }
        marked.add(to)
      }
    }
  }
  rounds.push(r0)
  parents.push(p0)
  for (const s of marked) noteTarget(s, r0[s])

  for (let k = 1; k <= MAX_ROUNDS && marked.size > 0; k++) {
    const prev = rounds[k - 1]
    const cur = new Int32Array(n).fill(INF)
    const par: Parent[] = new Array(n)
    const nextMarked = new Set<number>()

    // Patterns touched by marked stops, with the earliest marked position
    const queue = new Map<number, number>()
    for (const s of marked) {
      for (const { p, pos } of patternsByStop.get(s) ?? []) {
        const existing = queue.get(p)
        if (existing === undefined || pos < existing) queue.set(p, pos)
      }
    }

    for (const [p, startPos] of queue) {
      const pattern = data.patterns[p]
      const stopsArr = pattern.stops
      let boarded: {
        tripIdx: number
        offset: number
        boardPos: number
      } | null = null
      for (let i = startPos; i < stopsArr.length; i++) {
        const s = stopsArr[i]

        if (boarded) {
          const trip = pattern.trips[boarded.tripIdx]
          const arr = trip[TRIP_TIMES_OFFSET + i] + boarded.offset
          if (arr < best[s] && arr < bestTarget) {
            cur[s] = arr
            best[s] = arr
            par[s] = {
              type: "trip",
              patternIdx: p,
              tripIdx: boarded.tripIdx,
              offset: boarded.offset,
              boardPos: boarded.boardPos,
              alightPos: i,
            }
            nextMarked.add(s)
            noteTarget(s, arr)
          }
        }

        // Can we catch an earlier trip here?
        const reach = prev[s]
        if (reach === INF) continue
        const ready = reach + BOARD_SLACK
        let bestDep = boarded
          ? pattern.trips[boarded.tripIdx][TRIP_TIMES_OFFSET + i] +
            boarded.offset
          : INF
        for (let ti = 0; ti < pattern.trips.length; ti++) {
          const trip = pattern.trips[ti]
          const svc = trip[0]
          const raw = trip[TRIP_TIMES_OFFSET + i]
          // today's service day
          if (todayActive[svc]) {
            const dep = raw
            if (dep >= ready && dep < bestDep) {
              boarded = { tripIdx: ti, offset: 0, boardPos: i }
              bestDep = dep
            }
          }
          // yesterday's service day spilling past midnight
          if (yesterdayActive[svc] && raw >= 86400) {
            const dep = raw - 86400
            if (dep >= ready && dep < bestDep) {
              boarded = { tripIdx: ti, offset: -86400, boardPos: i }
              bestDep = dep
            }
          }
        }
      }
    }

    // Footpaths from stops improved this round
    for (const s of [...nextMarked]) {
      for (const [to, sec] of transfersByStop.get(s) ?? []) {
        const t = cur[s] + sec
        if (t < best[to] && t < bestTarget + 1 && t < cur[to]) {
          cur[to] = t
          best[to] = t
          par[to] = { type: "walk", fromStop: s, seconds: sec }
          nextMarked.add(to)
          noteTarget(to, t)
        }
      }
    }

    rounds.push(cur)
    parents.push(par)
    marked = nextMarked
  }

  // Reconstruct the best journey per round (pareto: fewer transfers vs faster)
  const itineraries: Itinerary[] = []
  const seen = new Set<string>()
  for (let k = 1; k < rounds.length; k++) {
    let target = -1
    let finalArr = INF
    for (const [t, eg] of egress) {
      const a = rounds[k][t]
      if (a < INF && a + eg < finalArr) {
        finalArr = a + eg
        target = t
      }
    }
    if (target === -1) continue
    const egressSeconds = egress.get(target)!

    const legs: Leg[] = []
    let stop = target
    let round = k
    let guard = 0
    let ok = true
    while (guard++ < 50) {
      const parent = parents[round]?.[stop]
      if (!parent) {
        ok = false
        break
      }
      if (parent.type === "origin") {
        if (parent.walkSeconds > 0) {
          legs.unshift({
            kind: "walk",
            fromStopId: null,
            toStopId: data.stops[stop],
            seconds: parent.walkSeconds,
          })
        }
        break
      }
      if (parent.type === "walk") {
        legs.unshift({
          kind: "walk",
          fromStopId: data.stops[parent.fromStop],
          toStopId: data.stops[stop],
          seconds: parent.seconds,
        })
        stop = parent.fromStop
        continue
      }
      const pattern = data.patterns[parent.patternIdx]
      const trip = pattern.trips[parent.tripIdx]
      legs.unshift({
        kind: "transit",
        line: pattern.line,
        dir: pattern.dir,
        headsign: data.headsigns[trip[1]],
        stopIds: pattern.stops
          .slice(parent.boardPos, parent.alightPos + 1)
          .map((s) => data.stops[s]),
        boardTime: trip[TRIP_TIMES_OFFSET + parent.boardPos] + parent.offset,
        alightTime: trip[TRIP_TIMES_OFFSET + parent.alightPos] + parent.offset,
      })
      stop = pattern.stops[parent.boardPos]
      round -= 1
    }
    if (!ok) continue
    if (egressSeconds > 0) {
      legs.push({
        kind: "walk",
        fromStopId: data.stops[target],
        toStopId: null,
        seconds: egressSeconds,
      })
    }

    // Merge back-to-back walks (access walk + platform transfer, etc.) into
    // one leg — "walk 2 min to X, walk 1 min to X" reads as nonsense.
    for (let i = legs.length - 1; i > 0; i--) {
      const prev = legs[i - 1]
      const cur = legs[i]
      if (prev.kind === "walk" && cur.kind === "walk") {
        prev.seconds += cur.seconds
        prev.toStopId = cur.toStopId
        legs.splice(i, 1)
      }
    }

    const transitLegs = legs.filter((l) => l.kind === "transit")
    if (transitLegs.length === 0) continue
    const key = legs
      .map((l) =>
        l.kind === "transit" ? `${l.line}@${l.boardTime}` : `w${l.toStopId}`
      )
      .join(">")
    if (seen.has(key)) continue
    seen.add(key)

    const first = transitLegs[0] as TransitLeg
    const last = transitLegs[transitLegs.length - 1] as TransitLeg
    // depart = when to leave the origin (board time minus walks before boarding)
    let preWalk = 0
    for (const l of legs) {
      if (l.kind === "transit") break
      preWalk += l.seconds
    }
    let postWalk = 0
    for (let i = legs.length - 1; i >= 0; i--) {
      const l = legs[i]
      if (l.kind === "transit") break
      postWalk += l.seconds
    }
    itineraries.push({
      legs,
      depart: first.boardTime - preWalk,
      arrive: last.alightTime + postWalk,
      transfers: transitLegs.length - 1,
    })
  }

  itineraries.sort((a, b) => a.arrive - b.arrive || a.transfers - b.transfers)
  return itineraries.slice(0, 4)
}
