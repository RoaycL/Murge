import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

const read = (path: string): Promise<string> => readFile(path, 'utf8')

describe('read-only Wintun ABI audit', () => {
  it('pins the official archive/header/DLL digests', async () => {
    const script = await read('scripts/verify-wintun-sdk.ps1')
    expect(script).toContain('07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51')
    expect(script).toContain('510a5984fbf73efd21a61ada60edfe05e1a38a77c8c47f6d62e0ab1cdbdd460f')
    expect(script).toContain('e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce')
    expect(script).toContain('f7ba89005544be9d85231a9e0d5f23b2d15b3311667e2dad0debd344918a3f80')
  })

  it('compiles against official wintun.h and resolves exports without invoking an API', async () => {
    const source = await read('native/wintun-abi-audit/abi-audit.cpp')
    expect(source).toContain('#include <wintun.h>')
    expect(source).toContain('static_assert(sizeof(NET_LUID) == 8)')
    expect(source).toContain('GetProcAddress(module, name)')
    expect(source).toContain('WINTUN_API_INVOKED=false')
    expect(source).not.toMatch(/\b(?:create_adapter|open_adapter|close_adapter|start_session|end_session)\s*\(/)
  })

  it('keeps the audit on a hosted Windows runner and outside the authorized G1 lab job', async () => {
    const workflow = await read('.github/workflows/wintun-abi-audit.yml')
    expect(workflow).toContain('runs-on: windows-2025')
    expect(workflow).not.toContain('murge-tun-lab')
    expect(workflow).not.toContain('MURGE_RUN_REAL_TUN')
  })
})
