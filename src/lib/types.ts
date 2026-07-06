export type LineType = "tram" | "trolleybus" | "bus"

export interface LineIndexEntry {
  id: string
  type: LineType
  night: boolean
  color: string
  textColor: string
  note: string
}

export interface RoutesIndex {
  generatedAt: string
  feedStart: string | null
  feedEnd: string | null
  lines: LineIndexEntry[]
}

export interface StopIndexEntry {
  id: string
  code: string
  name: string
  lat: number
  lon: number
  lines: string[]
}

export interface LineDirection {
  id: number
  headsign: string
  stops: string[]
  geometrySource: "osm" | "gtfs"
  geometry: [number, number][]
}

export interface LineDetail {
  id: string
  type: LineType
  night: boolean
  color: string
  textColor: string
  note: string
  directions: LineDirection[]
}

/** One scheduled departure at a platform. Short keys keep the 1 355 stop files small. */
export interface Departure {
  /** line name, e.g. "84" */
  l: string
  /** direction_id */
  d: number
  /** trip headsign */
  h: string
  /** service_id (resolved against calendar.json client-side) */
  s: string
  /** departure time as seconds since service-day midnight; may exceed 86 400 (night trips) */
  t: number
}

export interface StopDetail {
  id: string
  name: string
  code: string
  departures: Departure[]
}

export interface CalendarData {
  services: Record<string, { days: number[]; start: string; end: string }>
  exceptions: Record<string, { added: string[]; removed: string[] }>
}
