import { useMemo, useRef, useState } from "react"
import { MapPin, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { useAppStore } from "@/state/store"
import { LineChip } from "@/features/lines/LineChip"

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")

export function SearchBox() {
  const routesIndex = useAppStore((s) => s.routesIndex)
  const stopsIndex = useAppStore((s) => s.stopsIndex)
  const selectLine = useAppStore((s) => s.selectLine)
  const selectStop = useAppStore((s) => s.selectStop)

  const [q, setQ] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useMemo(() => {
    const query = fold(q.trim())
    if (!query) return null

    const lines = (routesIndex?.lines ?? [])
      .filter((l) => fold(l.id).startsWith(query))
      .slice(0, 8)

    // One result per physical stop name
    const seen = new Set<string>()
    const stops: { id: string; name: string }[] = []
    for (const s of stopsIndex) {
      if (seen.has(s.name)) continue
      if (fold(s.name).includes(query)) {
        seen.add(s.name)
        stops.push({ id: s.id, name: s.name })
        if (stops.length >= 6) break
      }
    }
    return { lines, stops }
  }, [q, routesIndex, stopsIndex])

  const close = () => {
    setQ("")
    inputRef.current?.blur()
  }

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && close()}
          placeholder="Line number or stop name…"
          className="pl-8"
          aria-label="Search lines and stops"
        />
      </div>
      {results && (results.lines.length > 0 || results.stops.length > 0) && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          {results.lines.length > 0 && (
            <div className="flex flex-wrap gap-1 p-1.5">
              {results.lines.map((l) => (
                <LineChip
                  key={l.id}
                  id={l.id}
                  color={l.color}
                  textColor={l.textColor}
                  onClick={() => {
                    selectLine(l.id)
                    close()
                  }}
                />
              ))}
            </div>
          )}
          {results.stops.map((s) => (
            <button
              key={s.id}
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                selectStop(s.id)
                close()
              }}
            >
              <MapPin className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{s.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
