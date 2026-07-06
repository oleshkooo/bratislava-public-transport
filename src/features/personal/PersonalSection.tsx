import { useState } from "react"
import { History, LoaderCircle, LocateFixed, MapPin, Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatDistance, haversineM } from "@/lib/geo"
import { useAppStore } from "@/state/store"
import { LineChip } from "@/features/lines/LineChip"

interface NearbyStop {
  id: string
  name: string
  distanceM: number
}

/** Favorites, recents and geolocation-based nearby stops, shown in browse view. */
export function PersonalSection() {
  const routesIndex = useAppStore((s) => s.routesIndex)
  const stopsIndex = useAppStore((s) => s.stopsIndex)
  const stopsById = useAppStore((s) => s.stopsById)
  const favorites = useAppStore((s) => s.favorites)
  const recents = useAppStore((s) => s.recents)
  const selectLine = useAppStore((s) => s.selectLine)
  const selectStop = useAppStore((s) => s.selectStop)

  const [nearby, setNearby] = useState<
    | { state: "idle" }
    | { state: "loading" }
    | { state: "error"; message: string }
    | { state: "done"; stops: NearbyStop[] }
  >({ state: "idle" })

  const lineMeta = new Map(routesIndex?.lines.map((l) => [l.id, l]) ?? [])

  const findNearby = () => {
    if (!navigator.geolocation) {
      setNearby({ state: "error", message: "Geolocation is not available." })
      return
    }
    setNearby({ state: "loading" })
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { longitude, latitude } = pos.coords
        // Nearest platform per physical stop name
        const byName = new Map<string, NearbyStop>()
        for (const s of stopsIndex) {
          const d = haversineM(longitude, latitude, s.lon, s.lat)
          const cur = byName.get(s.name)
          if (!cur || d < cur.distanceM) {
            byName.set(s.name, { id: s.id, name: s.name, distanceM: d })
          }
        }
        const stops = [...byName.values()]
          .sort((a, b) => a.distanceM - b.distanceM)
          .slice(0, 5)
        setNearby({ state: "done", stops })
      },
      (err) => setNearby({ state: "error", message: err.message }),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
    )
  }

  const favoriteLines = favorites.lines.filter((id) => lineMeta.has(id))
  const favoriteStops = favorites.stops
    .map((id) => stopsById.get(id))
    .filter((s): s is NonNullable<typeof s> => !!s)
  const recentLines = recents.lines
    .filter((id) => lineMeta.has(id) && !favorites.lines.includes(id))
    .slice(0, 6)

  const hasAnything =
    favoriteLines.length > 0 ||
    favoriteStops.length > 0 ||
    recentLines.length > 0

  return (
    <div className="flex flex-col gap-2">
      {(favoriteLines.length > 0 || favoriteStops.length > 0) && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <Star className="size-3" /> Favorites
          </div>
          {favoriteLines.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {favoriteLines.map((id) => {
                const m = lineMeta.get(id)!
                return (
                  <LineChip
                    key={id}
                    id={id}
                    color={m.color}
                    textColor={m.textColor}
                    onClick={() => selectLine(id)}
                    className="h-7 text-xs"
                  />
                )
              })}
            </div>
          )}
          {favoriteStops.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => selectStop(s.id)}
              className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-accent"
            >
              <MapPin className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{s.name}</span>
            </button>
          ))}
        </div>
      )}

      {recentLines.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <History className="size-3" /> Recent
          </div>
          <div className="flex flex-wrap gap-1">
            {recentLines.map((id) => {
              const m = lineMeta.get(id)!
              return (
                <LineChip
                  key={id}
                  id={id}
                  color={m.color}
                  textColor={m.textColor}
                  onClick={() => selectLine(id)}
                  className="h-7 text-xs"
                />
              )
            })}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={findNearby}
          disabled={nearby.state === "loading"}
          className="w-full"
        >
          {nearby.state === "loading" ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <LocateFixed data-icon="inline-start" />
          )}
          Stops near me
        </Button>
        {nearby.state === "error" && (
          <p className="px-1 text-xs text-muted-foreground">{nearby.message}</p>
        )}
        {nearby.state === "done" &&
          nearby.stops.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => selectStop(s.id)}
              className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-accent"
            >
              <MapPin className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatDistance(s.distanceM)}
              </span>
            </button>
          ))}
      </div>

      {hasAnything && <div className="border-b" />}
    </div>
  )
}
