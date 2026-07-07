import { ArrowLeft, CalendarClock, Clock, Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAppStore } from "@/state/store"
import { cn } from "@/lib/utils"
import { LineChip } from "./LineChip"

const TYPE_LABEL = {
  tram: "Tram",
  trolleybus: "Trolleybus",
  bus: "Bus",
} as const

export function LinePanel() {
  const view = useAppStore((s) => s.view)
  const lineDetail = useAppStore((s) => s.lineDetail)
  const routesIndex = useAppStore((s) => s.routesIndex)
  const stopsById = useAppStore((s) => s.stopsById)
  const goBrowse = useAppStore((s) => s.goBrowse)
  const setDirection = useAppStore((s) => s.setDirection)
  const selectStop = useAppStore((s) => s.selectStop)
  const focusStopOnMap = useAppStore((s) => s.focusStopOnMap)
  const openTimetable = useAppStore((s) => s.openTimetable)
  const favorites = useAppStore((s) => s.favorites)
  const toggleFavoriteLine = useAppStore((s) => s.toggleFavoriteLine)

  if (view.kind !== "line") return null
  const meta = routesIndex?.lines.find((l) => l.id === view.lineId)
  if (!meta) return null

  const dir =
    lineDetail?.directions.find((d) => d.id === view.dir) ??
    lineDetail?.directions[0]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 pt-2">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBrowse}
          aria-label="Back to all lines"
        >
          <ArrowLeft />
        </Button>
        <LineChip
          id={meta.id}
          color={meta.color}
          textColor={meta.textColor}
          className="h-9 px-2 text-base"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            {meta.night ? "Night bus" : TYPE_LABEL[meta.type]}
          </div>
          {meta.note && (
            <div
              className="truncate text-xs text-muted-foreground"
              title={meta.note}
            >
              {meta.note}
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={
            favorites.lines.includes(meta.id)
              ? "Remove from favorites"
              : "Add to favorites"
          }
          onClick={() => toggleFavoriteLine(meta.id)}
        >
          <Star
            className={cn(
              favorites.lines.includes(meta.id) &&
                "fill-amber-400 text-amber-400"
            )}
          />
        </Button>
      </div>

      {!lineDetail || !dir ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      ) : (
        <>
          {lineDetail.directions.length > 1 && (
            <ToggleGroup
              orientation="vertical"
              variant="outline"
              spacing={1}
              className="w-full"
              value={[String(view.dir)]}
              onValueChange={(vals: unknown[]) => {
                if (vals.length > 0) setDirection(Number(vals[0]))
              }}
            >
              {lineDetail.directions.map((d) => (
                <ToggleGroupItem
                  key={d.id}
                  value={String(d.id)}
                  className="w-full justify-start"
                >
                  <span className="truncate">→ {d.headsign}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}

          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => openTimetable(meta.id, dir.id, dir.stops[0])}
          >
            <CalendarClock data-icon="inline-start" />
            Timetable from {stopsById.get(dir.stops[0])?.name ?? "terminus"}
          </Button>

          <ScrollArea className="min-h-0 flex-1">
            <div className="relative pr-2 pl-1">
              <div
                className="absolute top-3 bottom-3 left-[11px] w-0.5 rounded"
                style={{ backgroundColor: `#${meta.color}` }}
              />
              {dir.stops.map((stopId, i) => {
                const stop = stopsById.get(stopId)
                if (!stop) return null
                const isEnd = i === 0 || i === dir.stops.length - 1
                return (
                  <div
                    key={`${stopId}-${i}`}
                    className="group flex items-center gap-1"
                  >
                    <button
                      type="button"
                      onClick={() => focusStopOnMap(stopId)}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md py-1.5 pl-0 text-left hover:bg-accent"
                    >
                      <span
                        className="relative z-10 ml-[3px] size-2.5 shrink-0 rounded-full border-2 bg-background"
                        style={{ borderColor: `#${meta.color}` }}
                      />
                      <span
                        className={`truncate text-sm ${isEnd ? "font-semibold" : ""}`}
                        title={stop.name}
                      >
                        {stop.name}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-60"
                      aria-label={`Departures at ${stop.name}`}
                      onClick={() => selectStop(stopId)}
                    >
                      <Clock />
                    </Button>
                  </div>
                )
              })}
            </div>
            {dir.geometrySource === "gtfs" && (
              <p className="px-1 pt-2 text-xs text-muted-foreground">
                Route drawn approximately (no street-level geometry available
                for this line).
              </p>
            )}
          </ScrollArea>
        </>
      )}
    </div>
  )
}
