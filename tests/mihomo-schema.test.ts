import { describe, it, expect } from 'vitest'
import {
  parseMihomoVersion,
  parseMihomoConfig,
  parseMihomoProxies,
  parseMihomoProxy,
  parseMihomoRules,
  parseMihomoRule,
  parseMihomoConnections,
  parseMihomoConnection,
  parseMihomoTraffic,
  parseMihomoLog
} from '@shared/schemas/mihomo'
import { ProtocolError, ProtocolErrorCode } from '@shared/protocol-errors'
import {
  validVersion,
  versionMissingMeta,
  versionForwardCompatible,
  validConfig,
  configForwardCompatible,
  validProxy,
  proxiesMissingType,
  proxiesForwardCompatible,
  validConnection,
  connectionsMissingRule,
  connectionsForwardCompatible,
  validTraffic,
  trafficMissingTotals,
  validRules,
  rulesForwardCompatible
} from './fixtures/mihomo'

describe('parseMihomoVersion', () => {
  it('parses a valid version', () => {
    expect(parseMihomoVersion(validVersion).version).toBe(validVersion.version)
  })

  it('throws a typed error when the required meta field is missing', () => {
    expect(() => parseMihomoVersion(versionMissingMeta)).toThrowError(ProtocolError)
    try {
      parseMihomoVersion(versionMissingMeta)
    } catch (error) {
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.INVALID_UPSTREAM)
    }
  })

  it('tolerates forward-compatible extra fields', () => {
    expect(parseMihomoVersion(versionForwardCompatible).version).toBe(versionForwardCompatible.version)
  })
})

describe('parseMihomoConfig', () => {
  it('parses a valid config', () => {
    expect(parseMihomoConfig(validConfig).mode).toBe('rule')
  })

  it('tolerates forward-compatible extra fields', () => {
    expect(parseMihomoConfig(configForwardCompatible).mode).toBe('rule')
  })
})

describe('parseMihomoProxies', () => {
  it('parses a valid proxies response', () => {
    const result = parseMihomoProxies({ proxies: { A: validProxy } })
    expect(result.proxies.A.name).toBe('Hong Kong 01')
  })

  it('rejects a proxy missing the required type', () => {
    expect(() => parseMihomoProxies(proxiesMissingType)).toThrowError(ProtocolError)
  })

  it('tolerates forward-compatible proxy fields', () => {
    const result = parseMihomoProxies(proxiesForwardCompatible)
    expect(result.proxies.M1.name).toBe('Singapore 01')
  })
})

describe('parseMihomoProxy', () => {
  it('parses a single proxy', () => {
    expect(parseMihomoProxy(validProxy).udp).toBe(true)
  })
})

describe('parseMihomoRules / parseMihomoRule', () => {
  it('parses valid rules', () => {
    const result = parseMihomoRules(validRules)
    expect(result.rules).toHaveLength(2)
  })

  it('tolerates forward-compatible extra fields', () => {
    const result = parseMihomoRules(rulesForwardCompatible)
    expect(result.rules[0].extra?.hitCount).toBe(12)
  })

  it('parses a single rule', () => {
    expect(parseMihomoRule(validRules.rules[0]).type).toBe('DOMAIN-SUFFIX')
  })
})

describe('parseMihomoConnections / parseMihomoConnection', () => {
  it('parses a valid snapshot', () => {
    const result = parseMihomoConnections({ ...connectionsForwardCompatible, connections: [validConnection] })
    expect(result.connections[0].id).toBe('conn-1')
  })

  it('rejects a connection missing the required rule field', () => {
    expect(() => parseMihomoConnections(connectionsMissingRule)).toThrowError(ProtocolError)
  })

  it('tolerates forward-compatible fields', () => {
    const result = parseMihomoConnections(connectionsForwardCompatible)
    expect(result.connections[0].metadata.process).toBe('curl')
  })

  it('parses a single connection', () => {
    expect(parseMihomoConnection(validConnection).id).toBe('conn-1')
  })
})

describe('parseMihomoTraffic', () => {
  it('parses a valid traffic message', () => {
    expect(parseMihomoTraffic(validTraffic).up).toBe(2048)
  })

  it('rejects a traffic message missing totals', () => {
    expect(() => parseMihomoTraffic(trafficMissingTotals)).toThrowError(ProtocolError)
  })
})

describe('forward-compatible passthrough', () => {
  it('preserves unknown fields on delay-history entries', () => {
    const proxy = parseMihomoProxy({
      ...validProxy,
      history: [{ time: '00:00:00', delay: 42, jitter: 5 }]
    })
    expect(proxy.history?.[0].jitter).toBe(5)
  })

  it('preserves unknown top-level fields on a rule', () => {
    const rule = parseMihomoRule({
      index: 0,
      type: 'DOMAIN-SUFFIX',
      payload: 'example.com',
      proxy: 'DIRECT',
      size: 831,
      source: 'geoip'
    })
    expect(rule.source).toBe('geoip')
  })

  it('preserves unknown top-level fields on a connection', () => {
    const connection = parseMihomoConnection({ ...validConnection, extra: { remoteAddr: '1.2.3.4:443' } })
    expect(connection.extra).toEqual({ remoteAddr: '1.2.3.4:443' })
  })

  it('keeps connection.extra from the forward-compatible fixture', () => {
    const result = parseMihomoConnections(connectionsForwardCompatible)
    expect(result.connections[0].extra).toEqual({ remoteAddr: '1.2.3.4:443' })
  })

  it('keeps unknown metadata fields from the forward-compatible fixture', () => {
    const result = parseMihomoConnections(connectionsForwardCompatible)
    expect(result.connections[0].metadata.newlyAddedMeta).toBe('kept')
  })
})

describe('parseMihomoLog', () => {
  it('parses a valid log message', () => {
    expect(parseMihomoLog({ type: 'info', payload: 'started', time: '00:00:00' }).payload).toBe('started')
  })

  it('tolerates a log with no optional fields', () => {
    expect(parseMihomoLog({})).toBeDefined()
  })
})
