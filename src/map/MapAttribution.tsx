import { useState } from "react"
import { Info, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useMediaQuery } from "@/lib/use-media-query"
import { cn } from "@/lib/utils"

/**
 * Data/tile attribution over the map, replacing maplibre's AttributionControl
 * (whose default spot is covered by the mobile drawer). Dismissing it is
 * persisted, but it collapses to an ⓘ button rather than disappearing — the
 * ODbL/CC-BY credits must stay reachable.
 */

const DISMISS_KEY = "attribution-dismissed"

const readDismissed = () => {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1"
  } catch {
    return false
  }
}

function AttributionLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground"
    >
      {children}
    </a>
  )
}

export function MapAttribution() {
  const isDesktop = useMediaQuery("(min-width: 768px)")
  const [open, setOpen] = useState(() => !readDismissed())

  const dismiss = () => {
    setOpen(false)
    try {
      localStorage.setItem(DISMISS_KEY, "1")
    } catch {
      // storage blocked — it will just reappear next visit
    }
  }

  return (
    <div
      className={cn(
        "absolute z-10",
        isDesktop
          ? "right-3 bottom-3"
          : "left-2 top-[max(0.5rem,env(safe-area-inset-top))]"
      )}
    >
      {open ? (
        <div
          className={cn(
            "flex max-w-72 items-start gap-1.5 rounded-lg border bg-background/90 py-2 pr-3 pl-1.5 shadow-md backdrop-blur-sm animate-in fade-in duration-200",
            isDesktop ? "slide-in-from-bottom-1" : "slide-in-from-top-1"
          )}
        >
          {/* Close sits left of the text: the right map edge is control land */}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Hide attribution"
            className="-my-0.5 shrink-0 text-muted-foreground"
            onClick={dismiss}
          >
            <X />
          </Button>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Schedules:{" "}
            <AttributionLink href="https://www.idsbk.sk">
              Dopravný podnik Bratislava / IDS BK
            </AttributionLink>{" "}
            (CC-BY 4.0) · Map data ©{" "}
            <AttributionLink href="https://www.openstreetmap.org/copyright">
              OpenStreetMap
            </AttributionLink>{" "}
            contributors · Tiles:{" "}
            <AttributionLink href="https://openfreemap.org">
              OpenFreeMap
            </AttributionLink>{" "}
            ·{" "}
            <AttributionLink href="https://www.openmaptiles.org/">
              OpenMapTiles
            </AttributionLink>
          </p>
        </div>
      ) : (
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Show attribution"
          title="Data & map attribution"
          className="rounded-full bg-background/90 text-muted-foreground shadow-md backdrop-blur-sm"
          onClick={() => setOpen(true)}
        >
          <Info />
        </Button>
      )}
    </div>
  )
}
