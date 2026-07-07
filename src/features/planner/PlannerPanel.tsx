import { useEffect, useMemo, useRef, useState } from "react"
import type { Feature } from "geojson"
import {
  ArrowLeft,
  ArrowUpDown,
  Check,
  Footprints,
  LoaderCircle,
  LocateFixed,
  MapPin,
  MapPinned,
  MoveRight,
  Search,
  Share2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { loadLineDetail, loadPlanner } from "@/lib/data"
import { bratislavaNow, formatClock } from "@/lib/service-day"
import {
  planTrips,
  type Itinerary,
  type PlannerData,
  type TransitLeg,
} from "@/lib/raptor"
import { haversineM, placeCoords } from "@/lib/geo"
import { ensureWalkGraph, walkRoute } from "@/lib/walk"
import type { StopIndexEntry } from "@/lib/types"
import { SNAP_POINTS, useAppStore, type PlannerPlace } from "@/state/store"
import { LineChip } from "@/features/lines/LineChip"
import { cn } from "@/lib/utils"

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")

// Walking model: same speed as the build script's footpaths, plus a detour
// factor because access/egress distances are straight-line.
const WALK_SPEED = 1.3 // m/s
const WALK_DETOUR = 1.25
/** Stops within this radius of a point are boarding/alighting candidates. */
const ACCESS_RADIUS_M = 600
const MAX_ACCESS_STOPS = 8
/** If nothing is within the radius, still try the 3 nearest stops up to here. */
const FALLBACK_MAX_M = 3000
/** Offer a pure-walk itinerary when the places are this close. */
const WALK_ONLY_MAX_M = 2500

const walkSeconds = (meters: number) =>
  Math.round((meters * WALK_DETOUR) / WALK_SPEED)

/** Boarding/alighting candidates with access-walk times for a planner place. */
function endCandidates(
  place: PlannerPlace,
  stopsIndex: StopIndexEntry[]
): { stopId: string; walkSeconds: number }[] {
  if (place.kind === "stop") {
    return stopsIndex
      .filter((s) => s.name === place.name)
      .map((s) => ({ stopId: s.id, walkSeconds: 0 }))
  }
  const byDist = stopsIndex
    .map((s) => ({
      id: s.id,
      d: haversineM(place.lon, place.lat, s.lon, s.lat),
    }))
    .sort((a, b) => a.d - b.d)
  const within = byDist
    .filter((c) => c.d <= ACCESS_RADIUS_M)
    .slice(0, MAX_ACCESS_STOPS)
  const chosen =
    within.length > 0
      ? within
      : byDist.slice(0, 3).filter((c) => c.d <= FALLBACK_MAX_M)
  return chosen.map((c) => ({ stopId: c.id, walkSeconds: walkSeconds(c.d) }))
}

function PlaceField({
  label,
  value,
  onChange,
  names,
  onPickOnMap,
}: {
  label: string
  value: PlannerPlace | null
  onChange: (p: PlannerPlace | null) => void
  names: string[]
  onPickOnMap: () => void
}) {
  const text = value ? (value.kind === "stop" ? value.name : value.label) : ""
  // While editing the input shows the draft; otherwise the value's label wins,
  // so external changes (swap, map pick, my location) show up without a sync.
  const [query, setQuery] = useState(text)
  const [editing, setEditing] = useState(false)
  const shown = editing ? query : value ? text : query
  const [open, setOpen] = useState(false)
  const [locating, setLocating] = useState(false)
  const [geoError, setGeoError] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  const matches = useMemo(() => {
    const q = fold(query.trim())
    if (!q) return []
    return names.filter((n) => fold(n).includes(q)).slice(0, 6)
  }, [query, names])

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setGeoError(true)
      return
    }
    setLocating(true)
    setGeoError(false)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false)
        setOpen(false)
        onChange({
          kind: "point",
          lon: pos.coords.longitude,
          lat: pos.coords.latitude,
          label: "My location",
        })
      },
      () => {
        setLocating(false)
        setGeoError(true)
      },
      { enableHighAccuracy: true, timeout: 10_000 }
    )
  }

  return (
    <div className="relative">
      <MapPin className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={ref}
        value={shown}
        placeholder={label}
        aria-label={label}
        className="pl-8"
        onChange={(e) => {
          setQuery(e.target.value)
          if (value) onChange(null)
          setOpen(true)
        }}
        onFocus={() => {
          setEditing(true)
          setQuery(value ? text : query)
          setOpen(true)
        }}
        onBlur={() => {
          setEditing(false)
          setTimeout(() => setOpen(false), 150)
        }}
      />
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 shadow-md animate-in fade-in slide-in-from-top-1 duration-150">
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
            onMouseDown={(e) => e.preventDefault()}
            onClick={useMyLocation}
          >
            <LocateFixed className="size-4 text-muted-foreground" />
            {locating ? "Locating…" : "My location"}
          </button>
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setOpen(false)
              ref.current?.blur()
              onPickOnMap()
            }}
          >
            <MapPinned className="size-4 text-muted-foreground" />
            Choose on map
          </button>
          {matches.map((name) => (
            <button
              key={name}
              type="button"
              className="w-full cursor-pointer truncate rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange({ kind: "stop", name })
                setOpen(false)
                ref.current?.blur()
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      {geoError && (
        <p className="mt-1 text-xs text-destructive">
          Couldn't get your location.
        </p>
      )}
    </div>
  )
}

function formatDuration(seconds: number): string {
  const min = Math.round(seconds / 60)
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h ${min % 60} min`
}

/** Cut the line geometry between the vertices nearest to two stops. */
function sliceGeometry(
  geometry: [number, number][],
  board: [number, number],
  alight: [number, number]
): [number, number][] | null {
  const nearest = (pt: [number, number]) => {
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < geometry.length; i++) {
      const d = haversineM(pt[0], pt[1], geometry[i][0], geometry[i][1])
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return bestD < 300 ? best : -1
  }
  const a = nearest(board)
  const b = nearest(alight)
  if (a === -1 || b === -1 || a >= b) return null
  return geometry.slice(a, b + 1)
}

export function PlannerPanel() {
  const stopsIndex = useAppStore((s) => s.stopsIndex)
  const stopsById = useAppStore((s) => s.stopsById)
  const calendar = useAppStore((s) => s.calendar)
  const routesIndex = useAppStore((s) => s.routesIndex)
  const goBrowse = useAppStore((s) => s.goBrowse)
  const setItineraryOverlay = useAppStore((s) => s.setItineraryOverlay)
  const planFrom = useAppStore((s) => s.planFrom)
  const planTo = useAppStore((s) => s.planTo)
  const setPlanFrom = useAppStore((s) => s.setPlanFrom)
  const setPlanTo = useAppStore((s) => s.setPlanTo)
  const mapPick = useAppStore((s) => s.mapPick)
  const setMapPick = useAppStore((s) => s.setMapPick)
  const setDrawerSnap = useAppStore((s) => s.setDrawerSnap)
  const timeMode = useAppStore((s) => s.planTimeMode)
  const timeStr = useAppStore((s) => s.planTimeStr)
  const setPlanTime = useAppStore((s) => s.setPlanTime)

  const [planner, setPlanner] = useState<PlannerData | null>(null)
  const [loadError, setLoadError] = useState(false)
  useEffect(() => {
    let cancelled = false
    loadPlanner()
      .then((d) => !cancelled && setPlanner(d))
      .catch(() => !cancelled && setLoadError(true))
    void ensureWalkGraph() // warm up the footway graph for walking legs
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(
    () => () => {
      setItineraryOverlay(null)
      setMapPick(null)
    },
    [setItineraryOverlay, setMapPick]
  )

  const names = useMemo(
    () =>
      [...new Set(stopsIndex.map((s) => s.name))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [stopsIndex]
  )

  const [results, setResults] = useState<Itinerary[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const lineMeta = new Map(routesIndex?.lines.map((l) => [l.id, l]) ?? [])

  const shareTrip = async () => {
    const url = location.href
    if (navigator.share) {
      try {
        await navigator.share({ url })
      } catch {
        // user dismissed the share sheet
      }
    } else {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  const search = () => {
    if (!planner || !calendar || !planFrom || !planTo) return
    const now = bratislavaNow()
    let departSeconds = now.seconds
    if (timeMode === "at" && /^\d{1,2}:\d{2}$/.test(timeStr)) {
      const [h, m] = timeStr.split(":").map(Number)
      departSeconds = h * 3600 + m * 60
    }
    const itineraries = planTrips(planner, calendar, {
      sources: endCandidates(planFrom, stopsIndex),
      targets: endCandidates(planTo, stopsIndex),
      departSeconds,
      dateKey: now.dateKey,
    })
    // Nearby places: walking directly can beat (or be the only) connection
    const a = placeCoords(planFrom, stopsIndex)
    const b = placeCoords(planTo, stopsIndex)
    if (a && b) {
      const direct = haversineM(a[0], a[1], b[0], b[1])
      if (direct > 0 && direct <= WALK_ONLY_MAX_M) {
        const sec = walkSeconds(direct)
        itineraries.push({
          legs: [{ kind: "walk", fromStopId: null, toStopId: null, seconds: sec }],
          depart: departSeconds,
          arrive: departSeconds + sec,
          transfers: 0,
        })
      }
    }
    // Shortest trip first; earlier arrival breaks ties
    itineraries.sort(
      (x, y) =>
        x.arrive - x.depart - (y.arrive - y.depart) ||
        x.arrive - y.arrive ||
        x.transfers - y.transfers
    )
    const top = itineraries.slice(0, 5)
    setResults(top)
    setSelected(null)
    setItineraryOverlay(null)
    if (top.length > 0) void select(top[0], 0)
  }

  const select = async (it: Itinerary, idx: number) => {
    setSelected(idx)
    const originPt = placeCoords(planFrom, stopsIndex)
    const destPt = placeCoords(planTo, stopsIndex)
    const stopPt = (id: string): [number, number] | null => {
      const s = stopsById.get(id)
      return s ? [s.lon, s.lat] : null
    }
    const transit: Feature[] = []
    const walk: Feature[] = []
    const coords: [number, number][] = []
    for (const leg of it.legs) {
      if (leg.kind === "transit") {
        const stopPts = leg.stopIds
          .map((id) => stopsById.get(id))
          .filter((s): s is NonNullable<typeof s> => !!s)
          .map((s) => [s.lon, s.lat] as [number, number])
        let geom: [number, number][] | null = null
        try {
          const detail = await loadLineDetail(leg.line)
          const dirGeom = detail.directions.find(
            (d) => d.id === leg.dir
          )?.geometry
          if (dirGeom && stopPts.length >= 2) {
            geom = sliceGeometry(
              dirGeom,
              stopPts[0],
              stopPts[stopPts.length - 1]
            )
          }
        } catch {
          // fall through to stop-to-stop path
        }
        const line = geom ?? stopPts
        coords.push(...line)
        transit.push({
          type: "Feature",
          properties: {
            color: `#${lineMeta.get(leg.line)?.color ?? "888888"}`,
          },
          geometry: { type: "LineString", coordinates: line },
        })
      } else {
        const aPt = leg.fromStopId ? stopPt(leg.fromStopId) : originPt
        const bPt = leg.toStopId ? stopPt(leg.toStopId) : destPt
        if (aPt && bPt && (aPt[0] !== bPt[0] || aPt[1] !== bPt[1])) {
          // Draw the walk along real streets when the footway graph is
          // available; the straight dashed line is the fallback.
          const graph = await ensureWalkGraph()
          const routed = graph ? walkRoute(graph, aPt, bPt) : null
          const lineCoords = routed?.coords ?? [aPt, bPt]
          coords.push(...lineCoords)
          walk.push({
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: lineCoords },
          })
        }
      }
    }
    if (originPt) coords.push(originPt)
    if (destPt) coords.push(destPt)
    setItineraryOverlay({ transit, walk, coords })
  }

  // Opening a share link (or returning to the tab with both places set)
  // searches right away instead of waiting for a button press.
  const autoSearched = useRef(false)
  useEffect(() => {
    if (autoSearched.current) return
    if (!planner || !calendar || !planFrom || !planTo) return
    autoSearched.current = true
    const t = setTimeout(search, 0)
    return () => clearTimeout(t)
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 pt-2">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBrowse}
          aria-label="Back"
        >
          <ArrowLeft />
        </Button>
        <div className="font-semibold">Trip planner</div>
        {planFrom && planTo && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Share this trip"
            title="Share a link to this trip"
            onClick={() => void shareTrip()}
          >
            {copied ? <Check /> : <Share2 />}
          </Button>
        )}
      </div>

      {mapPick && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-primary/50 bg-accent px-2.5 py-1 text-xs animate-in fade-in slide-in-from-top-2 duration-200">
          <span>
            Tap the map to set the{" "}
            {mapPick === "from" ? "starting point" : "destination"}.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMapPick(null)
              setDrawerSnap(SNAP_POINTS[1])
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <PlaceField
            label="From: stop, location, map point…"
            value={planFrom}
            onChange={setPlanFrom}
            names={names}
            onPickOnMap={() => setMapPick("from")}
          />
          <PlaceField
            label="To: stop, location, map point…"
            value={planTo}
            onChange={setPlanTo}
            names={names}
            onPickOnMap={() => setMapPick("to")}
          />
        </div>
        <Button
          variant="outline"
          size="icon"
          className="mt-5"
          aria-label="Swap from and to"
          onClick={() => {
            setPlanFrom(planTo)
            setPlanTo(planFrom)
          }}
        >
          <ArrowUpDown />
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-0.5 rounded-lg bg-muted p-0.5">
          {(
            [
              ["now", "Leave now"],
              ["at", "Leave at"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                if (value === "at" && !timeStr) {
                  const now = bratislavaNow()
                  const h = Math.floor(now.seconds / 3600) % 24
                  const m = Math.floor((now.seconds % 3600) / 60)
                  setPlanTime(
                    value,
                    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
                  )
                } else {
                  setPlanTime(value)
                }
              }}
              className={cn(
                "flex-1 cursor-pointer rounded-md py-1 text-xs font-medium transition-colors",
                timeMode === value
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {timeMode === "at" && (
          <Input
            type="time"
            value={timeStr}
            onChange={(e) => setPlanTime("at", e.target.value)}
            aria-label="Departure time"
            className="w-28 text-center tabular-nums"
          />
        )}
      </div>

      <Button
        onClick={search}
        disabled={!planner || !planFrom || !planTo}
        className="w-full"
      >
        {!planner && !loadError ? (
          <LoaderCircle data-icon="inline-start" className="animate-spin" />
        ) : (
          <Search data-icon="inline-start" />
        )}
        Find connections
      </Button>
      {loadError && (
        <p className="text-xs text-destructive">
          Failed to load the timetable dataset.
        </p>
      )}

      <ScrollArea className="min-h-0 flex-1">
        {results === null ? (
          !planner && !loadError ? (
            <div className="flex justify-center py-8">
              <Spinner className="size-6" />
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Pick a start and destination — a stop, your location, or a point
              on the map.
            </p>
          )
        ) : results.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No connections found for this time.
          </p>
        ) : (
          <div className="flex flex-col gap-2 pr-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
            {results.map((it, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => void select(it, idx)}
                className={cn(
                  "flex cursor-pointer flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors",
                  selected === idx
                    ? "border-primary bg-accent"
                    : "hover:bg-accent/50"
                )}
              >
                <div className="flex items-center justify-between text-sm">
                  <span className="font-semibold tabular-nums">
                    {formatClock(it.depart)} → {formatClock(it.arrive)}
                  </span>
                  <span className="text-muted-foreground">
                    {formatDuration(it.arrive - it.depart)}
                    {it.transfers > 0 &&
                      ` · ${it.transfers} transfer${it.transfers > 1 ? "s" : ""}`}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {it.legs.map((leg, i) =>
                    leg.kind === "walk" ? (
                      <span
                        key={i}
                        className="flex items-center gap-0.5 text-xs text-muted-foreground"
                        title={`Walk ${formatDuration(leg.seconds)}`}
                      >
                        <Footprints className="size-3.5" />
                        {Math.max(1, Math.round(leg.seconds / 60))}′
                      </span>
                    ) : (
                      <span key={i} className="flex items-center gap-1">
                        {i > 0 && it.legs[i - 1].kind === "transit" && (
                          <MoveRight className="size-3 text-muted-foreground" />
                        )}
                        <LineChip
                          id={leg.line}
                          color={lineMeta.get(leg.line)?.color ?? "888888"}
                          textColor={
                            lineMeta.get(leg.line)?.textColor ?? "FFFFFF"
                          }
                          className="h-5 min-w-6 text-[11px]"
                        />
                      </span>
                    )
                  )}
                </div>
                {selected === idx && (
                  <div className="flex flex-col gap-1 border-t pt-1.5 text-xs animate-in fade-in slide-in-from-top-1 duration-200">
                    {it.legs.map((leg, i) =>
                      leg.kind === "walk" ? (
                        <div
                          key={i}
                          className="flex items-center gap-1.5 text-muted-foreground"
                        >
                          <Footprints className="size-3.5 shrink-0" />
                          Walk {formatDuration(leg.seconds)}
                          {leg.toStopId
                            ? stopsById.get(leg.toStopId)
                              ? ` to ${stopsById.get(leg.toStopId)!.name}`
                              : ""
                            : " to destination"}
                        </div>
                      ) : (
                        <TransitLegRow
                          key={i}
                          leg={leg}
                          stopName={(id) => stopsById.get(id)?.name ?? "?"}
                        />
                      )
                    )}
                  </div>
                )}
              </button>
            ))}
            <p className="pb-1 text-[10px] text-muted-foreground">
              Scheduled times — real-time delays are not available.
            </p>
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

function TransitLegRow({
  leg,
  stopName,
}: {
  leg: TransitLeg
  stopName: (id: string) => string
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5">
        <span className="font-semibold tabular-nums">
          {formatClock(leg.boardTime)}
        </span>
        <span className="truncate">
          {stopName(leg.stopIds[0])}{" "}
          <span className="text-muted-foreground">
            · line {leg.line} → {leg.headsign}
          </span>
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="font-semibold tabular-nums">
          {formatClock(leg.alightTime)}
        </span>
        <span className="truncate">
          {stopName(leg.stopIds[leg.stopIds.length - 1])}
        </span>
        <span className="text-muted-foreground">
          ({leg.stopIds.length - 1} stop{leg.stopIds.length > 2 ? "s" : ""})
        </span>
      </div>
    </div>
  )
}
