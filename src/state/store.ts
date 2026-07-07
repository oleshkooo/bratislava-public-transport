import { create } from "zustand"
import type { Feature } from "geojson"
import {
  loadCalendar,
  loadLineDetail,
  loadRoutesIndex,
  loadStopsIndex,
} from "@/lib/data"
import type {
  CalendarData,
  LineDetail,
  RoutesIndex,
  StopIndexEntry,
} from "@/lib/types"

export type TypeTab = "tram" | "trolleybus" | "bus" | "night"

export type View =
  | { kind: "browse" }
  | { kind: "line"; lineId: string; dir: number }
  | { kind: "stop"; stopId: string }
  | { kind: "plan" }

export interface ItineraryOverlay {
  transit: Feature[]
  walk: Feature[]
  coords: [number, number][]
}

/** A trip-planner endpoint: a named stop (all its platforms) or a free point. */
export type PlannerPlace =
  | { kind: "stop"; name: string }
  | { kind: "point"; lon: number; lat: number; label: string }

/** Mobile drawer snap points: peek / half / full. */
export const SNAP_POINTS = [0.18, 0.55, 0.94]

interface AppState {
  booted: boolean
  bootError: string | null
  routesIndex: RoutesIndex | null
  stopsIndex: StopIndexEntry[]
  stopsById: Map<string, StopIndexEntry>
  calendar: CalendarData | null

  view: View
  /** view to return to when closing a stop panel opened from a line */
  prevView: View | null
  lineDetail: LineDetail | null
  typeTab: TypeTab
  showRoutes: boolean
  showStops: boolean
  /** schedule-interpolated vehicle markers on the map (no live feed) */
  showVehicles: boolean
  /** one-shot map focus request from list clicks; ts forces re-trigger for same stop */
  focusStop: { id: string; ts: number } | null
  /** consumed by StopPanel to open a specific tab / line filter */
  stopPanelInit: {
    stopId: string
    tab: "timetable"
    line: string
    dir: number
  } | null

  favorites: { lines: string[]; stops: string[] }
  recents: { lines: string[]; stops: string[] }
  /** selected trip-planner itinerary drawn on the map */
  itineraryOverlay: ItineraryOverlay | null
  /** trip-planner endpoints (survive view switches; MapView draws markers) */
  planFrom: PlannerPlace | null
  planTo: PlannerPlace | null
  /** which planner field the next map tap fills; collapses the mobile drawer */
  mapPick: "from" | "to" | null
  /** planner departure time (in the store so share links can carry it) */
  planTimeMode: "now" | "at"
  planTimeStr: string
  /** mobile drawer snap position (MobileDrawer renders it, actions may pull it up) */
  drawerSnap: number | string | null

  boot: () => Promise<void>
  selectLine: (lineId: string, dir?: number) => void
  setDirection: (dir: number) => void
  selectStop: (stopId: string) => void
  openTimetable: (lineId: string, dir: number, stopId: string) => void
  goPlan: () => void
  setItineraryOverlay: (o: ItineraryOverlay | null) => void
  goBrowse: () => void
  closeStop: () => void
  setTypeTab: (tab: TypeTab) => void
  setShowRoutes: (v: boolean) => void
  setShowStops: (v: boolean) => void
  setShowVehicles: (v: boolean) => void
  focusStopOnMap: (id: string) => void
  toggleFavoriteLine: (id: string) => void
  toggleFavoriteStop: (id: string) => void
  setPlanFrom: (p: PlannerPlace | null) => void
  setPlanTo: (p: PlannerPlace | null) => void
  setMapPick: (t: "from" | "to" | null) => void
  setPlanTime: (mode: "now" | "at", str?: string) => void
  setDrawerSnap: (s: number | string | null) => void
  /** map tap while mapPick is active → fill that planner field */
  pickPlace: (lon: number, lat: number) => void
}

function loadPersisted<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function savePersisted(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage full/blocked — favorites just won't persist
  }
}

function pushRecent(list: string[], id: string, max = 8): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, max)
}

/** Opening content pulls a peeking mobile drawer up to half so it's visible. */
function pulledUp(snap: number | string | null): number | string | null {
  return snap === SNAP_POINTS[0] ? SNAP_POINTS[1] : snap
}

/** `s:<stop name>` or `p:<lat>,<lon>` in the plan hash params. */
function encodePlace(p: PlannerPlace): string {
  return p.kind === "stop"
    ? `s:${p.name}`
    : `p:${p.lat.toFixed(5)},${p.lon.toFixed(5)}`
}

function decodePlace(v: string | null): PlannerPlace | null {
  if (!v) return null
  if (v.startsWith("s:")) return { kind: "stop", name: v.slice(2) }
  if (v.startsWith("p:")) {
    const [lat, lon] = v.slice(2).split(",").map(Number)
    if (Number.isFinite(lat) && Number.isFinite(lon))
      return {
        kind: "point",
        lat,
        lon,
        label: `Pin ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      }
  }
  return null
}

/** #plan&from=…&to=…&at=HH:MM — a shareable link to a planned trip. */
function planHash(s: {
  planFrom: PlannerPlace | null
  planTo: PlannerPlace | null
  planTimeMode: "now" | "at"
  planTimeStr: string
}): string {
  const parts = ["plan"]
  if (s.planFrom)
    parts.push(`from=${encodeURIComponent(encodePlace(s.planFrom))}`)
  if (s.planTo) parts.push(`to=${encodeURIComponent(encodePlace(s.planTo))}`)
  if (s.planTimeMode === "at" && s.planTimeStr)
    parts.push(`at=${s.planTimeStr}`)
  return "#" + parts.join("&")
}

function writeHash(view: View) {
  const hash =
    view.kind === "line"
      ? `#line=${encodeURIComponent(view.lineId)}&dir=${view.dir}`
      : view.kind === "stop"
        ? `#stop=${encodeURIComponent(view.stopId)}`
        : view.kind === "plan"
          ? "#plan"
          : ""
  history.replaceState(null, "", hash || location.pathname + location.search)
}

function parseHash(): View {
  const params = new URLSearchParams(location.hash.slice(1))
  const line = params.get("line")
  if (line)
    return { kind: "line", lineId: line, dir: Number(params.get("dir")) || 0 }
  const stop = params.get("stop")
  if (stop) return { kind: "stop", stopId: stop }
  if (params.has("plan")) return { kind: "plan" }
  return { kind: "browse" }
}

export const useAppStore = create<AppState>((set, get) => ({
  booted: false,
  bootError: null,
  routesIndex: null,
  stopsIndex: [],
  stopsById: new Map(),
  calendar: null,

  view: { kind: "browse" },
  prevView: null,
  lineDetail: null,
  typeTab: "tram",
  showRoutes: true,
  showStops: true,
  showVehicles: false,
  focusStop: null,
  stopPanelInit: null,
  itineraryOverlay: null,

  favorites: loadPersisted("favorites", { lines: [], stops: [] }),
  recents: loadPersisted("recents", { lines: [], stops: [] }),
  planFrom: null,
  planTo: null,
  mapPick: null,
  planTimeMode: "now",
  planTimeStr: "",
  drawerSnap: SNAP_POINTS[1],

  boot: async () => {
    try {
      const [routesIndex, stopsIndex, calendar] = await Promise.all([
        loadRoutesIndex(),
        loadStopsIndex(),
        loadCalendar(),
      ])
      const stopsById = new Map(stopsIndex.map((s) => [s.id, s]))
      set({ booted: true, routesIndex, stopsIndex, stopsById, calendar })

      const initial = parseHash()
      if (initial.kind === "line") get().selectLine(initial.lineId, initial.dir)
      else if (initial.kind === "stop") get().selectStop(initial.stopId)
      else if (initial.kind === "plan") {
        // Share links carry the trip: #plan&from=…&to=…&at=HH:MM
        const params = new URLSearchParams(location.hash.slice(1))
        const at = params.get("at")
        set({
          planFrom: decodePlace(params.get("from")),
          planTo: decodePlace(params.get("to")),
          ...(at && /^\d{1,2}:\d{2}$/.test(at)
            ? { planTimeMode: "at" as const, planTimeStr: at }
            : {}),
        })
        get().goPlan()
      }
    } catch (e) {
      set({ bootError: String(e) })
    }
  },

  selectLine: (lineId, dir = 0) => {
    const line = get().routesIndex?.lines.find((l) => l.id === lineId)
    if (!line) return
    const view: View = { kind: "line", lineId, dir }
    const recents = {
      ...get().recents,
      lines: pushRecent(get().recents.lines, lineId),
    }
    savePersisted("recents", recents)
    set({
      view,
      prevView: null,
      lineDetail: null,
      typeTab: line.night ? "night" : line.type,
      recents,
      drawerSnap: pulledUp(get().drawerSnap),
    })
    writeHash(view)
    loadLineDetail(lineId).then((detail) => {
      const v = get().view
      if (v.kind === "line" && v.lineId === lineId) {
        // Clamp direction to what actually exists (some lines are one-directional)
        if (
          !detail.directions.some((d) => d.id === v.dir) &&
          detail.directions.length > 0
        ) {
          const fixed: View = {
            kind: "line",
            lineId,
            dir: detail.directions[0].id,
          }
          set({ view: fixed, lineDetail: detail })
          writeHash(fixed)
        } else {
          set({ lineDetail: detail })
        }
      }
    })
  },

  setDirection: (dir) => {
    const v = get().view
    if (v.kind !== "line") return
    const view: View = { ...v, dir }
    set({ view })
    writeHash(view)
  },

  selectStop: (stopId) => {
    const cur = get().view
    const view: View = { kind: "stop", stopId }
    const recents = {
      ...get().recents,
      stops: pushRecent(get().recents.stops, stopId),
    }
    savePersisted("recents", recents)
    set({
      view,
      prevView: cur.kind === "stop" ? get().prevView : cur,
      stopPanelInit: null,
      recents,
      drawerSnap: pulledUp(get().drawerSnap),
    })
    writeHash(view)
  },

  openTimetable: (lineId, dir, stopId) => {
    get().selectStop(stopId)
    set({ stopPanelInit: { stopId, tab: "timetable", line: lineId, dir } })
  },

  goPlan: () => {
    set({
      view: { kind: "plan" },
      prevView: null,
      lineDetail: null,
      drawerSnap: pulledUp(get().drawerSnap),
    })
    history.replaceState(null, "", planHash(get()))
  },

  setItineraryOverlay: (itineraryOverlay) => set({ itineraryOverlay }),

  closeStop: () => {
    const prev = get().prevView
    if (prev && prev.kind === "line") {
      // Re-select to restore lineDetail if it was dropped
      const { lineId, dir } = prev
      get().selectLine(lineId, dir)
    } else {
      get().goBrowse()
    }
  },

  goBrowse: () => {
    set({
      view: { kind: "browse" },
      prevView: null,
      lineDetail: null,
      mapPick: null,
    })
    writeHash({ kind: "browse" })
  },

  setTypeTab: (typeTab) => set({ typeTab }),
  setShowRoutes: (showRoutes) => set({ showRoutes }),
  setShowStops: (showStops) => set({ showStops }),
  setShowVehicles: (showVehicles) => set({ showVehicles }),
  focusStopOnMap: (id) => set({ focusStop: { id, ts: Date.now() } }),

  toggleFavoriteLine: (id) => {
    const f = get().favorites
    const lines = f.lines.includes(id)
      ? f.lines.filter((x) => x !== id)
      : [...f.lines, id]
    const favorites = { ...f, lines }
    savePersisted("favorites", favorites)
    set({ favorites })
  },

  toggleFavoriteStop: (id) => {
    const f = get().favorites
    const stops = f.stops.includes(id)
      ? f.stops.filter((x) => x !== id)
      : [...f.stops, id]
    const favorites = { ...f, stops }
    savePersisted("favorites", favorites)
    set({ favorites })
  },

  setPlanFrom: (planFrom) => {
    set({ planFrom })
    if (get().view.kind === "plan")
      history.replaceState(null, "", planHash(get()))
  },
  setPlanTo: (planTo) => {
    set({ planTo })
    if (get().view.kind === "plan")
      history.replaceState(null, "", planHash(get()))
  },
  setMapPick: (mapPick) =>
    // Entering pick mode collapses the drawer so the map is reachable;
    // leaving it (cancel/unmount) touches nothing — pickPlace restores.
    set(mapPick ? { mapPick, drawerSnap: SNAP_POINTS[0] } : { mapPick }),
  setPlanTime: (planTimeMode, planTimeStr) => {
    set({
      planTimeMode,
      ...(planTimeStr !== undefined ? { planTimeStr } : {}),
    })
    if (get().view.kind === "plan")
      history.replaceState(null, "", planHash(get()))
  },
  setDrawerSnap: (drawerSnap) => set({ drawerSnap }),
  pickPlace: (lon, lat) => {
    const which = get().mapPick
    if (!which) return
    const place: PlannerPlace = {
      kind: "point",
      lon,
      lat,
      label: `Pin ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    }
    set({
      mapPick: null,
      drawerSnap: SNAP_POINTS[1],
      ...(which === "from" ? { planFrom: place } : { planTo: place }),
    })
    history.replaceState(null, "", planHash(get()))
  },
}))

if (import.meta.env.DEV) {
  // handy for debugging from the browser console
  ;(window as unknown as Record<string, unknown>).__appStore = useAppStore
}
