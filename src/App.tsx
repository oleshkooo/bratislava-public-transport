import { useEffect } from "react"
import { CircleDot, Route } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { Toggle } from "@/components/ui/toggle"
import { MapView } from "@/map/MapView"
import { LinesMenu } from "@/features/lines/LinesMenu"
import { LinePanel } from "@/features/lines/LinePanel"
import { StopPanel } from "@/features/stops/StopPanel"
import { SearchBox } from "@/features/search/SearchBox"
import { useAppStore } from "@/state/store"

export default function App() {
  const booted = useAppStore((s) => s.booted)
  const bootError = useAppStore((s) => s.bootError)
  const view = useAppStore((s) => s.view)
  const showRoutes = useAppStore((s) => s.showRoutes)
  const showStops = useAppStore((s) => s.showStops)
  const setShowRoutes = useAppStore((s) => s.setShowRoutes)
  const setShowStops = useAppStore((s) => s.setShowStops)
  const boot = useAppStore((s) => s.boot)

  useEffect(() => {
    void boot()
  }, [boot])

  return (
    <div className="relative h-dvh w-full overflow-hidden">
      <MapView />

      <div className="absolute top-3 bottom-3 left-3 z-10 flex w-[400px] flex-col rounded-xl border bg-background/95 shadow-xl backdrop-blur-sm max-md:inset-x-2 max-md:top-auto max-md:bottom-2 max-md:max-h-[52dvh] max-md:w-auto">
        <div className="flex flex-col gap-2 p-3 pb-2">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-base font-bold tracking-tight">
              Bratislava{" "}
              <span className="font-normal text-muted-foreground">
                transit map
              </span>
            </h1>
            <div className="flex gap-1">
              <Toggle
                size="sm"
                pressed={showRoutes}
                onPressedChange={setShowRoutes}
                aria-label="Toggle route lines"
                title="Show all route lines"
              >
                <Route />
              </Toggle>
              <Toggle
                size="sm"
                pressed={showStops}
                onPressedChange={setShowStops}
                aria-label="Toggle stops"
                title="Show all stops"
              >
                <CircleDot />
              </Toggle>
            </div>
          </div>
          <SearchBox />
        </div>

        {view.kind === "browse" && <LinesMenu />}
        {view.kind === "line" && <LinePanel />}
        {view.kind === "stop" && <StopPanel />}

        <p className="border-t px-3 py-1.5 text-[10px] leading-tight text-muted-foreground">
          Schedules: Dopravný podnik Bratislava / IDS BK (CC-BY 4.0) · Route
          geometry &amp; map © OpenStreetMap contributors
        </p>
      </div>

      {!booted && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/70">
          {bootError ? (
            <div className="max-w-sm rounded-lg border bg-background p-4 text-sm">
              <p className="font-semibold text-destructive">
                Failed to load transit data
              </p>
              <p className="mt-1 text-muted-foreground">{bootError}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                Run <code>npm run build:data</code> to generate{" "}
                <code>public/data/</code>.
              </p>
            </div>
          ) : (
            <Spinner className="size-8" />
          )}
        </div>
      )}
    </div>
  )
}
