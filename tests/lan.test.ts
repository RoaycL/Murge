import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { describeDevice, isThisHost, lanAddresses, type LocalAddress } from '../src/shared/lan'

const local: LocalAddress[] = [
  { name: 'WLAN', address: '192.168.1.167', lan: true },
  { name: 'vEthernet (WSL)', address: '172.24.16.1', lan: false }
]

describe('局域网设备 helpers', () => {
  it('tells this PC apart from other LAN devices by source address', () => {
    expect(describeDevice('127.0.0.1', ['HTTP'], local)).toBe('本机 · 回环地址')
    expect(describeDevice('198.18.0.1', ['Tun'], local)).toBe('本机 · TUN')
    expect(describeDevice('192.168.1.167', ['Mixed'], local)).toBe('本机')
    expect(describeDevice('172.24.16.1', ['Mixed'], local)).toBe('本机')
    expect(describeDevice('192.168.1.23', ['Mixed'], local)).toBe('局域网设备 · 代理')
    // Gateway mode: a LAN device routed into TUN keeps its own source IP.
    expect(describeDevice('192.168.1.23', ['Tun'], local)).toBe('局域网设备 · 网关')
    expect(describeDevice('::ffff:10.0.0.5', ['Socks5'], local)).toBe('局域网设备 · 代理')
    expect(describeDevice('8.8.8.8', ['Mixed'], local)).toBe('其他地址')
  })

  it('treats loopback, the TUN range and own addresses as this host', () => {
    expect(isThisHost('::1', [])).toBe(true)
    expect(isThisHost('198.19.255.1', [])).toBe(true)
    expect(isThisHost('192.168.1.167', local)).toBe(true)
    expect(isThisHost('192.168.1.23', local)).toBe(false)
  })

  it('offers only LAN-reachable addresses for other devices to dial', () => {
    expect(lanAddresses(local).map((entry) => entry.address)).toEqual(['192.168.1.167'])
  })
})

describe('局域网设备接管 UI contract', () => {
  it('puts the allow-lan switch and gateway card on 概览', async () => {
    const overview = await readFile('src/renderer/src/views/OverviewView.vue', 'utf8')
    expect(overview).toMatch(/<h2>局域网设备接管<\/h2>/)
    expect(overview).toMatch(/<h3>HTTP 与 SOCKS5 代理<\/h3>/)
    expect(overview).toMatch(/@click\.stop="toggleAllowLan"/)
    // A quick switch must never save the defaults over unread settings.
    expect(overview).toMatch(/!core\.hydrated/)
    expect(overview).toMatch(/代理监听在 \$\{primaryLan\.value\}:\$\{core\.settings\.mixedPort\}/)
    expect(overview).toMatch(/<h3>网关模式<\/h3>/)
    expect(overview).toMatch(/openSettings\('gateway'\)/)
    // 网关模式 is a real switch now: forwarding is applied for the user.
    expect(overview).toMatch(/@click\.stop="toggleGateway"/)
    expect(overview).toMatch(/lan\.setGateway\(!gatewayEnabled\.value, gatewayDevice\.value\)/)
    expect(overview).not.toMatch(/不提供 DHCP/)
  })

  it('hosts the gateway guide on the 网络 page', async () => {
    const network = await readFile('src/renderer/src/views/NetworkSettingsView.vue', 'utf8')
    const panel = await readFile('src/renderer/src/components/LanGatewayPanel.vue', 'utf8')
    expect(network).toMatch(/<LanGatewayPanel \/>/)
    // The manual command stays only as a fallback behind the switch.
    expect(panel).toMatch(/<details class="gateway-manual">/)
    expect(panel).toMatch(/Set-NetIPInterface/)
    expect(panel).toMatch(/lan\.setGateway\(/)
    expect(panel).not.toMatch(/不提供 DHCP/)
  })
})
