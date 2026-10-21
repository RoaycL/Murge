// Inspect imports without executing a failed test binary or hiding its result.
// PE layout: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export function imports(bytes) {
  const pe = bytes.readUInt32LE(0x3c)
  if (bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('Invalid PE signature')
  const optional = pe + 24
  const wide = bytes.readUInt16LE(optional) === 0x20b
  const sections = optional + bytes.readUInt16LE(pe + 20)
  const count = bytes.readUInt16LE(pe + 6)
  const offset = (rva) => {
    for (let i = 0; i < count; i++) {
      const section = sections + 40 * i
      const start = bytes.readUInt32LE(section + 12)
      const size = Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16))
      if (rva >= start && rva < start + size) return bytes.readUInt32LE(section + 20) + rva - start
    }
    throw new Error(`Unmapped PE RVA ${rva}`)
  }
  const string = (at) => bytes.toString('ascii', at, bytes.indexOf(0, at))
  const directory = bytes.readUInt32LE(optional + (wide ? 112 : 96) + 8)
  if (!directory) return []
  const result = []
  for (let entry = offset(directory); bytes.readUInt32LE(entry + 12); entry += 20) {
    const library = string(offset(bytes.readUInt32LE(entry + 12)))
    const table = offset(bytes.readUInt32LE(entry) || bytes.readUInt32LE(entry + 16))
    const symbols = []
    for (let at = table; ; at += wide ? 8 : 4) {
      const value = wide ? bytes.readBigUInt64LE(at) : BigInt(bytes.readUInt32LE(at))
      if (!value) break
      const ordinal = value & (wide ? 1n << 63n : 1n << 31n)
      symbols.push(ordinal ? Number(value & 0xffffn) : string(offset(Number(value)) + 2))
    }
    result.push({ library, symbols })
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.platform !== 'win32') throw new Error('Windows loader diagnosis requires Windows')
  const output = resolve(process.env.RUNNER_TEMP, 'tauri-loader-diagnostics')
  await mkdir(output, { recursive: true })
  const directory = resolve('src-tauri/target/debug/deps')
  const candidates = await Promise.all((await readdir(directory)).filter((name) => /^murge_lib-.*\.exe$/.test(name)).map(async (name) => ({ path: resolve(directory, name), modified: (await stat(resolve(directory, name))).mtimeMs })))
  candidates.sort((a, b) => b.modified - a.modified)
  if (!candidates.length) throw new Error('No Rust test executable to inspect')
  const input = resolve(output, 'imports.json')
  await writeFile(input, JSON.stringify({ executable: candidates[0].path, imports: imports(await readFile(candidates[0].path)) }, null, 2))
  const script = resolve(output, 'probe.ps1')
  await writeFile(script, String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class LoaderProbe {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr LoadLibraryW(string name);
 [DllImport("kernel32.dll",CharSet=CharSet.Ansi,ExactSpelling=true,SetLastError=true)] public static extern IntPtr GetProcAddress(IntPtr module,string name);
 [DllImport("kernel32.dll",EntryPoint="GetProcAddress",ExactSpelling=true,SetLastError=true)] public static extern IntPtr GetOrdinal(IntPtr module,IntPtr ordinal);
}
'@
$report=Get-Content -Raw $env:CI_TAURI_IMPORTS|ConvertFrom-Json
$missing=@()
foreach($library in $report.imports) {
 $handle=[LoaderProbe]::LoadLibraryW($library.library)
 if($handle -eq [IntPtr]::Zero){$missing+=@{library=$library.library;error=[Runtime.InteropServices.Marshal]::GetLastWin32Error()};continue}
 foreach($symbol in $library.symbols){
  $address=if($symbol -is [string]){[LoaderProbe]::GetProcAddress($handle,$symbol)}else{[LoaderProbe]::GetOrdinal($handle,[IntPtr]([int]$symbol))}
  if($address -eq [IntPtr]::Zero){$missing+=@{library=$library.library;symbol=$symbol;error=[Runtime.InteropServices.Marshal]::GetLastWin32Error()}}
 }
}
@{executable=$report.executable;missing=$missing;os=[Environment]::OSVersion.VersionString}|ConvertTo-Json -Depth 6
`)
  // Windows PowerShell's .NET Framework compiler cannot use verbatim temp
  // paths. Keep Rust's canonical path environment scoped to the Rust process.
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, TEMP: process.env.RUNNER_TEMP, TMP: process.env.RUNNER_TEMP, CI_TAURI_IMPORTS: input } })
  await writeFile(resolve(output, 'result.json'), result)
  console.log(result)
}
