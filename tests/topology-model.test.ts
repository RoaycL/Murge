import { describe, it, expect } from 'vitest'
import {
  buildTopology,
  topologyHopLabel,
  topologyIncompleteText,
  topologyPathLabel,
  type TopologyConnectionInput
} from '../src/shared/topology'

const conn = (partial: Partial<TopologyConnectionInput> & { chains: string[]; download: number; upload: number }): TopologyConnectionInput => ({
  download: 0,
  upload: 0,
  ...partial
})

describe('read-only topology model', () => {
  describe('buildTopology', () => {
    it('returns an empty summary for no connections', () => {
      const summary = buildTopology([])
      expect(summary.totalConnections).toBe(0)
      expect(summary.paths).toEqual([])
      expect(summary.nodes).toEqual([])
      expect(summary.maxBytes).toBe(0)
      expect(summary.hasIncomplete).toBe(false)
    })

    it('aggregates connections sharing a chain into one path', () => {
      const summary = buildTopology([
        conn({ chains: ['US-NYC', 'Proxy'], download: 100, upload: 10 }),
        conn({ chains: ['US-NYC', 'Proxy'], download: 50, upload: 5 })
      ])
      expect(summary.paths).toHaveLength(1)
      const path = summary.paths[0]
      expect(path.hops).toEqual(['Proxy', 'US-NYC'])
      expect(path.connections).toBe(2)
      expect(path.download).toBe(150)
      expect(path.upload).toBe(15)
      expect(path.bytes).toBe(165)
      expect(path.rule).toBeNull()
    })

    it('aggregates hops across chains, marking entry and exit', () => {
      const summary = buildTopology([conn({ chains: ['US-NYC', 'Proxy'], download: 10 }), conn({ chains: ['JP-Tokyo', 'Proxy'], download: 20 })])
      const nodes = summary.nodes
      const proxy = nodes.find((node) => node.name === 'Proxy')!
      const nyc = nodes.find((node) => node.name === 'US-NYC')!
      const tokyo = nodes.find((node) => node.name === 'JP-Tokyo')!
      expect(proxy.isEntry).toBe(true)
      expect(proxy.isExit).toBe(false)
      expect(proxy.connections).toBe(2)
      expect(nyc.isExit).toBe(true)
      expect(tokyo.isExit).toBe(true)
    })

    it('classifies direct, proxied and unknown chains', () => {
      const summary = buildTopology([
        conn({ chains: ['DIRECT'], download: 1 }),
        conn({ chains: ['HK', 'Proxy'], download: 2 }),
        conn({ chains: [], download: 3 })
      ])
      expect(summary.directCount).toBe(1)
      expect(summary.proxiedCount).toBe(1)
      expect(summary.unknownChainCount).toBe(1)
      expect(summary.hasIncomplete).toBe(true)
    })

    it('labels the derived rule on a path', () => {
      const summary = buildTopology([conn({ chains: ['HK', 'Selector'], rule: 'GEOIP', rulePayload: 'HK', download: 5 })])
      expect(summary.paths[0].rule).toBe('GEOIP')
      expect(summary.paths[0].rulePayload).toBe('HK')
    })

    it('orders paths and nodes by bytes descending', () => {
      const summary = buildTopology([
        conn({ chains: ['Exit-A', 'A'], download: 100 }),
        conn({ chains: ['Exit-B', 'B'], download: 200 })
      ])
      expect(summary.paths.map((path) => path.hops[0])).toEqual(['B', 'A'])
      // The heavier path's hop node should sort first.
      expect(summary.nodes[0].name).toBe('B')
    })

    it('caps the number of surfaced paths and nodes', () => {
      const summary = buildTopology(
        [
          conn({ chains: ['N1', 'P'], download: 10 }),
          conn({ chains: ['N2', 'P'], download: 20 }),
          conn({ chains: ['N3', 'P'], download: 30 })
        ],
        { maxPaths: 2, maxNodes: 2 }
      )
      expect(summary.paths).toHaveLength(2)
      expect(summary.nodes).toHaveLength(2)
    })

    it('reports a non-zero maxBytes for bar normalization', () => {
      const summary = buildTopology([conn({ chains: ['N', 'P'], download: 7, upload: 3 })])
      expect(summary.maxBytes).toBe(10)
    })
  })

  describe('helpers', () => {
    it('formats a path label and defaults unknown chains to DIRECT', () => {
      const summary = buildTopology([conn({ chains: ['B', 'A'], download: 1 }), conn({ chains: [], download: 1 })])
      expect(topologyPathLabel(summary.paths[0])).toBe('A → B')
      expect(topologyPathLabel(summary.paths[1])).toBe('DIRECT')
    })

    it('labels hops for direct, entry, exit and plain nodes', () => {
      const summary = buildTopology([conn({ chains: ['DIRECT'], download: 1 }), conn({ chains: ['Tail', 'Entry'], download: 1 })])
      const direct = summary.nodes.find((node) => node.name === 'DIRECT')!
      const exit = summary.nodes.find((node) => node.name === 'Tail')!
      expect(topologyHopLabel(direct)).toBe('直连')
      expect(topologyHopLabel(exit)).toBe('Tail · 出口')
    })

    it('returns an incomplete-data note only when needed', () => {
      const complete = buildTopology([])
      const incomplete = buildTopology([conn({ chains: [], download: 1 })])
      expect(topologyIncompleteText(complete)).toBeNull()
      expect(topologyIncompleteText(incomplete)).not.toBeNull()
    })
  })
})
