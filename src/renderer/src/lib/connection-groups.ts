import { t } from '@shared/i18n'
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

function processLabelOf(connection: MihomoConnection): string {
  return connection.metadata.process?.trim() || t('common.unknownProcess')
}

/** Stable identity of a process row; shared with the per-process traffic history. */
export function processKeyOf(connection: MihomoConnection): string {
  return `${processLabelOf(connection)}\0${connection.metadata.processPath || ''}`
}

/** Stable identity of a device row (its source address); shared with the traffic history. */
export function deviceKeyOf(connection: MihomoConnection): string {
  return connection.metadata.sourceIP?.trim() || t('connGroups.unknownAddress')
}

export function groupConnectionsByProcess(connections: readonly MihomoConnection[]): ConnectionGroup[] {
  return groupConnections(connections, (connection) => {
    const label = processLabelOf(connection)
    const subtitle = connection.metadata.processPath?.trim() || `${connection.metadata.network || t('connGroups.unknownNetwork')} · ${connection.metadata.type || t('common.connection')}`
    return { key: processKeyOf(connection), label, subtitle }
  })
}

export function groupConnectionsByDevice(connections: readonly MihomoConnection[]): ConnectionGroup[] {
  return groupConnections(connections, (connection) => {
    const address = deviceKeyOf(connection)
    return { key: address, label: address, subtitle: connection.metadata.sourcePort ? t('connGroups.sourcePort', [connection.metadata.sourcePort]) : t('connGroups.localClient') }
  })
}
