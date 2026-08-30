import { describe, expect, it } from 'vitest'
import type { MihomoConnection } from '../src/shared/mihomo-api'
import { groupConnectionsByDevice, groupConnectionsByProcess } from '../src/renderer/src/lib/connection-groups'

const rows: MihomoConnection[] = [
  { id: '1', metadata: { process: 'Browser', processPath: 'C:\\Browser.exe', sourceIP: '10.0.0.2', host: 'a.test' }, upload: 10, download: 90, start: '', chains: ['Proxy'], rule: 'MATCH', rulePayload: '' },
  { id: '2', metadata: { process: 'Browser', processPath: 'C:\\Browser.exe', sourceIP: '10.0.0.3', host: 'b.test' }, upload: 20, download: 180, start: '', chains: ['DIRECT'], rule: 'MATCH', rulePayload: '' },
  { id: '3', metadata: { process: 'curl', sourceIP: '10.0.0.2' }, upload: 5, download: 5, start: '', chains: ['DIRECT'], rule: 'MATCH', rulePayload: '' }
]

describe('connection detail grouping', () => {
  it('groups processes by name and path and ranks by total bytes', () => {
    const groups = groupConnectionsByProcess(rows)
    expect(groups.map((group) => group.label)).toEqual(['Browser', 'curl'])
    expect(groups[0]).toMatchObject({ upload: 30, download: 270 })
    expect(groups[0]?.connections).toHaveLength(2)
  })

  it('groups devices by source IP without inventing DHCP identity', () => {
    const groups = groupConnectionsByDevice(rows)
    expect(groups.map((group) => group.label)).toEqual(['10.0.0.3', '10.0.0.2'])
    const sharedDevice = groups.find((group) => group.label === '10.0.0.2')
    expect(sharedDevice?.connections).toHaveLength(2)
    expect(sharedDevice).toMatchObject({ upload: 15, download: 95 })
  })
})
