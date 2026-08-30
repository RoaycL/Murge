import type { MihomoConnection } from '@shared/mihomo-api'

export interface ConnectionGroup {
  key: string
  label: string
  subtitle: string
  upload: number
  download: number
  connections: MihomoConnection[]
}

function groupConnections(
  connections: readonly MihomoConnection[],
  identify: (connection: MihomoConnection) => { key: string; label: string; subtitle: string }
): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>()
  for (const connection of connections) {
    const identity = identify(connection)
    const current = groups.get(identity.key) ?? { ...identity, upload: 0, download: 0, connections: [] }
    current.upload += connection.upload
    current.download += connection.download
    current.connections.push(connection)
    groups.set(identity.key, current)
  }
  return [...groups.values()].sort((left, right) => (right.upload + right.download) - (left.upload + left.download) || left.label.localeCompare(right.label))
}

export function groupConnectionsByProcess(connections: readonly MihomoConnection[]): ConnectionGroup[] {
  return groupConnections(connections, (connection) => {
    const label = connection.metadata.process?.trim() || '未知进程'
    const subtitle = connection.metadata.processPath?.trim() || `${connection.metadata.network || '未知网络'} · ${connection.metadata.type || '连接'}`
    return { key: `${label}\0${connection.metadata.processPath || ''}`, label, subtitle }
  })
}

export function groupConnectionsByDevice(connections: readonly MihomoConnection[]): ConnectionGroup[] {
  return groupConnections(connections, (connection) => {
    const address = connection.metadata.sourceIP?.trim() || '未知地址'
    return { key: address, label: address, subtitle: connection.metadata.sourcePort ? `源端口 ${connection.metadata.sourcePort}` : '本地客户端' }
  })
}
