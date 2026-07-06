import { BusFront, MoonStar, TramFront, Zap } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAppStore, type TypeTab } from "@/state/store"
import { LineChip } from "./LineChip"

const TABS: { value: TypeTab; label: string; icon: typeof TramFront }[] = [
  { value: "tram", label: "Tram", icon: TramFront },
  { value: "trolleybus", label: "Trolley", icon: Zap },
  { value: "bus", label: "Bus", icon: BusFront },
  { value: "night", label: "Night", icon: MoonStar },
]

export function LinesMenu() {
  const routesIndex = useAppStore((s) => s.routesIndex)
  const typeTab = useAppStore((s) => s.typeTab)
  const setTypeTab = useAppStore((s) => s.setTypeTab)
  const selectLine = useAppStore((s) => s.selectLine)

  if (!routesIndex) return null

  const lines = routesIndex.lines.filter((l) =>
    typeTab === "night" ? l.night : l.type === typeTab && !l.night
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 pt-2">
      <Tabs value={typeTab} onValueChange={(v) => setTypeTab(v as TypeTab)}>
        <TabsList className="w-full">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              <t.icon data-icon="inline-start" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid grid-cols-5 gap-1.5 pr-2">
          {lines.map((l) => (
            <LineChip
              key={l.id}
              id={l.id}
              color={l.color}
              textColor={l.textColor}
              onClick={() => selectLine(l.id)}
              className="h-9"
            />
          ))}
        </div>
        <p className="pt-3 pb-1 text-center text-xs text-muted-foreground">
          {lines.length} lines · tap a line to see its route
        </p>
      </ScrollArea>
    </div>
  )
}
