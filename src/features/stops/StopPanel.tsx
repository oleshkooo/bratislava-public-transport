import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, Star } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { loadStopDetail } from "@/lib/data"
import {
  bratislavaNow,
  formatClock,
  formatEta,
  upcomingDepartures,
  type UpcomingDeparture,
} from "@/lib/service-day"
import type { StopDetail, StopIndexEntry } from "@/lib/types"
import { useAppStore } from "@/state/store"
import { LineChip } from "@/features/lines/LineChip"
import { TimetableView } from "./TimetableView"
import { cn } from "@/lib/utils"

export function StopPanel() {
  const view = useAppStore((s) => s.view)
  const stopsById = useAppStore((s) => s.stopsById)
  const stopId = view.kind === "stop" ? view.stopId : null
  const stop = stopId ? stopsById.get(stopId) : undefined
  if (!stop) return null
  // Key by physical stop name so all per-stop UI state resets on stop change
  return <StopPanelInner key={stop.name} stop={stop} />
}

function StopPanelInner({ stop }: { stop: StopIndexEntry }) {
  const stopsIndex = useAppStore((s) => s.stopsIndex)
  const calendar = useAppStore((s) => s.calendar)
  const routesIndex = useAppStore((s) => s.routesIndex)
  const closeStop = useAppStore((s) => s.closeStop)
  const selectLine = useAppStore((s) => s.selectLine)
  const stopPanelInit = useAppStore((s) => s.stopPanelInit)
  const favorites = useAppStore((s) => s.favorites)
  const toggleFavoriteStop = useAppStore((s) => s.toggleFavoriteStop)

  const init = stopPanelInit?.stopId === stop.id ? stopPanelInit : null
  const [tab, setTab] = useState<"next" | "timetable">(init?.tab ?? "next")

  // All platforms sharing the same name form one physical stop
  const platforms = useMemo(
    () => stopsIndex.filter((s) => s.name === stop.name),
    [stop.name, stopsIndex]
  )

  // Keyed by platform set so stale boards never show for a newly selected stop
  const platformsKey = platforms.map((p) => p.id).join("|")
  const [loaded, setLoaded] = useState<{
    key: string
    boards: StopDetail[]
  } | null>(null)
  useEffect(() => {
    if (platforms.length === 0) return
    let cancelled = false
    Promise.all(platforms.map((p) => loadStopDetail(p.id))).then((details) => {
      if (!cancelled) setLoaded({ key: platformsKey, boards: details })
    })
    return () => {
      cancelled = true
    }
  }, [platforms, platformsKey])
  const boards = loaded?.key === platformsKey ? loaded.boards : null

  // Re-evaluate "now" every 30 s so the board stays fresh
  const [now, setNow] = useState(() => bratislavaNow())
  useEffect(() => {
    const t = setInterval(() => setNow(bratislavaNow()), 30_000)
    return () => clearInterval(t)
  }, [])

  const upcoming: UpcomingDeparture[] = useMemo(() => {
    if (!boards || !calendar) return []
    return upcomingDepartures(
      boards.map((b) => ({ platform: b.code, departures: b.departures })),
      calendar,
      now,
      18
    )
  }, [boards, calendar, now])

  const servingLines = [...new Set(platforms.flatMap((p) => p.lines))].sort(
    (a, b) => (parseInt(a) || 999) - (parseInt(b) || 999) || a.localeCompare(b)
  )
  const lineMeta = new Map(routesIndex?.lines.map((l) => [l.id, l]) ?? [])
  const multiPlatform = new Set(platforms.map((p) => p.code)).size > 1
  const isFavorite = favorites.stops.includes(stop.id)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 pt-2">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={closeStop}
          aria-label="Back"
        >
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold" title={stop.name}>
            {stop.name}
          </div>
          <div className="text-xs text-muted-foreground">
            {platforms.length > 1
              ? `${platforms.length} platforms`
              : `Stop ${stop.code}`}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
          onClick={() => toggleFavoriteStop(stop.id)}
        >
          <Star className={cn(isFavorite && "fill-amber-400 text-amber-400")} />
        </Button>
      </div>

      <div className="flex flex-wrap gap-1">
        {servingLines.map((id) => {
          const m = lineMeta.get(id)
          if (!m) return null
          return (
            <LineChip
              key={id}
              id={id}
              color={m.color}
              textColor={m.textColor}
              onClick={() => selectLine(id)}
              className="h-6 min-w-6 text-xs"
            />
          )
        })}
      </div>

      <Separator />

      <div className="flex gap-0.5 rounded-lg bg-muted p-0.5">
        {(
          [
            ["next", "Next departures"],
            ["timetable", "Timetable"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn(
              "flex-1 cursor-pointer rounded-md py-1 text-xs font-medium transition-colors",
              tab === value
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {boards === null || !calendar ? (
        <div className="flex flex-col gap-2 pr-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : tab === "timetable" ? (
        <TimetableView
          boards={boards}
          calendar={calendar}
          lineMeta={lineMeta}
          initialLine={init ? { l: init.line, d: init.dir } : undefined}
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {upcoming.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No more scheduled departures today.
            </p>
          ) : (
            <div className="flex flex-col pr-2">
              {upcoming.map((dep, i) => {
                const m = lineMeta.get(dep.l)
                return (
                  <div
                    key={`${dep.l}-${dep.t}-${dep.platform}-${i}`}
                    className="flex items-center gap-2 border-b py-1.5 last:border-b-0"
                  >
                    <LineChip
                      id={dep.l}
                      color={m?.color ?? "888888"}
                      textColor={m?.textColor ?? "FFFFFF"}
                      className="h-6 min-w-7 text-xs"
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-sm"
                      title={dep.h}
                    >
                      {dep.h}
                    </span>
                    {multiPlatform && dep.platform && (
                      <Badge variant="outline" className="px-1 text-[10px]">
                        {dep.platform}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatClock(dep.t)}
                    </span>
                    <span className="w-14 text-right text-sm font-semibold tabular-nums">
                      {formatEta(dep.eta)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>
      )}
    </div>
  )
}
