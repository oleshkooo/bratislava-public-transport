import type { CalendarData, Departure } from "./types"

/**
 * GTFS service-day time math, always in Europe/Bratislava.
 *
 * A service day runs past midnight: night trips carry times like 25:30:00
 * (= 01:30 the next calendar day). So "departures now" must consider both
 * today's services (t >= now) and yesterday's services (t - 86400 >= now).
 */

const TZ = "Europe/Bratislava"

const dtf = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

export interface LocalNow {
  /** YYYYMMDD in Bratislava */
  dateKey: string
  /** seconds since local midnight */
  seconds: number
}

export function bratislavaNow(date = new Date()): LocalNow {
  const parts: Record<string, string> = {}
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value
  const hour = parts.hour === "24" ? "00" : parts.hour
  return {
    dateKey: `${parts.year}${parts.month}${parts.day}`,
    seconds:
      Number(hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
  }
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const y = Number(dateKey.slice(0, 4))
  const m = Number(dateKey.slice(4, 6))
  const d = Number(dateKey.slice(6, 8))
  const t = new Date(Date.UTC(y, m - 1, d, 12) + days * 24 * 3600 * 1000)
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(t.getUTCDate()).padStart(2, "0")
  return `${t.getUTCFullYear()}${mm}${dd}`
}

export const previousDateKey = (dateKey: string) =>
  addDaysToDateKey(dateKey, -1)

const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/** Short weekday label ("Mon") for a YYYYMMDD key. */
export function weekdayLabel(dateKey: string): string {
  const y = Number(dateKey.slice(0, 4))
  const m = Number(dateKey.slice(4, 6))
  const d = Number(dateKey.slice(6, 8))
  return WEEKDAY_SHORT[
    (new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay() + 6) % 7
  ]
}

/** Monday = 0 … Sunday = 6, matching GTFS calendar column order. */
function weekdayIndex(dateKey: string): number {
  const y = Number(dateKey.slice(0, 4))
  const m = Number(dateKey.slice(4, 6))
  const d = Number(dateKey.slice(6, 8))
  return (new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay() + 6) % 7
}

export function activeServiceIds(
  calendar: CalendarData,
  dateKey: string
): Set<string> {
  const active = new Set<string>()
  const wd = weekdayIndex(dateKey)
  for (const [id, svc] of Object.entries(calendar.services)) {
    if (svc.start <= dateKey && dateKey <= svc.end && svc.days[wd] === 1)
      active.add(id)
  }
  const ex = calendar.exceptions[dateKey]
  if (ex) {
    for (const id of ex.added) active.add(id)
    for (const id of ex.removed) active.delete(id)
  }
  return active
}

export interface UpcomingDeparture extends Departure {
  /** seconds until departure from `now` */
  eta: number
  /** platform code the departure belongs to (filled by the caller when merging platforms) */
  platform?: string
}

/**
 * Next scheduled departures across one or more platform departure boards.
 */
export function upcomingDepartures(
  boards: { platform: string; departures: Departure[] }[],
  calendar: CalendarData,
  now: LocalNow,
  limit = 20
): UpcomingDeparture[] {
  const today = activeServiceIds(calendar, now.dateKey)
  const yesterday = activeServiceIds(calendar, previousDateKey(now.dateKey))
  const out: UpcomingDeparture[] = []
  for (const { platform, departures } of boards) {
    for (const dep of departures) {
      if (today.has(dep.s)) {
        const eta = dep.t - now.seconds
        if (eta >= 0) out.push({ ...dep, eta, platform })
      }
      // Yesterday's service day spills past midnight (t >= 86 400 = today's clock t-86400)
      if (dep.t >= 86400 && yesterday.has(dep.s)) {
        const eta = dep.t - 86400 - now.seconds
        if (eta >= 0) out.push({ ...dep, eta, platform })
      }
    }
  }
  out.sort((a, b) => a.eta - b.eta)
  return out.slice(0, limit)
}

/** "25:34:00" seconds → "01:34" wall-clock. */
export function formatClock(t: number): string {
  const h = Math.floor(t / 3600) % 24
  const m = Math.floor((t % 3600) / 60)
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

export function formatEta(etaSeconds: number): string {
  const min = Math.floor(etaSeconds / 60)
  if (min < 1) return "now"
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h ${min % 60} min`
}
