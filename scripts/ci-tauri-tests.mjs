import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

if (process.platform !== 'win32') throw new Error('This Cargo test manifest preparation requires Windows')
// Tauri's main executable already embeds its manifest. Cargo's library test
// executable does not inherit that resource and otherwise binds ComCtl32 v5,
// which lacks Tauri's TaskDialogIndirect import. An adjacent manifest supplies
// the same v6 dependency without adding a duplicate resource to the main exe.
// https://learn.microsoft.com/en-us/windows/win32/controls/cookbook-overview
const manifest = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="Tauri.Cargo.Tests" version="1.0.0.0" processorArchitecture="*" />
  <dependency><dependentAssembly>
    <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
  </dependentAssembly></dependency>
</assembly>
`
const built = spawnSync('cargo', ['test', '--locked', '--no-run', '--message-format=json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (built.stderr) process.stderr.write(built.stderr)
if (built.error) throw built.error
if (built.status !== 0) {
  process.stdout.write(built.stdout || '')
  process.exit(built.status ?? 1)
}
let count = 0
for (const line of built.stdout.split(/\r?\n/)) {
  if (!line.trim()) continue
  const artifact = JSON.parse(line)
  if (artifact.reason === 'compiler-artifact' && artifact.profile.test && artifact.executable?.endsWith('.exe')) {
    await writeFile(`${artifact.executable}.manifest`, manifest)
    count++
  }
}
if (!count) throw new Error('Cargo reported no Windows test executables')
console.log(`Prepared Common Controls v6 manifests for ${count} Cargo test executables`)
// No filters, disabled tests or success fallback: propagate the full suite.
// These tests launch real Node fixtures and loopback listeners. Avoid starving
// their unchanged readiness deadlines on the shared two-core Windows runner.
const tested = spawnSync('cargo', ['test', '--locked', '--', '--include-ignored'], {
  stdio: 'inherit', env: { ...process.env, RUST_TEST_THREADS: process.env.RUST_TEST_THREADS || '1' }
})
if (tested.error) throw tested.error
process.exit(tested.status ?? 1)
