import { describe, expect, it } from 'vitest'
import {
  elevatedHelperScript,
  elevationRequestScript,
  encodePowerShell,
  helperScriptFile,
  jsLiteral,
  psLiteral,
  windowsArg
} from '../src/main/updates/installer-handoff'
import type { InstallerHandoff } from '../src/main/updates/installer-handoff'

const handoff: InstallerHandoff = {
  installerPath: "C:\\Users\\O'Neil Lee\\AppData\\Local\\Temp\\app-update\\App_0.9.34_x64-setup.exe",
  installerArgs: ['/P', '/R'],
  parentPid: 4242,
  helperFile: 'C:\\Users\\O\'Neil Lee\\AppData\\Local\\Temp\\app-update\\install-helper.js',
  traceFile: 'C:\\Temp\\murge-update\\install-trace.txt',
  failureFile: 'C:\\Temp\\murge-update\\install-failure.txt'
}

const decode = (encoded: string): string => Buffer.from(encoded, 'base64').toString('utf16le')

describe('installer hand-off', () => {
  it('quotes PowerShell literals', () => {
    expect(psLiteral("a'b")).toBe("'a''b'")
    expect(psLiteral('O\u2019Neil')).toBe("'O\u2019\u2019Neil'")
  })

  it('quotes JScript literals and Windows command-line arguments', () => {
    expect(jsLiteral('C:\\a "b"\u2028')).toBe('"C:\\\\a \\"b\\"\\u2028"')
    expect(windowsArg('/P')).toBe('/P')
    expect(windowsArg('C:\\Program Files\\x.exe')).toBe('"C:\\Program Files\\x.exe"')
    expect(windowsArg('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"')
    expect(windowsArg('')).toBe('""')
  })

  it('runs the installer from the elevated helper once the app has exited', () => {
    const script = elevatedHelperScript(handoff)
    expect(script).toContain('WHERE ProcessId = 4242')
    expect(script).toContain(
      `Run(${jsLiteral(`"${handoff.installerPath}" /P /R`)}, 1, true)`
    )
    // Already elevated: the installer must not raise a second prompt, and no
    // console program is involved.
    expect(script).not.toContain('RunAs')
    expect(script).not.toMatch(/powershell/i)
    expect(script).toContain(jsLiteral(handoff.failureFile))
  })

  it('saves the helper as UTF-16LE with a BOM', () => {
    const file = helperScriptFile({ ...handoff, installerPath: 'C:\\用户\\setup.exe' })
    expect([...file.subarray(0, 2)]).toEqual([0xff, 0xfe])
    expect(file.subarray(2).toString('utf16le')).toContain('用户')
  })

  it('asks for elevation of the script host in the app-side step', () => {
    const script = elevationRequestScript(handoff, 'C:\\Windows\\System32\\wscript.exe')
    expect(script).toContain("-FilePath 'C:\\Windows\\System32\\wscript.exe'")
    expect(script).toContain('-Verb RunAs')
    // Start-Process joins arguments with spaces: the path keeps its quotes.
    expect(script).toContain(`'"C:\\Users\\O''Neil Lee\\AppData\\Local\\Temp\\app-update\\install-helper.js"'`)
    expect(script).toContain('exit 0')
    expect(script).toContain('exit 1')
  })

  it('encodes scripts as UTF-16LE base64', () => {
    expect(decode(encodePowerShell('Write-Output 中文'))).toBe('Write-Output 中文')
  })
})
