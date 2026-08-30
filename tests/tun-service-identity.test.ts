import { describe, expect, it } from 'vitest'
import { tunServiceIdentity } from '../src/main/tun/service-identity'
import { readFileSync } from 'node:fs'
import { brand } from '../src/shared/brand'

describe('brand-stable TUN service identity', () => {
  it('depends on appId, not display/product names', () => {
    const first = tunServiceIdentity('io.example.desktop')
    const renamed = tunServiceIdentity('io.example.desktop')
    expect(renamed).toEqual(first)
    expect(first).toEqual({
      serviceName: 'ProxyDesktopTun_3eb50362e7a8526c',
      pipeName: 'proxy-desktop-tun-3eb50362e7a8526c',
      namespaceId: 'proxy-desktop-3eb50362e7a8526c'
    })
  })

  it('separates unrelated application identities', () => {
    expect(tunServiceIdentity('io.example.one')).not.toEqual(tunServiceIdentity('io.example.two'))
  })

  it('keeps both packaged service templates aligned with the current brand identity', () => {
    const identity = tunServiceIdentity(brand.appId)
    for (const arch of ['x64', 'arm64']) {
      const template = JSON.parse(readFileSync(`resources/tun-service/${arch}/service-template.json`, 'utf8'))
      expect(template).toMatchObject({
        ...identity,
        clientExecutableName: brand.executableName
      })
    }
  })
})
