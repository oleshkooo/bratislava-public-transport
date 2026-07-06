import { useEffect, useRef, useState } from "react"
import maplibregl, { GeoJSONSource, Map as MlMap } from "maplibre-gl"
import type { MapLayerMouseEvent } from "maplibre-gl"
import type { FeatureCollection, Point } from "geojson"
import "maplibre-gl/dist/maplibre-gl.css"
import { allRoutesGeojsonUrl } from "@/lib/data"
import { useAppStore } from "@/state/store"

const MAP_STYLE = "https://tiles.openfreemap.org/styles/positron"
const BRATISLAVA_CENTER: [number, number] = [17.109, 48.148]

const EMPTY_FC = {
  type: "FeatureCollection",
  features: [],
} as FeatureCollection

function fitPadding() {
  return window.innerWidth >= 768
    ? { top: 48, bottom: 48, left: 440, right: 48 }
    : {
        top: 32,
        bottom: Math.round(window.innerHeight * 0.5),
        left: 32,
        right: 32,
      }
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const [ready, setReady] = useState(false)

  const booted = useAppStore((s) => s.booted)
  const stopsIndex = useAppStore((s) => s.stopsIndex)
  const stopsById = useAppStore((s) => s.stopsById)
  const view = useAppStore((s) => s.view)
  const lineDetail = useAppStore((s) => s.lineDetail)
  const showRoutes = useAppStore((s) => s.showRoutes)
  const showStops = useAppStore((s) => s.showStops)
  const focusStop = useAppStore((s) => s.focusStop)

  // --- init once ---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: BRATISLAVA_CENTER,
      zoom: 12.2,
      minZoom: 9,
      attributionControl: {
        customAttribution:
          'Transit data: <a href="https://www.idsbk.sk">Dopravný podnik Bratislava / IDS BK</a> (CC-BY 4.0)',
      },
    })
    mapRef.current = map
    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: false }),
      "top-right"
    )
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
      }),
      "top-right"
    )

    map.on("load", () => {
      // Overview: all route geometries
      map.addSource("all-routes", {
        type: "geojson",
        data: allRoutesGeojsonUrl,
      })
      map.addLayer({
        id: "routes-line",
        type: "line",
        source: "all-routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            1.1,
            14,
            2.2,
            16,
            3.5,
          ],
          "line-opacity": 0.55,
        },
      })

      // Selected line (casing + colored line), above overview
      map.addSource("selected-route", { type: "geojson", data: EMPTY_FC })
      map.addLayer({
        id: "selected-route-casing",
        type: "line",
        source: "selected-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            5,
            14,
            9,
            16,
            13,
          ],
        },
      })
      map.addLayer({
        id: "selected-route-line",
        type: "line",
        source: "selected-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            3,
            14,
            5.5,
            16,
            8,
          ],
        },
      })

      // All stops, clustered at low zoom
      map.addSource("stops", {
        type: "geojson",
        data: EMPTY_FC,
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 48,
      })
      map.addLayer({
        id: "stop-clusters",
        type: "circle",
        source: "stops",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#64748b",
          "circle-opacity": 0.75,
          "circle-radius": ["step", ["get", "point_count"], 10, 25, 14, 80, 18],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      })
      map.addLayer({
        id: "stop-cluster-count",
        type: "symbol",
        source: "stops",
        filter: ["has", "point_count"],
        layout: {
          "text-field": "{point_count_abbreviated}",
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
        },
        paint: { "text-color": "#ffffff" },
      })
      map.addLayer({
        id: "stops-circle",
        type: "circle",
        source: "stops",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": "#ffffff",
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            12,
            2.5,
            15,
            4.5,
            17,
            6,
          ],
          "circle-stroke-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            12,
            1,
            15,
            2,
          ],
          "circle-stroke-color": "#475569",
        },
      })
      map.addLayer({
        id: "stops-label",
        type: "symbol",
        source: "stops",
        filter: ["!", ["has", "point_count"]],
        minzoom: 14.2,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-optional": true,
        },
        paint: {
          "text-color": "#334155",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.2,
        },
      })

      // Stops of the selected line (bigger, in line color)
      map.addSource("line-stops", { type: "geojson", data: EMPTY_FC })
      map.addLayer({
        id: "line-stops-circle",
        type: "circle",
        source: "line-stops",
        paint: {
          "circle-color": "#ffffff",
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            3,
            14,
            5.5,
            17,
            8,
          ],
          "circle-stroke-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            1.5,
            14,
            2.5,
          ],
          "circle-stroke-color": ["get", "color"],
        },
      })
      map.addLayer({
        id: "line-stops-label",
        type: "symbol",
        source: "line-stops",
        minzoom: 12.5,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11.5,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-optional": true,
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.4,
        },
      })

      // Selected stop highlight ring
      map.addSource("selected-stop", { type: "geojson", data: EMPTY_FC })
      map.addLayer({
        id: "selected-stop-ring",
        type: "circle",
        source: "selected-stop",
        paint: {
          "circle-color": "rgba(59,130,246,0.15)",
          "circle-radius": 14,
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "#3b82f6",
        },
      })

      // --- interactions ---
      const store = useAppStore.getState

      map.on("click", "stop-clusters", async (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0]
        if (!feature) return
        const clusterId = feature.properties?.cluster_id
        const src = map.getSource("stops") as GeoJSONSource
        const zoom = await src.getClusterExpansionZoom(clusterId)
        map.easeTo({
          center: (feature.geometry as Point).coordinates as [number, number],
          zoom,
        })
      })

      const selectStopFromFeature = (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0]
        if (feature?.properties?.id)
          store().selectStop(String(feature.properties.id))
      }
      map.on("click", "stops-circle", selectStopFromFeature)
      map.on("click", "line-stops-circle", selectStopFromFeature)

      map.on("click", "routes-line", (e: MapLayerMouseEvent) => {
        // Stops take precedence; if a stop was hit at this point, skip
        const hits = map.queryRenderedFeatures(e.point, {
          layers: ["stops-circle", "line-stops-circle"],
        })
        if (hits.length > 0) return
        const line = e.features?.[0]?.properties?.line
        if (line) store().selectLine(String(line))
      })

      for (const layer of [
        "stops-circle",
        "line-stops-circle",
        "stop-clusters",
        "routes-line",
      ]) {
        map.on(
          "mouseenter",
          layer,
          () => (map.getCanvas().style.cursor = "pointer")
        )
        map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""))
      }

      setReady(true)
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // --- feed all stops into the map ---
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !booted) return
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: stopsIndex.map((s) => ({
        type: "Feature",
        properties: { id: s.id, name: s.name },
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      })),
    }
    ;(map.getSource("stops") as GeoJSONSource | undefined)?.setData(fc)
  }, [ready, booted, stopsIndex])

  // --- layer visibility toggles + overview dimming ---
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const lineActive = view.kind === "line"
    map.setPaintProperty("routes-line", "line-opacity", lineActive ? 0.1 : 0.55)
    map.setLayoutProperty(
      "routes-line",
      "visibility",
      showRoutes ? "visible" : "none"
    )
    for (const layer of [
      "stop-clusters",
      "stop-cluster-count",
      "stops-circle",
      "stops-label",
    ]) {
      map.setLayoutProperty(
        layer,
        "visibility",
        showStops && !lineActive ? "visible" : "none"
      )
    }
  }, [ready, showRoutes, showStops, view.kind])

  // --- selected line: geometry + its stops + fit bounds ---
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const routeSrc = map.getSource("selected-route") as
      GeoJSONSource | undefined
    const stopsSrc = map.getSource("line-stops") as GeoJSONSource | undefined
    if (view.kind !== "line" || !lineDetail) {
      routeSrc?.setData(EMPTY_FC)
      stopsSrc?.setData(EMPTY_FC)
      return
    }
    const dir =
      lineDetail.directions.find((d) => d.id === view.dir) ??
      lineDetail.directions[0]
    if (!dir) return

    routeSrc?.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { color: `#${lineDetail.color}` },
          geometry: { type: "LineString", coordinates: dir.geometry },
        },
      ],
    })
    stopsSrc?.setData({
      type: "FeatureCollection",
      features: dir.stops
        .map((id) => stopsById.get(id))
        .filter((s): s is NonNullable<typeof s> => !!s)
        .map((s) => ({
          type: "Feature",
          properties: { id: s.id, name: s.name, color: `#${lineDetail.color}` },
          geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        })),
    })

    if (dir.geometry.length > 1) {
      const bounds = dir.geometry.reduce(
        (b, c) => b.extend(c as [number, number]),
        new maplibregl.LngLatBounds(dir.geometry[0], dir.geometry[0])
      )
      map.fitBounds(bounds, {
        padding: fitPadding(),
        duration: 600,
        maxZoom: 15,
      })
    }
  }, [ready, view, lineDetail, stopsById])

  // --- selected stop highlight ---
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const src = map.getSource("selected-stop") as GeoJSONSource | undefined
    if (view.kind !== "stop") {
      src?.setData(EMPTY_FC)
      return
    }
    const stop = stopsById.get(view.stopId)
    if (!stop) return
    src?.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [stop.lon, stop.lat] },
        },
      ],
    })
    map.flyTo({
      center: [stop.lon, stop.lat],
      zoom: Math.max(map.getZoom(), 15),
      padding: fitPadding(),
      duration: 600,
    })
  }, [ready, view, stopsById])

  // --- one-shot focus from stop-list clicks ---
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !focusStop) return
    const stop = stopsById.get(focusStop.id)
    if (!stop) return
    map.flyTo({
      center: [stop.lon, stop.lat],
      zoom: Math.max(map.getZoom(), 15.5),
      padding: fitPadding(),
      duration: 500,
    })
  }, [ready, focusStop, stopsById])

  // maplibre-gl.css forces `position: relative` on the container itself,
  // so the container must get its size from an absolutely-positioned wrapper.
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="size-full" />
    </div>
  )
}
