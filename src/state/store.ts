import { create } from "zustand"
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
  /** one-shot map focus request from list clicks; ts forces re-trigger for same stop */
  focusStop: { id: string; ts: number } | null

  boot: () => Promise<void>
  selectLine: (lineId: string, dir?: number) => void
  setDirection: (dir: number) => void
  selectStop: (stopId: string) => void
  goBrowse: () => void
  closeStop: () => void
  setTypeTab: (tab: TypeTab) => void
  setShowRoutes: (v: boolean) => void
  setShowStops: (v: boolean) => void
  focusStopOnMap: (id: string) => void
}

function writeHash(view: View) {
  const hash =
    view.kind === "line"
      ? `#line=${encodeURIComponent(view.lineId)}&dir=${view.dir}`
      : view.kind === "stop"
        ? `#stop=${encodeURIComponent(view.stopId)}`
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
  focusStop: null,

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
    } catch (e) {
      set({ bootError: String(e) })
    }
  },

  selectLine: (lineId, dir = 0) => {
    const line = get().routesIndex?.lines.find((l) => l.id === lineId)
    if (!line) return
    const view: View = { kind: "line", lineId, dir }
    set({
      view,
      prevView: null,
      lineDetail: null,
      typeTab: line.night ? "night" : line.type,
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
    set({ view, prevView: cur.kind === "stop" ? get().prevView : cur })
    writeHash(view)
  },

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
    set({ view: { kind: "browse" }, prevView: null, lineDetail: null })
    writeHash({ kind: "browse" })
  },

  setTypeTab: (typeTab) => set({ typeTab }),
  setShowRoutes: (showRoutes) => set({ showRoutes }),
  setShowStops: (showStops) => set({ showStops }),
  focusStopOnMap: (id) => set({ focusStop: { id, ts: Date.now() } }),
}))
