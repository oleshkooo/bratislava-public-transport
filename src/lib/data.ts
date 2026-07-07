import type {
  CalendarData,
  LineDetail,
  RoutesIndex,
  StopDetail,
  StopIndexEntry,
} from "./types"

const BASE = `${import.meta.env.BASE_URL}data/`

const cache = new Map<string, Promise<unknown>>()

function fetchJson<T>(path: string): Promise<T> {
  let p = cache.get(path)
  if (!p) {
    p = fetch(BASE + path).then((res) => {
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
      return res.json()
    })
    p.catch(() => cache.delete(path))
    cache.set(path, p)
  }
  return p as Promise<T>
}

export const loadRoutesIndex = () => fetchJson<RoutesIndex>("routes.json")
export const loadStopsIndex = () =>
  fetchJson<{ stops: StopIndexEntry[] }>("stops.json").then((d) => d.stops)
export const loadCalendar = () => fetchJson<CalendarData>("calendar.json")
export const loadLineDetail = (id: string) =>
  fetchJson<LineDetail>(`routes/${encodeURIComponent(id)}.json`)
export const loadStopDetail = (id: string) =>
  fetchJson<StopDetail>(`stops/${encodeURIComponent(id)}.json`)
export const loadPlanner = () =>
  fetchJson<import("./raptor").PlannerData>("planner.json")
export const loadWalkGraphData = () =>
  fetchJson<import("./walk").WalkGraphData>("walk-graph.json")

export const allRoutesGeojsonUrl = `${BASE}all-routes.geojson`
