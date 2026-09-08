import { parse, stringify } from 'yaml'
import type {
  ActiveProfileConfigInspection,
  ProfileConfigSection,
  ProfileConfigSectionInspection
} from '@shared/profiles'
import { profileCompatibilityDiagnostics } from './profile-diagnostics'

const CORE_KEYS = [
  'mode', 'log-level', 'ipv6', 'tcp-concurrent', 'unified-delay',
  'find-process-mode', 'interface-name', 'mixed-port', 'socks-port', 'port',
  'redir-port', 'tproxy-port', 'listeners', 'external-controller',
  'bind-address', 'secret', 'allow-lan', 'external-ui', 'external-ui-name',
  'external-ui-url'
]
const GEODATA_KEYS = ['geodata-mode', 'geodata-loader', 'geo-auto-update', 'geo-update-interval', 'geox-url']

const MANAGED: Record<ProfileConfigSection, string[]> = {
  core: [
    'mixed-port', 'socks-port', 'port', 'redir-port', 'tproxy-port', 'listeners',
    'external-controller', 'bind-address', 'secret', 'allow-lan', 'controller panel'
  ],
  dns: ['dns.listen（移除公开监听）'],
  sniffer: [],
  tun: ['tun.enable', 'tun.device', 'tun.stack', '路由、MTU 与 DNS 劫持'],
  geodata: []
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function safeParse(document: string): Record<string, unknown> {
  try { return record(parse(document)) } catch { return {} }
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) output[key] = source[key]
  }
  return output
}

function excerpt(data: Record<string, unknown>): string {
  const safe = structuredClone(data)
  if ('secret' in safe) safe.secret = '********'
  return Object.keys(safe).length > 0 ? stringify(safe).trim() : '（未配置）'
}

function sectionData(root: Record<string, unknown>, section: ProfileConfigSection): Record<string, unknown> {
  if (section === 'core') return pick(root, CORE_KEYS)
  if (section === 'geodata') return pick(root, GEODATA_KEYS)
  return Object.prototype.hasOwnProperty.call(root, section) ? { [section]: root[section] } : {}
}

function inspection(
  section: ProfileConfigSection,
  profile: Record<string, unknown>,
  effective: Record<string, unknown>,
  notes: string[] = []
): ProfileConfigSectionInspection {
  return {
    profileYaml: excerpt(sectionData(profile, section)),
    effectiveYaml: excerpt(sectionData(effective, section)),
    managedKeys: MANAGED[section],
    notes
  }
}

export function inspectActiveProfileConfig(
  profileName: string | null,
  rawDocument: string,
  effectiveDocument: string,
  options: { coreOverride: boolean; dnsOverride: boolean; snifferOverride: boolean; geodataOverride: boolean; tunEnabled: boolean }
): ActiveProfileConfigInspection {
  const profile = safeParse(rawDocument)
  const effective = safeParse(effectiveDocument)
  return {
    profileName,
    diagnostics: profileCompatibilityDiagnostics(rawDocument),
    sections: {
      core: inspection('core', profile, effective, [
        '监听端口、控制器、访问密钥和局域网监听始终由应用接管。',
        options.coreOverride ? '内核运行覆写已启用，其余受支持字段也以应用设置为准。' : '内核运行覆写未启用，其余受支持字段沿用配置文件。'
      ]),
      dns: inspection('dns', profile, effective, [
        options.dnsOverride ? 'DNS 覆写已启用，应用字段优先，未知字段保留。' : 'DNS 覆写未启用，配置文件字段原样保留；公开 listen 会被移除。'
      ]),
      sniffer: inspection('sniffer', profile, effective, [
        options.snifferOverride ? '嗅探覆写已启用，应用支持的字段优先。' : '嗅探覆写未启用，使用配置文件中的嗅探设置。'
      ]),
      tun: inspection('tun', profile, effective, [
        `TUN 当前${options.tunEnabled ? '已启用' : '未启用'}；启用状态和完整 TUN 参数由应用管理。`
      ]),
      geodata: inspection('geodata', profile, effective, [
        options.geodataOverride ? 'Geodata 覆写已启用，应用设置优先。' : 'Geodata 覆写未启用，使用配置文件中的设置。'
      ])
    }
  }
}
