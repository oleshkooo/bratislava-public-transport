import { useMemo, useState } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  activeServiceIds,
  addDaysToDateKey,
  bratislavaNow,
  weekdayLabel,
} from "@/lib/service-day"
import type { CalendarData, LineIndexEntry, StopDetail } from "@/lib/types"
import { LineChip } from "@/features/lines/LineChip"
import { cn } from "@/lib/utils"

interface LineDirOption {
  l: string
  d: number
  headsign: string
}

/**
 * Printed-style timetable for one stop: pick a day and a line+direction,
 * get an hour → minutes grid computed from the real calendar for that date.
 */
export function TimetableView({
  boards,
  calendar,
  lineMeta,
  initialLine,
}: {
  boards: StopDetail[]
  calendar: CalendarData
  lineMeta: Map<string, LineIndexEntry>
  initialLine?: { l: string; d: number }
}) {
  const days = useMemo(() => {
    const today = bratislavaNow().dateKey
    return Array.from({ length: 7 }, (_, i) => {
      const dateKey = addDaysToDateKey(today, i)
      return {
        dateKey,
        label: i === 0 ? "Today" : i === 1 ? "Tomorrow" : weekdayLabel(dateKey),
      }
    })
  }, [])

  // Line+direction options present at this stop, labelled by dominant headsign
  const options = useMemo<LineDirOption[]>(() => {
    const byKey = new Map<string, Map<string, number>>()
    for (const b of boards) {
      for (const dep of b.departures) {
        const key = `${dep.l}|${dep.d}`
        let heads = byKey.get(key)
        if (!heads) byKey.set(key, (heads = new Map()))
        heads.set(dep.h, (heads.get(dep.h) ?? 0) + 1)
      }
    }
    return [...byKey.entries()]
      .map(([key, heads]) => {
        const [l, d] = key.split("|")
        const headsign = [...heads.entries()].sort((a, b) => b[1] - a[1])[0][0]
        return { l, d: Number(d), headsign }
      })
      .sort(
        (a, b) =>
          (parseInt(a.l) || 999) - (parseInt(b.l) || 999) ||
          a.l.localeCompare(b.l) ||
          a.d - b.d
      )
  }, [boards])

  const [dayIdx, setDayIdx] = useState(0)
  const [selected, setSelected] = useState<{ l: string; d: number } | null>(
    initialLine ?? null
  )
  const current =
    (selected &&
      options.find((o) => o.l === selected.l && o.d === selected.d)) ||
    options[0]

  const grid = useMemo(() => {
    if (!current) return []
    const active = activeServiceIds(calendar, days[dayIdx].dateKey)
    const times = new Set<number>()
    for (const b of boards) {
      for (const dep of b.departures) {
        if (dep.l === current.l && dep.d === current.d && active.has(dep.s)) {
          times.add(dep.t)
        }
      }
    }
    const byHour = new Map<number, number[]>()
    for (const t of [...times].sort((a, b) => a - b)) {
      const h = Math.floor(t / 3600)
      let arr = byHour.get(h)
      if (!arr) byHour.set(h, (arr = []))
      arr.push(Math.floor((t % 3600) / 60))
    }
    return [...byHour.entries()]
  }, [boards, calendar, current, dayIdx, days])

  if (options.length === 0) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {options.map((o) => {
          const m = lineMeta.get(o.l)
          const isSel = current && o.l === current.l && o.d === current.d
          return (
            <button
              key={`${o.l}|${o.d}`}
              type="button"
              onClick={() => setSelected({ l: o.l, d: o.d })}
              className={cn(
                "flex cursor-pointer items-center gap-1 rounded-md border px-1 py-0.5 text-xs transition-colors",
                isSel ? "border-primary bg-accent" : "hover:bg-accent/50"
              )}
              title={`${o.l} → ${o.headsign}`}
            >
              <LineChip
                id={o.l}
                color={m?.color ?? "888888"}
                textColor={m?.textColor ?? "FFFFFF"}
                className="h-5 min-w-5 text-[11px]"
              />
              <span className="max-w-24 truncate text-muted-foreground">
                {o.headsign}
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex gap-0.5 rounded-lg bg-muted p-0.5">
        {days.map((d, i) => (
          <button
            key={d.dateKey}
            type="button"
            onClick={() => setDayIdx(i)}
            className={cn(
              "flex-1 cursor-pointer rounded-md py-1 text-xs font-medium transition-colors",
              i === dayIdx
                ? "bg-background shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {d.label}
          </button>
        ))}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {grid.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No service on this day.
          </p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {grid.map(([hour, minutes]) => (
                <tr key={hour} className="border-b last:border-b-0">
                  <td className="w-10 py-1 pr-2 text-right font-semibold tabular-nums">
                    {String(hour % 24).padStart(2, "0")}
                  </td>
                  <td className="py-1 text-muted-foreground tabular-nums">
                    {minutes.map((m) => String(m).padStart(2, "0")).join("  ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="pt-2 pb-1 text-[10px] text-muted-foreground">
          Hours continue past midnight into the next day (night service).
        </p>
      </ScrollArea>
    </div>
  )
}
