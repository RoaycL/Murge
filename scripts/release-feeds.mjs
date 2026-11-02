// Decides which update feeds a Tauri release moves. Each feed is a fixed
// GitHub pre-release whose `latest.json` the release workflow rewrites:
//
// - `update-stable`: 正式版 only. Followed when "包括 Beta 版本" is off.
// - `update-beta`: the newest of 正式版 and Beta. Followed when it is on.
// - `channel-experimental`: the retired experimental channel that Tauri
//   builds up to 0.9.37 follow; it keeps receiving 正式版 so they upgrade.
//
// (`channel-stable`, the retired Electron channel, is left to release.yml on
// main: it stays on the last Electron build, which moves its users here.)
//
// A Beta never reaches a stable feed (Tauri builds up to 0.9.37 cannot even
// parse its version), and a 正式版 replaces the beta feed only when it is
// newer than the Beta already there.
//
// Usage (prints the feed tags, one per line):
//   node scripts/release-feeds.mjs --version 1.0.0 [--beta-feed-version 1.1.0-beta.1]
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STABLE_FEED = 'update-stable'
export const BETA_FEED = 'update-beta'
export const LEGACY_TAURI_FEED = 'channel-experimental'

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/** `x.y.z` or `x.y.z-pre` (no build metadata), or null. */
export function parseVersion(version) {
  const match = VERSION.exec(String(version ?? '').trim().replace(/^v/, ''))
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : []
  }
}

export function isPrerelease(version) {
  const parsed = parseVersion(version)
  if (!parsed) throw new Error(`invalid version: ${version}`)
  return parsed.pre.length > 0
}

/** SemVer precedence: negative, zero or positive like a sort comparator. */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new Error(`invalid version: ${a ? right : left}`)
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index]
  }
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index]
    const y = b.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return Number(x) - Number(y)
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * The feeds a release of `version` moves, given the version the beta feed
 * announces now (null when it has none yet).
 */
export function feedsFor(version, betaFeedVersion = null) {
  if (isPrerelease(version)) return [BETA_FEED]
  const feeds = [STABLE_FEED]
  if (!betaFeedVersion || compareVersions(version, betaFeedVersion) > 0) feeds.push(BETA_FEED)
  feeds.push(LEGACY_TAURI_FEED)
  return feeds
}

function argValue(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? null : (argv[index + 1] ?? null)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2)
    const version = argValue(argv, '--version')
    if (!version) throw new Error('--version is required')
    const betaFeedVersion = argValue(argv, '--beta-feed-version') || null
    process.stdout.write(`${feedsFor(version, betaFeedVersion).join('\n')}\n`)
  } catch (error) {
    process.stderr.write(`release-feeds: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
