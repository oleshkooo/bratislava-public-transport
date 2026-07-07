import type { PlannerPlace } from "@/state/store"
import type { StopIndexEntry } from "./types"

/** Resolve a planner place to map coordinates (stop = centroid of platforms). */
export function placeCoords(
  place: PlannerPlace | null,
  stopsIndex: StopIndexEntry[]
): [number, number] | null {
  if (!place) return null
  if (place.kind === "point") return [place.lon, place.lat]
  const platforms = stopsIndex.filter((s) => s.name === place.name)
  if (platforms.length === 0) return null
  return [
    platforms.reduce((sum, s) => sum + s.lon, 0) / platforms.length,
    platforms.reduce((sum, s) => sum + s.lat, 0) / platforms.length,
  ]
}

export function haversineM(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number
): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const la1 = (lat1 * Math.PI) / 180
  const la2 = (lat2 * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`
  return `${(m / 1000).toFixed(1)} km`
}
