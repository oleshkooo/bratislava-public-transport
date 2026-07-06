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
  fromStopId: string | null
  toStopId: string
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
  fromStopIds: string[]
  toStopIds: string[]
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
  | { type: "origin" }
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

  const targets = new Set(
    query.toStopIds
      .map((id) => stopIdxById.get(id))
      .filter((x): x is number => x !== undefined)
  )
  let bestTarget = INF

  // Round 0: origin + initial footpaths
  const r0 = new Int32Array(n).fill(INF)
  const p0: Parent[] = new Array(n)
  let marked = new Set<number>()
  for (const id of query.fromStopIds) {
    const s = stopIdxById.get(id)
    if (s === undefined) continue
    r0[s] = query.departSeconds
    p0[s] = { type: "origin" }
    best[s] = query.departSeconds
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
  for (const t of targets) if (best[t] < bestTarget) bestTarget = best[t]

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
            if (targets.has(s) && arr < bestTarget) bestTarget = arr
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
          if (targets.has(to) && t < bestTarget) bestTarget = t
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
    let arrTime = INF
    for (const t of targets) {
      if (rounds[k][t] < arrTime) {
        arrTime = rounds[k][t]
        target = t
      }
    }
    if (target === -1) continue

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
      if (parent.type === "origin") break
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
    itineraries.push({
      legs,
      depart: first.boardTime,
      arrive:
        legs[legs.length - 1].kind === "walk"
          ? last.alightTime + (legs[legs.length - 1] as WalkLeg).seconds
          : last.alightTime,
      transfers: transitLegs.length - 1,
    })
  }

  itineraries.sort((a, b) => a.arrive - b.arrive || a.transfers - b.transfers)
  return itineraries.slice(0, 4)
}
