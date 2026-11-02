import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifyChanges, isDocsPath, onlyVersionChanged, releaseState } from '../scripts/ci-gate.mjs'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const workflow = (name: string) => read(`.github/workflows/${name}`)

const bumpJson = (text: string, from: string, to: string) => text.split(`"version": "${from}"`).join(`"version": "${to}"`)

describe('CI gate: version-only changes', () => {
  const pkg = JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { vue: '^3.5.0' } }, null, 2)
  const lock = JSON.stringify(
    {
      name: 'app',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'app', version: '1.0.0' }, 'node_modules/vue': { version: '3.5.0' } }
    },
    null,
    2
  )
  const toml = '[package]\nname = "murge"\nversion = "1.0.0"\n\n[dependencies]\nserde = { version = "1" }\n'
  const cargoLock =
    'version = 4\n\n[[package]]\nname = "murge"\nversion = "1.0.0"\ndependencies = [\n "serde",\n]\n\n' +
    '[[package]]\nname = "serde"\nversion = "1.0.1"\nchecksum = "aa"\n'

  it('accepts a bump of the app version in every version file', () => {
    expect(onlyVersionChanged('package.json', pkg, bumpJson(pkg, '1.0.0', '1.0.1-beta.1'))).toBe(true)
    expect(onlyVersionChanged('package-lock.json', lock, bumpJson(lock, '1.0.0', '1.0.1-beta.1'))).toBe(true)
    expect(onlyVersionChanged('src-tauri/Cargo.toml', toml, toml.replace('version = "1.0.0"', 'version = "1.0.1"'))).toBe(true)
    expect(
      onlyVersionChanged('src-tauri/Cargo.lock', cargoLock, cargoLock.replace('version = "1.0.0"', 'version = "1.0.1"'), 'murge')
    ).toBe(true)
  })

  it('rejects dependency changes hidden next to the bump', () => {
    expect(onlyVersionChanged('package.json', pkg, pkg.replace('^3.5.0', '^3.6.0'))).toBe(false)
    expect(onlyVersionChanged('package-lock.json', lock, lock.replace('"3.5.0"', '"3.6.0"'))).toBe(false)
    expect(onlyVersionChanged('src-tauri/Cargo.toml', toml, toml.replace('{ version = "1" }', '{ version = "2" }'))).toBe(false)
    expect(onlyVersionChanged('src-tauri/Cargo.lock', cargoLock, cargoLock.replace('1.0.1', '1.0.2'), 'murge')).toBe(false)
    expect(onlyVersionChanged('src-tauri/Cargo.lock', cargoLock, cargoLock.replace('1.0.0', '1.0.1'), null)).toBe(false)
    expect(onlyVersionChanged('package.json', pkg, '{ broken')).toBe(false)
  })

  it('treats docs as untested and everything else as code', () => {
    expect(isDocsPath('docs/release-notes-template.md')).toBe(true)
    expect(isDocsPath('docs/screenshots/a.png')).toBe(true)
    expect(isDocsPath('README.md')).toBe(true)
    expect(isDocsPath('docs/schemas/brand.schema.json')).toBe(false)
    expect(isDocsPath('resources/THIRD_PARTY_NOTICES.md')).toBe(false)
    expect(isDocsPath('src/renderer/src/App.vue')).toBe(false)
  })

  it('classifies a release bump as version-only and a code change as code', () => {
    const bump = [
      { path: 'package.json', status: 'M', before: pkg, after: bumpJson(pkg, '1.0.0', '1.0.1') },
      { path: 'docs/release-notes-template.md', status: 'M' }
    ]
    expect(classifyChanges(bump, 'murge').versionOnly).toBe(true)
    expect(classifyChanges([...bump, { path: 'src/main/index.ts', status: 'M' }], 'murge')).toEqual({
      versionOnly: false,
      reason: 'src/main/index.ts changed'
    })
    expect(classifyChanges([{ path: 'package.json', status: 'A', after: pkg }], 'murge').versionOnly).toBe(false)
  })

  it('accepts the real repository version files as bumpable', () => {
    for (const path of ['package.json', 'package-lock.json']) {
      const text = read(path)
      const version = JSON.parse(text).version
      expect(onlyVersionChanged(path, text, bumpJson(text, version, '99.0.0'))).toBe(true)
    }
    const cargo = read('src-tauri/Cargo.toml')
    const version = /^version = "([^"]+)"/m.exec(cargo)![1]
    expect(onlyVersionChanged('src-tauri/Cargo.toml', cargo, cargo.replace(`version = "${version}"`, 'version = "99.0.0"'))).toBe(true)
    const cargoLockText = read('src-tauri/Cargo.lock')
    const bumped = cargoLockText.replace(`name = "murge"\nversion = "${version}"`, 'name = "murge"\nversion = "99.0.0"')
    expect(bumped).not.toBe(cargoLockText)
    expect(onlyVersionChanged('src-tauri/Cargo.lock', cargoLockText, bumped, 'murge')).toBe(true)
  })
})

describe('CI gate: release reuse', () => {
  const run = (status: string, conclusion: string | null) => ({ status, conclusion })
  it('reuses a pass, refuses a failure and otherwise waits or tests again', () => {
    expect(releaseState([run('completed', 'failure'), run('completed', 'success')])).toBe('passed')
    expect(releaseState([run('completed', 'failure')])).toBe('failed')
    expect(releaseState([run('completed', 'failure'), run('in_progress', null)])).toBe('pending')
    expect(releaseState([run('completed', 'cancelled')])).toBe('missing')
    expect(releaseState([])).toBe('missing')
  })
})

describe('CI gate wiring', () => {
  it('gates every pull-request CI workflow behind the shared gate job', () => {
    for (const name of ['ci.yml', 'tauri-build.yml', 'tauri-gui-smoke.yml', 'tauri-rust.yml']) {
      const text = workflow(name)
      expect(text, name).toContain('run: node scripts/ci-gate.mjs gate')
      expect(text, name).toContain("needs.gate.outputs.run == 'true'")
      expect(text, name).toContain('actions: read')
    }
  })

  it('lets the release skip only the checks CI already passed on the tagged commit', () => {
    const release = workflow('tauri-release.yml')
    expect(release).toContain('node scripts/ci-gate.mjs release')
    const build = release.slice(release.indexOf('\n  build:'), release.indexOf('\n  publish:'))
    expect(build).toContain("needs.version.outputs.ci_verified != 'true'")
    expect(build).toContain('run: npm run license:check')
    expect(build).toContain('run: npm run brand:check')
  })
})
