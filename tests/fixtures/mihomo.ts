/**
 * Upstream mihomo payload fixtures.
 *
 * Each group has a canonical "valid" shape (matching MIHOMO_API.md), a
 * "missing" variant where a required field is absent, and a "forward compatible"
 * variant carrying additional unknown fields to prove parsing is not broken by
 * future upstream additions.
 */

export const validVersion = {
  meta: true,
  version: '1.18.9'
}

export const versionMissingMeta = {
  version: '1.18.9'
}

export const versionForwardCompatible = {
  meta: true,
  version: '1.18.9',
  future: { flag: true, channel: 'Meta' },
  build: 20260101
}

export const validConfig = {
  port: 7890,
  'mixed-port': 7891,
  mode: 'rule',
  'log-level': 'info',
  'allow-lan': false,
  ipv6: true,
  tun: { enable: false }
}

export const configForwardCompatible = {
  port: 7890,
  mode: 'rule',
  ipv6: false,
  newlyAddedField: 'preserved-value'
}

export const validProxy = {
  name: 'Hong Kong 01',
  type: 'Shadowsocks',
  udp: true,
  alive: true,
  now: 'HK-01',
  history: [{ time: '00:00:00', delay: 42 }]
}

export const proxiesMissingType = {
  proxies: {
    'group-A': { name: 'group-A' }
  }
}

export const proxiesForwardCompatible = {
  proxies: {
    'M1': {
      name: 'Singapore 01',
      type: 'VLESS',
      alive: true,
      unknownMetric: 0.42,
      tags: ['fast', 'stable']
    }
  }
}

export const validConnection = {
  id: 'conn-1',
  metadata: { network: 'tcp', type: 'HTTP', host: 'api.example.com', process: 'Browser' },
  upload: 10,
  download: 100,
  start: '2026-01-01T00:00:00Z',
  chains: ['Proxy'],
  rule: 'MATCH',
  rulePayload: 'Proxy'
}

export const connectionsMissingRule = {
  downloadTotal: 100,
  uploadTotal: 10,
  memory: 52,
  connections: [
    { id: 'bad', metadata: {}, upload: 0, download: 0, start: '2026-01-01T00:00:00Z', chains: [], rulePayload: 'X' }
  ]
}

export const connectionsForwardCompatible = {
  downloadTotal: 100,
  uploadTotal: 10,
  memory: 52,
  connections: [
    {
      id: 'conn-2',
      metadata: { network: 'tcp', host: 'example.net', process: 'curl', newlyAddedMeta: 'kept' },
      upload: 1,
      download: 2,
      start: '2026-01-01T00:00:00Z',
      chains: ['DIRECT'],
      rule: 'MATCH',
      rulePayload: 'DIRECT',
      extra: { remoteAddr: '1.2.3.4:443' }
    }
  ]
}

export const validTraffic = {
  up: 2048,
  down: 4096,
  upTotal: 1000,
  downTotal: 2000
}

export const trafficMissingTotals = {
  up: 2048,
  down: 4096
}

export const validRules = {
  rules: [
    { index: 0, type: 'DOMAIN-SUFFIX', payload: 'example.com', proxy: 'DIRECT', size: 831 },
    { index: 1, type: 'MATCH', payload: '', proxy: 'Proxy', size: 4884189 }
  ]
}

export const rulesForwardCompatible = {
  rules: [
    {
      index: 0,
      type: 'RULE-SET',
      payload: 'rules/ai.list',
      proxy: 'AI',
      size: 272660,
      extra: { hitCount: 12, hitAt: '2026-01-01T00:00:00Z', brandNew: true }
    }
  ]
}
