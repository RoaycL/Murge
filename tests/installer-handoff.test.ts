import { describe, expect, it } from 'vitest'
import {
  elevatedHelperScript,
  elevationRequestScript,
  encodePowerShell,
  psLiteral
} from '../src/main/updates/installer-handoff'
import type { InstallerHandoff } from '../src/main/updates/installer-handoff'

const handoff: InstallerHandoff = {
  installerPath: "C:\\Users\\O'Neil\\AppData\\Local\\Temp\\murge-update\\Murge_0.9.34_x64-setup.exe",
  installerArgs: ['/P', '/R'],
  parentPid: 4242,
  traceFile: 'C:\\Temp\\murge-update\\install-trace.txt',
  failureFile: 'C:\\Temp\\murge-update\\install-failure.txt'
}

const decode = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le')

describe('installer hand-off', () => {
  it('quotes PowerShell literals', () => {
    expect(psLiteral("a'b")).toBe("'a''b'")
  })

  it('runs the installer from the elevated helper once the app has exited', () => {
    const script = elevatedHelperScript(handoff)
    expect(script).toContain('Wait-Process -Id 4242')
    expect(script).toContain("-FilePath 'C:\\Users\\O''Neil\\AppData\\Local\\Temp\\murge-update\\Murge_0.9.34_x64-setup.exe'")
    expect(script).toContain("-ArgumentList '/P','/R'")
    // Already elevated: the installer must not raise a second prompt, and it
    // must be visible.
    expect(script).not.toContain('RunAs')
    expect(script).toContain('-WindowStyle Normal')
    expect(script).toContain(`Set-Content -LiteralPath '${handoff.failureFile}'`)
  })

  it('asks for elevation in the app-side step and embeds the helper', () => {
    const script = elevationRequestScript(handoff, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(script).toContain('-Verb RunAs')
    expect(script).toContain('exit 0')
    expect(script).toContain('exit 1')
    const encoded = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(script)?.[1]
    expect(encoded).toBeDefined()
    expect(decode(encoded!)).toBe(elevatedHelperScript(handoff))
  })

  it('encodes scripts as UTF-16LE base64', () => {
    expect(decode(encodePowerShell('Write-Output 中文'))).toBe('Write-Output 中文')
  })
})
