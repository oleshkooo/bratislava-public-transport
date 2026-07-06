import { useEffect, useState } from "react"
import { CircleDot, Moon, Navigation, Route, Sun } from "lucide-react"
import { Drawer } from "vaul"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Toggle } from "@/components/ui/toggle"
import { useTheme } from "@/components/theme-provider"
import { useResolvedDark } from "@/lib/use-resolved-dark"
import { useMediaQuery } from "@/lib/use-media-query"
import { MapView } from "@/map/MapView"
import { LinesMenu } from "@/features/lines/LinesMenu"
import { LinePanel } from "@/features/lines/LinePanel"
import { StopPanel } from "@/features/stops/StopPanel"
import { PlannerPanel } from "@/features/planner/PlannerPanel"
import { SearchBox } from "@/features/search/SearchBox"
import { useAppStore } from "@/state/store"

/** Drawer snap points on mobile: peek / half / full. */
const SNAP_POINTS = [0.18, 0.55, 0.94]

function PanelContent() {
  const view = useAppStore((s) => s.view)
  const showRoutes = useAppStore((s) => s.showRoutes)
  const showStops = useAppStore((s) => s.showStops)
  const setShowRoutes = useAppStore((s) => s.setShowRoutes)
  const setShowStops = useAppStore((s) => s.setShowStops)
  const goPlan = useAppStore((s) => s.goPlan)
  const { setTheme } = useTheme()
  const dark = useResolvedDark()

  return (
    <>
      <div className="flex flex-col gap-2 p-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-base font-bold tracking-tight">
            Bratislava{" "}
            <span className="font-normal text-muted-foreground">
              transit map
            </span>
          </h1>
          <div className="flex gap-1">
            <Button
              variant={view.kind === "plan" ? "default" : "ghost"}
              size="icon-sm"
              aria-label="Trip planner"
              title="Plan a trip"
              onClick={goPlan}
            >
              <Navigation />
            </Button>
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
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
              onClick={() => setTheme(dark ? "light" : "dark")}
            >
              {dark ? <Sun /> : <Moon />}
            </Button>
          </div>
        </div>
        <SearchBox />
      </div>

      {view.kind === "browse" && <LinesMenu />}
      {view.kind === "line" && <LinePanel />}
      {view.kind === "stop" && <StopPanel />}
      {view.kind === "plan" && <PlannerPanel />}

      <p className="border-t px-3 py-1.5 text-[10px] leading-tight text-muted-foreground">
        Schedules: Dopravný podnik Bratislava / IDS BK (CC-BY 4.0) · Route
        geometry &amp; map © OpenStreetMap contributors
      </p>
    </>
  )
}

function MobileDrawer() {
  const view = useAppStore((s) => s.view)
  const [snap, setSnap] = useState<number | string | null>(SNAP_POINTS[1])

  // Opening a line/stop/planner from the map or search pulls the drawer up
  // so the content is visible; collapsing back down is one swipe away.
  // (state adjusted during render — the sanctioned pattern for derived resets)
  const [prevView, setPrevView] = useState(view)
  if (view !== prevView) {
    setPrevView(view)
    if (view.kind !== "browse" && snap === SNAP_POINTS[0]) {
      setSnap(SNAP_POINTS[1])
    }
  }

  return (
    <Drawer.Root
      open
      modal={false}
      dismissible={false}
      snapPoints={SNAP_POINTS}
      activeSnapPoint={snap}
      setActiveSnapPoint={setSnap}
    >
      <Drawer.Portal>
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-20 flex h-[94dvh] flex-col rounded-t-2xl border-t bg-background shadow-[0_-4px_16px_rgba(0,0,0,0.12)] outline-none"
          aria-describedby={undefined}
        >
          <Drawer.Title className="sr-only">
            Bratislava transit map panel
          </Drawer.Title>
          <div
            className="flex w-full shrink-0 cursor-grab justify-center py-2"
            aria-hidden
          >
            <div className="h-1.5 w-12 rounded-full bg-muted-foreground/25" />
          </div>
          <PanelContent />
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

export default function App() {
  const booted = useAppStore((s) => s.booted)
  const bootError = useAppStore((s) => s.bootError)
  const boot = useAppStore((s) => s.boot)
  const isDesktop = useMediaQuery("(min-width: 768px)")

  useEffect(() => {
    void boot()
  }, [boot])

  return (
    <div className="relative h-dvh w-full overflow-hidden">
      <MapView />

      {isDesktop ? (
        <div className="absolute top-3 bottom-3 left-3 z-10 flex w-[400px] flex-col rounded-xl border bg-background/95 shadow-xl backdrop-blur-sm">
          <PanelContent />
        </div>
      ) : (
        <MobileDrawer />
      )}

      {!booted && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/70">
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
