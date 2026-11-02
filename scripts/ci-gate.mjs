// Keeps CI from testing the same code twice.
//
// `gate` (first job of the CI workflows) prints `run=true|false`:
//
// - A change that only touches the version (package.json, package-lock.json,
//   src-tauri/Cargo.toml, src-tauri/Cargo.lock) and/or docs is not tested
//   again when the commit it builds on already passed this workflow. That is
//   the release bump PR and its merge into main.
// - A push to main whose tree is exactly the tree of the merged pull request's
//   head is not tested again when that head already passed this workflow on
//   the pull request.
// - Everything else (and workflow_dispatch) runs.
//
// A skipped run still concludes `success` (its jobs are skipped), so the chain
// stays sound: a run is only skipped when the code it would test already
// passed.
//
// `release` (version job of tauri-release.yml) prints `verified=true|false`:
// true when CI and the Windows build passed on the tagged commit, so the
// release build need not repeat typecheck and the unit tests. It fails when
// they finished without passing, and prints false (the release then runs the
// tests itself) when they are missing or still running after ten minutes.
//
// Usage: node scripts/ci-gate.mjs gate | release
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'

export const VERSION_FILES = ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']

/** Release gating: the workflows whose checks the release build would repeat. */
export const RELEASE_REQUIRED_WORKFLOWS = ['ci.yml', 'tauri-build.yml']

/** Docs never reach the build or the tests (brand:check ignores .md files). */
export function isDocsPath(path) {
  if (path.startsWith('docs/')) return !path.startsWith('docs/schemas/')
  return !path.includes('/') && path.endsWith('.md')
}

function withoutJsonVersion(path, text) {
  const value = JSON.parse(text)
  delete value.version
  if (path === 'package-lock.json' && value.packages?.['']) delete value.packages[''].version
  return value
}

function cargoPackageName(toml) {
  let section = ''
  for (const line of toml.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (header) section = header[1].trim()
    else if (section === 'package') {
      const name = /^\s*name\s*=\s*"([^"]+)"/.exec(line)
      if (name) return name[1]
    }
  }
  return null
}

function withoutCargoTomlVersion(toml) {
  let section = ''
  return toml
    .split('\n')
    .filter((line) => {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)
      if (header) section = header[1].trim()
      return !(section === 'package' && /^\s*version\s*=/.test(line))
    })
    .join('\n')
}

function withoutCargoLockVersion(lock, crate) {
  return lock
    .split('[[package]]')
    .map((block) =>
      new RegExp(`^name = "${crate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[ \\t]*$`, 'm').test(block)
        ? block.replace(/^version = "[^"]*"[ \t]*\n?/m, '')
        : block
    )
    .join('[[package]]')
}

/**
 * True when `before` -> `after` of a version file changes the app version and
 * nothing else. `crate` is the Cargo package name (for Cargo.lock).
 */
export function onlyVersionChanged(path, before, after, crate) {
  try {
    if (path.endsWith('.json')) return isDeepStrictEqual(withoutJsonVersion(path, before), withoutJsonVersion(path, after))
    if (path === 'src-tauri/Cargo.toml') return withoutCargoTomlVersion(before) === withoutCargoTomlVersion(after)
    if (path === 'src-tauri/Cargo.lock') {
      if (!crate) return false
      return withoutCargoLockVersion(before, crate) === withoutCargoLockVersion(after, crate)
    }
  } catch {
    return false
  }
  return false
}

/**
 * `changes`: [{ path, status ('A'|'M'|'D'), before, after }] (before/after are
 * file contents, only needed for version files). Returns { versionOnly, reason }.
 */
export function classifyChanges(changes, crate) {
  for (const change of changes) {
    if (isDocsPath(change.path)) continue
    if (!VERSION_FILES.includes(change.path)) return { versionOnly: false, reason: `${change.path} changed` }
    if (change.status !== 'M') return { versionOnly: false, reason: `${change.path} added or removed` }
    if (!onlyVersionChanged(change.path, change.before, change.after, crate)) {
      return { versionOnly: false, reason: `${change.path} changed more than the version` }
    }
  }
  return { versionOnly: true, reason: 'only the version and/or docs changed' }
}

// ---------------------------------------------------------------------------

const ZERO_SHA = /^0+$/

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

async function api(path) {
  const response = await fetch(`${process.env.GITHUB_API_URL || 'https://api.github.com'}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28'
    }
  })
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`)
  return response.json()
}

const repo = () => process.env.GITHUB_REPOSITORY

async function runsFor(workflowFile, sha) {
  const { workflow_runs: runs } = await api(
    `/repos/${repo()}/actions/workflows/${workflowFile}/runs?head_sha=${sha}&per_page=50`
  )
  return runs.filter((run) => String(run.id) !== process.env.GITHUB_RUN_ID)
}

async function passed(workflowFile, sha) {
  return (await runsFor(workflowFile, sha)).some((run) => run.conclusion === 'success')
}

function currentWorkflowFile() {
  // owner/repo/.github/workflows/ci.yml@refs/heads/main
  const match = /\/\.github\/workflows\/([^@]+)@/.exec(process.env.GITHUB_WORKFLOW_REF ?? '')
  if (!match) throw new Error(`cannot tell the workflow file from GITHUB_WORKFLOW_REF=${process.env.GITHUB_WORKFLOW_REF}`)
  return match[1]
}

function diffChanges(base, head) {
  const lines = git('diff', '--name-status', '--no-renames', base, head).split('\n').filter(Boolean)
  return lines.map((line) => {
    const [status, path] = line.split('\t')
    const change = { path, status: status[0] }
    if (VERSION_FILES.includes(path) && change.status === 'M') {
      change.before = git('show', `${base}:${path}`)
      change.after = git('show', `${head}:${path}`)
    }
    return change
  })
}

async function gate() {
  const event = process.env.GITHUB_EVENT_NAME
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const head = process.env.GITHUB_SHA
  const workflow = currentWorkflowFile()

  if (event !== 'pull_request' && event !== 'push') return [true, `${event} always runs`]

  // pull_request: GITHUB_SHA is the test merge; its first parent is the base tip.
  const base = event === 'pull_request' ? git('rev-parse', `${head}^1`).trim() : payload.before
  if (base && !ZERO_SHA.test(base)) {
    const crate = cargoPackageName(git('show', `${head}:src-tauri/Cargo.toml`))
    const { versionOnly, reason } = classifyChanges(diffChanges(base, head), crate)
    console.log(`diff ${base.slice(0, 7)}..${head.slice(0, 7)}: ${reason}`)
    if (versionOnly) {
      if (await passed(workflow, base)) return [false, `${reason}; ${base.slice(0, 7)} already passed ${workflow}`]
      console.log(`${base.slice(0, 7)} has no passing ${workflow} run`)
    }
  }

  if (event === 'push') {
    const tree = (await api(`/repos/${repo()}/git/commits/${head}`)).tree.sha
    for (const pr of await api(`/repos/${repo()}/commits/${head}/pulls`)) {
      if (!pr.merged_at) continue
      const prTree = (await api(`/repos/${repo()}/git/commits/${pr.head.sha}`)).tree.sha
      if (prTree !== tree) {
        console.log(`#${pr.number} head ${pr.head.sha.slice(0, 7)} differs from the merged tree`)
        continue
      }
      if (await passed(workflow, pr.head.sha)) {
        return [false, `same tree as #${pr.number} head ${pr.head.sha.slice(0, 7)}, which already passed ${workflow}`]
      }
      console.log(`#${pr.number} head ${pr.head.sha.slice(0, 7)} has no passing ${workflow} run`)
    }
  }

  return [true, 'code changed since the last passing run']
}

/** passed | failed | pending for one workflow on one commit. */
export function releaseState(runs) {
  if (runs.some((run) => run.conclusion === 'success')) return 'passed'
  const failed = runs.some((run) => ['failure', 'timed_out', 'startup_failure'].includes(run.conclusion))
  if (failed && runs.every((run) => run.status === 'completed')) return 'failed'
  if (runs.length && runs.every((run) => run.status === 'completed')) return 'missing' // cancelled / skipped only
  return runs.length ? 'pending' : 'missing'
}

async function release() {
  const sha = process.env.GITHUB_SHA
  // A tag usually follows the merge within a minute; the runs that the gate
  // skips finish about as fast, so wait a little for them.
  const deadline = Date.now() + (process.env.GITHUB_EVENT_NAME === 'push' ? 10 * 60_000 : 0)
  for (;;) {
    const states = {}
    for (const workflow of RELEASE_REQUIRED_WORKFLOWS) {
      const runs = await runsFor(workflow, sha)
      states[workflow] = releaseState(runs)
      if (states[workflow] === 'failed') {
        const urls = runs.filter((run) => run.conclusion !== 'success').map((run) => run.html_url)
        throw new Error(`${workflow} did not pass on ${sha.slice(0, 7)} (${urls.join(' ')}); fix or re-run it before releasing`)
      }
    }
    console.log(Object.entries(states).map(([workflow, state]) => `${workflow}: ${state}`).join(', '))
    if (Object.values(states).every((state) => state === 'passed')) return true
    if (Date.now() >= deadline) {
      console.log(`CI has not passed on ${sha.slice(0, 7)} yet; the release build runs the tests itself`)
      return false
    }
    await new Promise((done) => setTimeout(done, 20_000))
  }
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  if (mode === 'gate') {
    const [run, reason] = await gate()
    console.log(`${run ? 'RUN' : 'SKIP'}: ${reason}`)
    output('run', run)
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${run ? 'Running' : 'Skipped'}: ${reason}\n`)
    }
  } else if (mode === 'release') {
    output('verified', await release())
  } else {
    console.error('usage: node scripts/ci-gate.mjs gate | release')
    process.exit(2)
  }
}
