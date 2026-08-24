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
  parseMihomoLog,
  parseMihomoProxyProviders,
  parseMihomoProxyProvider,
  parseMihomoRuleProviders,
  parseMihomoRuleProvider,
  parseMihomoDelayResult,
  parseMihomoDelayMap
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

describe('parseMihomoProxyProviders / parseMihomoProxyProvider', () => {
  it('parses a valid proxy providers response with member objects', () => {
    const result = parseMihomoProxyProviders({
      providers: {
        '机场 A': {
          name: '机场 A',
          type: 'Proxy',
          vehicleType: 'HTTP',
          proxies: [{ name: '香港 01', type: 'Shadowsocks' }, { name: '香港 02', type: 'Shadowsocks' }]
        }
      }
    })
    // Upstream emits no member-count field; the count is derived from `proxies`.
    expect(result.providers['机场 A'].proxies).toHaveLength(2)
  })

  it('tolerates forward-compatible provider fields', () => {
    const result = parseMihomoProxyProvider({ name: 'A', type: 'Proxy', proxiesCount: 2, custom: 1 })
    // An unknown/legacy count survives passthrough without being part of the contract.
    expect(result.custom).toBe(1)
    expect((result as Record<string, unknown>).proxiesCount).toBe(2)
  })

  it('parses subscription metadata and probe settings', () => {
    const result = parseMihomoProxyProvider({
      name: '机场 A',
      type: 'Proxy',
      testUrl: 'https://www.gstatic.com/generate_204',
      expectedStatus: '204',
      subscriptionInfo: { Upload: 1000, Download: 2000, Total: 5000, Expire: 1893456000 }
    })
    expect(result.testUrl).toBe('https://www.gstatic.com/generate_204')
    expect(result.expectedStatus).toBe('204')
    expect(result.subscriptionInfo?.Upload).toBe(1000)
    expect(result.subscriptionInfo?.Total).toBe(5000)
    expect(result.subscriptionInfo?.Expire).toBe(1893456000)
  })

  it('rejects a provider missing its name', () => {
    expect(() => parseMihomoProxyProvider({ type: 'Proxy' })).toThrowError(ProtocolError)
  })
})

describe('parseMihomoRuleProviders / parseMihomoRuleProvider', () => {
  it('parses a valid rule providers response', () => {
    const result = parseMihomoRuleProviders({ providers: { '规则集 A': { name: '规则集 A', type: 'Rule', ruleCount: 8 } } })
    expect(result.providers['规则集 A'].ruleCount).toBe(8)
  })

  it('parses the rule provider format field', () => {
    const result = parseMihomoRuleProvider({ name: '规则集 B', type: 'Rule', format: 'yaml' })
    expect(result.format).toBe('yaml')
  })

  it('rejects a rule provider missing its name', () => {
    expect(() => parseMihomoRuleProvider({ type: 'Rule' })).toThrowError(ProtocolError)
  })
})

describe('parseMihomoDelayResult / parseMihomoDelayMap', () => {
  it('parses a delay result', () => {
    expect(parseMihomoDelayResult({ delay: 42 }).delay).toBe(42)
  })

  it('rejects a delay result with no numeric delay', () => {
    expect(() => parseMihomoDelayResult({})).toThrowError(ProtocolError)
  })

  it('parses a delay map preserving unknown member values', () => {
    expect(parseMihomoDelayMap({ '香港 01': 42, DIRECT: 6 })).toEqual({ '香港 01': 42, DIRECT: 6 })
  })
})
