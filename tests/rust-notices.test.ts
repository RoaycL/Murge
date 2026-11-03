import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

function lockPackages(lock: string): string[] {
  const packages: string[] = []
  for (const block of lock.replace(/\r\n?/g, '\n').split('[[package]]').slice(1)) {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1]
    const version = block.match(/^version = "([^"]+)"$/m)?.[1]
    const source = block.match(/^source = "([^"]+)"$/m)?.[1]
    if (name && version && source?.startsWith('registry+')) packages.push(`${name} ${version}`)
  }
  return packages.sort()
}

describe('Rust crate notices', () => {
  it('lists exactly the registry crates of Cargo.lock (run npm run notices:rust after a lock change)', async () => {
    const [lock, notices] = await Promise.all([read('src-tauri/Cargo.lock'), read('resources/licenses/rust-crates.txt')])
    const listed = notices
      .replace(/\r\n?/g, '\n')
      .split('== Crates (name version | license | repository) ==')[1]
      .split('\n' + '='.repeat(78))[0]
      .split('\n')
      .map((line) => line.split(' | ')[0].trim())
      .filter(Boolean)
      .sort()
    expect(listed).toEqual(lockPackages(lock))
  })

  it('carries a license text for the core runtime crates', async () => {
    const notices = await read('resources/licenses/rust-crates.txt')
    for (const crate of ['tauri ', 'tokio ', 'serde ', 'rquickjs ']) {
      expect(notices).toMatch(new RegExp(`Applies to: [^\\n]*\\b${crate}`))
    }
    expect(notices).toContain('Apache License')
    expect(notices).toContain('Permission is hereby granted')
  })
})
