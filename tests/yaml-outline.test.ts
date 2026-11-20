import { describe, expect, it } from 'vitest'
import { analyzeYaml, highlightYamlLine } from '../src/shared/yaml-outline'

const sample = [
  'mixed-port: 7890',
  'allow-lan: false',
  '# nodes',
  'proxies:',
  '  - { name: "HK 01", type: ss, server: hk.example.com, port: 443 }',
  '  - name: JP 01',
  '    type: vmess',
  'proxy-groups:',
  '  - name: Proxy',
  '    type: select',
  '    proxies: [HK 01, JP 01]',
  'dns:',
  '  enable: true',
  '  nameserver: [223.5.5.5]',
  'rules:',
  '  - DOMAIN-SUFFIX,example.com,Proxy',
  '  - MATCH,DIRECT',
  ''
].join('\n')

describe('analyzeYaml', () => {
  it('lists top-level sections with their line and size', () => {
    const result = analyzeYaml(sample)
    expect(result.problems).toEqual([])
    expect(result.lines).toBe(18)
    expect(result.sections).toEqual([
      { key: 'mixed-port', line: 1, kind: 'value', value: '7890' },
      { key: 'allow-lan', line: 2, kind: 'value', value: 'false' },
      { key: 'proxies', line: 4, kind: 'list', count: 2 },
      { key: 'proxy-groups', line: 8, kind: 'list', count: 1 },
      { key: 'dns', line: 12, kind: 'map', count: 2 },
      { key: 'rules', line: 15, kind: 'list', count: 2 }
    ])
  })

  it('reports syntax errors with line numbers instead of throwing', () => {
    const result = analyzeYaml('port: 7890\nproxies:\n  - name: a\n    type: [ss\nrules: []\n')
    const errors = result.problems.filter((p) => p.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].line).toBeGreaterThanOrEqual(4)
    expect(errors[0].message).not.toContain('\n')
  })

  it('handles empty and non-map documents', () => {
    expect(analyzeYaml('')).toMatchObject({ lines: 1, sections: [], problems: [] })
    expect(analyzeYaml('- a\n- b\n').sections).toEqual([])
  })
})

describe('highlightYamlLine', () => {
  it('colours keys, values and comments and escapes HTML', () => {
    expect(highlightYamlLine('mixed-port: 7890 # http')).toBe('<span class="yt-key">mixed-port</span><span class="yt-punct">:</span> <span class="yt-num">7890</span> <span class="yt-comment"># http</span>')
    expect(highlightYamlLine('  - name: <b>&')).toBe('  <span class="yt-punct">- </span><span class="yt-key">name</span><span class="yt-punct">:</span> <span class="yt-str">&lt;b&gt;&amp;</span>')
    expect(highlightYamlLine('  enable: true')).toContain('yt-bool')
    expect(highlightYamlLine('url: "http://a#b"')).not.toContain('yt-comment')
  })

  it('keeps the exact source text so the overlay lines up', () => {
    const strip = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    for (const line of sample.split('\n').concat(['  - DOMAIN,a.com,"x # y" # c', 'key: |-', '--- ', "'q': 'it''s'", '  - [a, {b: c}]'])) {
      expect(strip(highlightYamlLine(line))).toBe(line)
    }
  })
})
