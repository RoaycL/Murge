/**
 * Read-only routing topology model.
 *
 * The topology is a derived, best-effort visualization built from the live
 * mihomo `/connections` stream: each connection carries its proxy chain
 * (`chains`, reported exit-first), the rule that matched it (`rule` + `rulePayload`),
 * and its byte counters. Connections are aggregated into distinct routing paths
 * and hop nodes so the dashboard can render "which chain carries what traffic".
 *
 * Everything is read-only and in-memory: nothing here mutates mihomo and nothing
 * is persisted (no credentials, hosts or raw profiles). mihomo does not always
 * report a full chain for every connection, so incomplete/unknown chains are
 * explicitly labeled rather than silently dropped.
 */

export type TopologyHopKind = 'direct' | 'node' | 'unknown'

import { connectionChainHops } from './connection-chain'

/** The minimal per-connection projection the topology derivation needs. */
export interface TopologyConnectionInput {
  /** Raw mihomo `chains`, ordered from exit node back to the outer policy. */
  chains: string[]
  /** The rule that matched this connection (`rule`). */
  rule?: string
  /** The matched rule payload (`rulePayload`, e.g. the target/strategy). */
  rulePayload?: string
  download: number
  upload: number
}

/** One aggregated hop (policy / proxy / DIRECT) across all connections. */
export interface TopologyHop {
  name: string
  kind: TopologyHopKind
  connections: number
  download: number
  upload: number
  /** First hop of at least one chain (the entry policy). */
  isEntry: boolean
  /** Last hop of at least one chain (the exit node). */
  isExit: boolean
}

/** One aggregated routing path (a distinct chain). */
export interface TopologyPath {
  /** Stable per-chain id (the chain string itself). */
  id: string
  hops: string[]
  rule: string | null
  rulePayload: string | null
  connections: number
  download: number
  upload: number
  bytes: number
  /** mihomo returned no chain for the contributing connections. */
  incomplete: boolean
}

export interface TopologySummary {
  totalConnections: number
  /** Connections routed through at least one proxy node (non-DIRECT chain). */
  proxiedCount: number
  /** Connections whose chain includes DIRECT. */
  directCount: number
  /** Connections where mihomo returned no chain. */
  unknownChainCount: number
  /** Whether any contributing data was incomplete (chains missing). */
  hasIncomplete: boolean
  /** The top-most routing paths, ordered by bytes. */
  paths: TopologyPath[]
  /** The top-most hops, ordered by bytes. */
  nodes: TopologyHop[]
  /** The largest node/path byte total, for normalizing bar widths. */
  maxBytes: number
}

export interface BuildTopologyOptions {
  /** Max distinct paths to surface. */
  maxPaths?: number
  /** Max distinct hops to surface. */
  maxNodes?: number
}

const TOPOLOGY_DEFAULT_MAX_PATHS = 6
const TOPOLOGY_DEFAULT_MAX_NODES = 8

export function buildTopology(connections: TopologyConnectionInput[], options: BuildTopologyOptions = {}): TopologySummary {
  const maxPaths = options.maxPaths ?? TOPOLOGY_DEFAULT_MAX_PATHS
  const maxNodes = options.maxNodes ?? TOPOLOGY_DEFAULT_MAX_NODES

  const pathMap = new Map<string, TopologyPath>()
  const nodeMap = new Map<string, TopologyHop>()
  let totalConnections = 0
  let proxiedCount = 0
  let directCount = 0
  let unknownChainCount = 0

  for (const connection of connections) {
    totalConnections += 1
    const hops = connectionChainHops(connection.chains ?? [])
    const incomplete = hops.length === 0
    const isDirect = hops.includes('DIRECT')
    const download = connection.download ?? 0
    const upload = connection.upload ?? 0

    if (incomplete) {
      unknownChainCount += 1
    } else if (isDirect) {
      directCount += 1
    } else {
      proxiedCount += 1
    }

    const key = hops.join(' > ') || '__unknown__'
    let path = pathMap.get(key)
    if (!path) {
      path = {
        id: key,
        hops,
        rule: connection.rule ?? null,
        rulePayload: connection.rulePayload ?? null,
        connections: 0,
        download: 0,
        upload: 0,
        bytes: 0,
        incomplete
      }
      pathMap.set(key, path)
    }
    path.connections += 1
    path.download += download
    path.upload += upload
    path.bytes = path.download + path.upload

    const lastIndex = hops.length - 1
    hops.forEach((name, index) => {
      const kind: TopologyHopKind = name === 'DIRECT' ? 'direct' : 'node'
      let hop = nodeMap.get(name)
      if (!hop) {
        hop = { name, kind, connections: 0, download: 0, upload: 0, isEntry: false, isExit: false }
        nodeMap.set(name, hop)
      }
      hop.connections += 1
      hop.download += download
      hop.upload += upload
      if (index === 0) hop.isEntry = true
      if (index === lastIndex) hop.isExit = true
    })
  }

  const paths = [...pathMap.values()].sort((a, b) => b.bytes - a.bytes).slice(0, maxPaths)
  const nodes = [...nodeMap.values()]
    .sort((a, b) => b.download + b.upload - (a.download + a.upload))
    .slice(0, maxNodes)

  const maxBytes = Math.max(0, ...paths.map((path) => path.bytes), ...nodes.map((node) => node.download + node.upload))

  return {
    totalConnections,
    proxiedCount,
    directCount,
    unknownChainCount,
    hasIncomplete: unknownChainCount > 0 || paths.some((path) => path.incomplete),
    paths,
    nodes,
    maxBytes
  }
}

/** A display label for a path's chain (DIRECT when mihomo reports none). */
export function topologyPathLabel(path: TopologyPath): string {
  return path.hops.length ? path.hops.join(' → ') : 'DIRECT'
}

/** A short human label for one hop. */
export function topologyHopLabel(hop: TopologyHop): string {
  if (hop.kind === 'direct') return '直连'
  if (hop.kind === 'unknown') return '未知'
  return hop.isExit ? `${hop.name} · 出口` : hop.isEntry ? `${hop.name} · 入口` : hop.name
}

/** A user-facing note when mihomo reported incomplete chains, else null. */
export function topologyIncompleteText(summary: TopologySummary): string | null {
  if (!summary.hasIncomplete) return null
  return 'mihomo 未为部分连接返回完整链路，已标记为未知；拓扑仅反映当前实时连接。'
}
