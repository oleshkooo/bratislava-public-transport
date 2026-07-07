import { loadWalkGraphData } from "./data"
import { haversineM } from "./geo"

/**
 * Client-side pedestrian routing over the compact OSM footway graph emitted
 * by the build script. Used to draw walking legs along real streets; walking
 * *times* stay on the straight-line model shared with RAPTOR.
 */

/** Build-script output: flat node coords and undirected weighted edges. */
export interface WalkGraphData {
  /** flat [lon, lat, …] */
  nodes: number[]
  /** flat [a, b, meters, …] */
  edges: number[]
}

type LonLat = [number, number]

export interface WalkGraph {
  nodes: number[]
  /** CSR adjacency: neighbors of i live in [off[i], off[i+1]) */
  off: Int32Array
  adjNode: Int32Array
  adjLen: Float32Array
  grid: Map<string, number[]>
}

/** ≈250 m buckets for nearest-node lookup. */
const GRID = 0.003
/** Don't route walks longer than the planner ever produces. */
const MAX_ROUTE_M = 4000
/** Give up snapping if no graph node is this close. */
const SNAP_MAX_M = 400

const gridKey = (lon: number, lat: number) =>
  `${Math.floor(lon / GRID)}_${Math.floor(lat / GRID)}`

function buildGraph(data: WalkGraphData): WalkGraph {
  const n = data.nodes.length / 2
  const m = data.edges.length / 3
  const deg = new Int32Array(n)
  for (let e = 0; e < m; e++) {
    deg[data.edges[e * 3]]++
    deg[data.edges[e * 3 + 1]]++
  }
  const off = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + deg[i]
  const adjNode = new Int32Array(off[n])
  const adjLen = new Float32Array(off[n])
  const cursor = off.slice(0, n)
  for (let e = 0; e < m; e++) {
    const a = data.edges[e * 3]
    const b = data.edges[e * 3 + 1]
    const len = data.edges[e * 3 + 2]
    adjNode[cursor[a]] = b
    adjLen[cursor[a]++] = len
    adjNode[cursor[b]] = a
    adjLen[cursor[b]++] = len
  }
  const grid = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    const k = gridKey(data.nodes[i * 2], data.nodes[i * 2 + 1])
    let arr = grid.get(k)
    if (!arr) grid.set(k, (arr = []))
    arr.push(i)
  }
  return { nodes: data.nodes, off, adjNode, adjLen, grid }
}

let graphPromise: Promise<WalkGraph | null> | null = null

/** Lazy-load + index the graph once; null when the dataset isn't available. */
export function ensureWalkGraph(): Promise<WalkGraph | null> {
  if (!graphPromise) {
    graphPromise = loadWalkGraphData()
      .then(buildGraph)
      .catch(() => null)
  }
  return graphPromise
}

function nearestNode(g: WalkGraph, p: LonLat): number {
  const cx = Math.floor(p[0] / GRID)
  const cy = Math.floor(p[1] / GRID)
  let best = -1
  let bestD = SNAP_MAX_M
  for (let ring = 0; ring <= 2; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        for (const i of g.grid.get(`${cx + dx}_${cy + dy}`) ?? []) {
          const d = haversineM(
            p[0],
            p[1],
            g.nodes[i * 2],
            g.nodes[i * 2 + 1]
          )
          if (d < bestD) {
            bestD = d
            best = i
          }
        }
      }
    }
    if (best !== -1 && ring >= 1) break // found within ring+margin — good enough
  }
  return best
}

/**
 * A* shortest path; returns street-following coords (with the exact endpoints
 * attached) and the walked meters, or null when unroutable.
 */
export function walkRoute(
  g: WalkGraph,
  from: LonLat,
  to: LonLat
): { coords: LonLat[]; meters: number } | null {
  const direct = haversineM(from[0], from[1], to[0], to[1])
  if (direct > MAX_ROUTE_M) return null
  const s = nearestNode(g, from)
  const t = nearestNode(g, to)
  if (s === -1 || t === -1) return null

  const n = g.nodes.length / 2
  const dist = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const done = new Uint8Array(n)
  const tx = g.nodes[t * 2]
  const ty = g.nodes[t * 2 + 1]
  const h = (i: number) =>
    haversineM(g.nodes[i * 2], g.nodes[i * 2 + 1], tx, ty)

  // binary heap of [f, node]
  const heapF: number[] = [h(s)]
  const heapN: number[] = [s]
  dist[s] = 0
  const push = (f: number, node: number) => {
    heapF.push(f)
    heapN.push(node)
    let i = heapF.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heapF[p] <= heapF[i]) break
      ;[heapF[p], heapF[i]] = [heapF[i], heapF[p]]
      ;[heapN[p], heapN[i]] = [heapN[i], heapN[p]]
      i = p
    }
  }
  const pop = (): number => {
    const top = heapN[0]
    const lastF = heapF.pop()!
    const lastN = heapN.pop()!
    if (heapN.length > 0) {
      heapF[0] = lastF
      heapN[0] = lastN
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let min = i
        if (l < heapF.length && heapF[l] < heapF[min]) min = l
        if (r < heapF.length && heapF[r] < heapF[min]) min = r
        if (min === i) break
        ;[heapF[min], heapF[i]] = [heapF[i], heapF[min]]
        ;[heapN[min], heapN[i]] = [heapN[i], heapN[min]]
        i = min
      }
    }
    return top
  }

  while (heapN.length > 0) {
    const u = pop()
    if (done[u]) continue
    done[u] = 1
    if (u === t) break
    if (dist[u] > MAX_ROUTE_M * 1.5) return null // runaway search
    for (let e = g.off[u]; e < g.off[u + 1]; e++) {
      const v = g.adjNode[e]
      if (done[v]) continue
      const nd = dist[u] + g.adjLen[e]
      if (nd < dist[v]) {
        dist[v] = nd
        prev[v] = u
        push(nd + h(v), v)
      }
    }
  }
  if (!done[t]) return null

  const chain: number[] = []
  for (let cur = t; cur !== -1; cur = prev[cur]) chain.unshift(cur)
  const coords: LonLat[] = chain.map((i) => [
    g.nodes[i * 2],
    g.nodes[i * 2 + 1],
  ])
  const meters =
    dist[t] +
    haversineM(from[0], from[1], coords[0][0], coords[0][1]) +
    haversineM(to[0], to[1], coords[coords.length - 1][0], coords[coords.length - 1][1])
  return { coords: [from, ...coords, to], meters }
}
