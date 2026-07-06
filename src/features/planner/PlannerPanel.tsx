import { useEffect, useMemo, useRef, useState } from "react"
import type { Feature } from "geojson"
import {
  ArrowLeft,
  ArrowUpDown,
  Footprints,
  LoaderCircle,
  MapPin,
  MoveRight,
  Search,
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
import { haversineM } from "@/lib/geo"
import { useAppStore } from "@/state/store"
import { LineChip } from "@/features/lines/LineChip"
import { cn } from "@/lib/utils"

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")

function StopNameField({
  label,
  value,
  onChange,
  names,
}: {
  label: string
  value: string
  onChange: (name: string) => void
  names: string[]
}) {
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  // Sync external value (e.g. the swap button) into the input during render
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    setQuery(value)
  }

  const matches = useMemo(() => {
    const q = fold(query.trim())
    if (!q) return []
    return names.filter((n) => fold(n).includes(q)).slice(0, 6)
  }, [query, names])

  return (
    <div className="relative">
      <MapPin className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={ref}
        value={query}
        placeholder={label}
        aria-label={label}
        className="pl-8"
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && matches.length > 0 && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          {matches.map((name) => (
            <button
              key={name}
              type="button"
              className="w-full cursor-pointer truncate rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(name)
                setQuery(name)
                setOpen(false)
                ref.current?.blur()
              }}
            >
              {name}
            </button>
          ))}
        </div>
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

  const [planner, setPlanner] = useState<PlannerData | null>(null)
  const [loadError, setLoadError] = useState(false)
  useEffect(() => {
    let cancelled = false
    loadPlanner()
      .then((d) => !cancelled && setPlanner(d))
      .catch(() => !cancelled && setLoadError(true))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => () => setItineraryOverlay(null), [setItineraryOverlay])

  const names = useMemo(
    () =>
      [...new Set(stopsIndex.map((s) => s.name))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [stopsIndex]
  )

  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [timeMode, setTimeMode] = useState<"now" | "at">("now")
  const [timeStr, setTimeStr] = useState("")
  const [results, setResults] = useState<Itinerary[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const lineMeta = new Map(routesIndex?.lines.map((l) => [l.id, l]) ?? [])

  const search = () => {
    if (!planner || !calendar || !from || !to) return
    const now = bratislavaNow()
    let departSeconds = now.seconds
    if (timeMode === "at" && /^\d{1,2}:\d{2}$/.test(timeStr)) {
      const [h, m] = timeStr.split(":").map(Number)
      departSeconds = h * 3600 + m * 60
    }
    const itineraries = planTrips(planner, calendar, {
      fromStopIds: stopsIndex.filter((s) => s.name === from).map((s) => s.id),
      toStopIds: stopsIndex.filter((s) => s.name === to).map((s) => s.id),
      departSeconds,
      dateKey: now.dateKey,
    })
    setResults(itineraries)
    setSelected(null)
    setItineraryOverlay(null)
    if (itineraries.length > 0) void select(itineraries[0], 0)
  }

  const select = async (it: Itinerary, idx: number) => {
    setSelected(idx)
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
        const a = leg.fromStopId ? stopsById.get(leg.fromStopId) : undefined
        const b = stopsById.get(leg.toStopId)
        if (a && b && a.id !== b.id) {
          coords.push([a.lon, a.lat], [b.lon, b.lat])
          walk.push({
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [a.lon, a.lat],
                [b.lon, b.lat],
              ],
            },
          })
        }
      }
    }
    setItineraryOverlay({ transit, walk, coords })
  }

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
      </div>

      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <StopNameField
            label="From stop…"
            value={from}
            onChange={setFrom}
            names={names}
          />
          <StopNameField
            label="To stop…"
            value={to}
            onChange={setTo}
            names={names}
          />
        </div>
        <Button
          variant="outline"
          size="icon"
          className="mt-5"
          aria-label="Swap from and to"
          onClick={() => {
            setFrom(to)
            setTo(from)
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
              onClick={() => setTimeMode(value)}
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
            value={timeStr}
            onChange={(e) => setTimeStr(e.target.value)}
            placeholder="HH:MM"
            aria-label="Departure time"
            className="w-20 text-center tabular-nums"
          />
        )}
      </div>

      <Button
        onClick={search}
        disabled={!planner || !from || !to}
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
              Pick two stops to find scheduled connections.
            </p>
          )
        ) : results.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No connections found for this time.
          </p>
        ) : (
          <div className="flex flex-col gap-2 pr-2">
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
                  <div className="flex flex-col gap-1 border-t pt-1.5 text-xs">
                    {it.legs.map((leg, i) =>
                      leg.kind === "walk" ? (
                        <div
                          key={i}
                          className="flex items-center gap-1.5 text-muted-foreground"
                        >
                          <Footprints className="size-3.5 shrink-0" />
                          Walk {formatDuration(leg.seconds)}
                          {leg.toStopId && stopsById.get(leg.toStopId)
                            ? ` to ${stopsById.get(leg.toStopId)!.name}`
                            : ""}
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
