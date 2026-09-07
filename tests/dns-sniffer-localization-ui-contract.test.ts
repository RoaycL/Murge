import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function read(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8')
}

describe('DNS and sniffer localization UI contract', () => {
  it('uses Chinese field labels and one shared line-entry hint per group', async () => {
    const [dns, sniffer] = await Promise.all([
      read('src/renderer/src/components/DnsSettingsPanel.vue'),
      read('src/renderer/src/components/SnifferSettingsPanel.vue')
    ])

    expect(dns).toContain('默认解析服务器')
    expect(dns).toContain('代理节点解析服务器（可选）')
    expect(dns).toContain('域名分流策略（域名规则 服务器）')
    expect(dns).toContain('下列输入框均每行填写一个服务器地址')
    expect(dns).not.toMatch(/>\s*(?:Nameserver|default-nameserver|nameserver|fallback|proxy-server-nameserver|direct-nameserver|hosts|nameserver-policy)/)

    expect(sniffer).toContain('域名嗅探增强')
    expect(sniffer).toContain('覆盖目标地址')
    expect(sniffer).toContain('跳过嗅探的域名')
    expect(sniffer).toContain('每行填写一个端口、端口范围或 *')
    expect(sniffer).not.toMatch(/>\s*(?:override-destination|force-dns-mapping|parse-pure-ip|skip-domain|force-domain|skip-src-address|skip-dst-address)/)

    expect(dns).not.toContain('每行一个')
    expect(sniffer).not.toContain('每行一个')
  })
})
