import { describe, it, expect, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createSystemProxy } from '../src/main/system-proxy/factory'

/** Recursively list every TS/Vue source file under a directory. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === '.next') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      out.push(...listSourceFiles(path))
    } else if (/\.(ts|vue)$/.test(name)) {
      out.push(path)
    }
  }
  return out
}

function contents(path: string): string {
  return readFileSync(path, 'utf8')
}

function absPath(relative: string): string {
  return join(process.cwd(), relative)
}

const RENDERER_DIR = absPath('src/renderer/src')
const PRELOAD = absPath('src/preload/index.ts')
const SHARED_DIR = absPath('src/shared')
const SYSTEM_PROXY_DIR = absPath('src/main/system-proxy')

// Tokens that would mutate a real system proxy / reach into Node from a context
// that must not have it. A single hit anywhere but the Windows adapter is a bug.
const REAL_NETWORK_TOKENS = ['reg.exe', 'powershell', 'InternetSetOption']
const NODE_IMPORT_TOKEN = /from\s+['"]node:/
const CHILD_PROCESS_TOKEN = /['"]\.?\.?\/?node:child_process['"]|require\(['"]child_process['"]/

describe('system-proxy runtime platform safety', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform!)
  })

  function runWithPlatform(platform: NodeJS.Platform, fn: () => void): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    fn()
  }

  it('is Unsupported on a non-Windows, non-dev runtime and cannot mutate the registry', () => {
    runWithPlatform('darwin', () => {
      const service = createSystemProxy({
        appDataBase: '/tmp',
        isDev: false,
        kernel: {} as never,
        mihomo: { getVersion: async () => ({}), getConfig: async () => ({}) as never } as never
      })
      expect(service.getStatus().phase).toBe('unsupported')
      expect(service.getStatus().supported).toBe(false)
    })
  })

  it('uses the fake adapter in the dev build (never a real registry)', () => {
    const service = createSystemProxy({
      appDataBase: '/tmp',
      isDev: true,
      kernel: {} as never,
      mihomo: { getVersion: async () => ({}), getConfig: async () => ({}) as never } as never
    })
    expect(service.getStatus().supported).toBe(true)
  })
})

/** Drop block and line comments so we only scan executable code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('system-proxy static confinement', () => {
  it('confines every real-network mutation token to the Windows adapter folder', () => {
    const systemProxyFiles = listSourceFiles(SYSTEM_PROXY_DIR)
    const offenders: string[] = []
    for (const file of systemProxyFiles) {
      if (file.replace(/\\/g, '/').includes('adapters/windows-adapter.ts') || file.endsWith('windows-helpers.ts')) continue
      const code = stripComments(contents(file))
      for (const token of REAL_NETWORK_TOKENS) {
        if (code.includes(token)) {
          offenders.push(`${file.replace(process.cwd() + '/', '')} :: ${token}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('is not vacuous: the Windows adapter actually mutates the registry via subprocess', () => {
    const code = contents(absPath('src/main/system-proxy/adapters/windows-adapter.ts'))
    expect(code).toContain('execFile')
    expect(code).toContain('reg.exe')
    expect(code).toContain('powershell')
  })

  it('confines subprocess execution to the Windows adapter folder', () => {
    const systemProxyFiles = listSourceFiles(SYSTEM_PROXY_DIR)
    const offenders = systemProxyFiles
      .filter(
        (file) =>
          !file.endsWith('windows-adapter.ts') &&
          !file.endsWith('windows-helpers.ts') &&
          /execFile|spawn\(|node:child_process/.test(contents(file))
      )
      .map((file) => file.replace(process.cwd() + '/', ''))
    expect(offenders).toEqual([])
  })

  it('keeps Node platform / registry references out of the browser renderer', () => {
    const offenders: string[] = []
    for (const file of listSourceFiles(RENDERER_DIR)) {
      const source = contents(file)
      for (const token of [...REAL_NETWORK_TOKENS]) {
        if (source.includes(token)) offenders.push(`${file.replace(process.cwd() + '/', '')} :: ${token}`)
      }
      if (CHILD_PROCESS_TOKEN.test(source)) {
        offenders.push(`${file.replace(process.cwd() + '/', '')} :: child_process`)
      }
      if (/\bprocess\.platform\b/.test(source)) {
        offenders.push(`${file.replace(process.cwd() + '/', '')} :: process.platform`)
      }
      if (NODE_IMPORT_TOKEN.test(source)) {
        offenders.push(`${file.replace(process.cwd() + '/', '')} :: node: import`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps Node / registry references out of the sandboxed preload bridge', () => {
    const source = contents(PRELOAD)
    const offenders: string[] = []
    for (const token of REAL_NETWORK_TOKENS) {
      if (source.includes(token)) offenders.push(`preload :: ${token}`)
    }
    if (CHILD_PROCESS_TOKEN.test(source)) offenders.push('preload :: child_process')
    if (NODE_IMPORT_TOKEN.test(source)) offenders.push('preload :: node: import')
    expect(offenders).toEqual([])
  })

  it('keeps Node / registry references out of the shared contracts', () => {
    const offenders: string[] = []
    for (const file of listSourceFiles(SHARED_DIR)) {
      const source = contents(file)
      for (const token of REAL_NETWORK_TOKENS) {
        if (source.includes(token)) offenders.push(`${file.replace(process.cwd() + '/', '')} :: ${token}`)
      }
      if (NODE_IMPORT_TOKEN.test(source)) offenders.push(`${file.replace(process.cwd() + '/', '')} :: node: import`)
    }
    expect(offenders).toEqual([])
  })
})
