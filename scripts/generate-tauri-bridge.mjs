#!/usr/bin/env node
/**
 * Generate the Tauri desktop bridge from the Electron preload.
 *
 * Single source of truth: `src/preload/index.ts` defines the `window.desktop`
 * method surface and `src/shared/ipc.ts` defines the wire channel names. This
 * script parses BOTH and emits
 * `src/renderer/src/platform/generated/desktop-api.ts`, a typed
 * `createDesktopApi()` that renders over Tauri commands/events with the exact
 * same contract (including ProtocolError decoding).
 *
 * The generated file is committed; `tests/phase2-bridge-parity.test.ts`
 * regenerates it in-memory and fails when it is stale, so the two shells can
 * never drift silently.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const preloadPath = resolve(root, 'src/preload/index.ts')
const ipcPath = resolve(root, 'src/shared/ipc.ts')
const outPath = resolve(root, 'src/renderer/src/platform/generated/desktop-api.ts')

const preload = await readFile(preloadPath, 'utf8')

// --- Parse the preload api surface -----------------------------------------
const apiStart = preload.indexOf('const api: DesktopApi = {')
if (apiStart === -1) throw new Error('preload: api block not found')

let depth = 0
let apiEnd = -1
for (let i = preload.indexOf('{', apiStart); i < preload.length; i++) {
  const ch = preload[i]
  if (ch === '{') depth++
  else if (ch === '}') {
    depth--
    if (depth === 0) {
      apiEnd = i
      break
    }
  }
}
if (apiEnd === -1) throw new Error('preload: unbalanced api block')
const apiBody = preload.slice(preload.indexOf('{', apiStart), apiEnd + 1)

// Walk namespaces (two-space indent `name: {`) and method lines (four-space).
// Preprocessing first normalizes `},  next: {` joins onto their own line (the
// preload contains one such line).
const normalizedBody = apiBody.replace(/\},\s*(\w+): \{/g, '},\n  $1: {')
const namespaces = []
let current = null
for (const rawLine of normalizedBody.split('\n')) {
  const ns = rawLine.match(/^  (\w+): \{$/)
  if (ns) {
    current = { name: ns[1], methods: [] }
    namespaces.push(current)
    continue
  }
  if (current === null) continue
  const event = rawLine.match(/^    (\w+): \(listener\) => listen\(IPC\.(\w+), listener\),?$/)
  if (event) {
    current.methods.push({ name: event[1], kind: 'event', ipcKey: event[2], args: [] })
    continue
  }
  const invokeNoArgs = rawLine.match(/^    (\w+): \(\) => invoke\(IPC\.(\w+)\),?$/)
  if (invokeNoArgs) {
    current.methods.push({ name: invokeNoArgs[1], kind: 'invoke', ipcKey: invokeNoArgs[2], args: [] })
    continue
  }
  const invokeArgs = rawLine.match(/^    (\w+): \(([^)]+)\) => invoke\(IPC\.(\w+), (.+)\),?$/)
  if (invokeArgs) {
    current.methods.push({
      name: invokeArgs[1],
      kind: 'invoke',
      ipcKey: invokeArgs[3],
      args: invokeArgs[2].split(',').map((arg) => arg.trim()).filter(Boolean)
    })
    continue
  }
}
if (namespaces.length === 0) throw new Error('preload: no namespaces parsed')

// --- Parse the IPC channel map ----------------------------------------------
const ipcSource = await readFile(ipcPath, 'utf8')
const channelMap = new Map()
for (const match of ipcSource.matchAll(/^\s{2}(\w+): '([^']+)',?$/gm)) {
  channelMap.set(match[1], match[2])
}

// --- Validate ----------------------------------------------------------------
const missing = []
for (const ns of namespaces) {
  for (const method of ns.methods) {
    if (!channelMap.has(method.ipcKey)) missing.push(`${ns.name}.${method.name} -> IPC.${method.ipcKey}`)
  }
}
if (missing.length > 0) {
  throw new Error(`preload references channels missing from src/shared/ipc.ts:\n${missing.join('\n')}`)
}

// --- Emit -------------------------------------------------------------------
const lines = []
lines.push('// GENERATED FILE — do not edit by hand.')
lines.push('// Regenerate with `npm run tauri:bridge`.')
lines.push('//')
lines.push('// Source of truth: src/preload/index.ts (method surface) + src/shared/ipc.ts')
lines.push('// (wire channel names). The Tauri shell renders window.desktop over')
lines.push('// commands/events with the identical contract, so renderer code cannot')
lines.push('// tell the shells apart (docs/tauri/phase2/README.md).')
lines.push("import { invoke as tauriInvoke } from '@tauri-apps/api/core'")
lines.push("import { listen as tauriListen } from '@tauri-apps/api/event'")
lines.push("import { decodeProtocolError } from '@shared/protocol-errors'")
lines.push("import type { DesktopApi } from '@shared/ipc'")
lines.push('')
lines.push('/**')
lines.push(' * Thin invoke wrapper with the exact error semantics of the Electron')
lines.push(' * preload: Tauri command rejections arrive as the raw ProtocolError wire')
lines.push(' * string (`PROTOCOL_ERROR:<CODE>::<message>`), decode them so the renderer')
lines.push(' * can branch on a stable error code.')
lines.push(' */')
lines.push('async function bridgeInvoke<T>(channel: string, args: unknown[]): Promise<T> {')
lines.push('  try {')
lines.push("    return (await tauriInvoke<T>('desktop_ipc', { channel, payload: args })) as T")
lines.push('  } catch (error) {')
lines.push('    const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error)')
lines.push('    const decoded = decodeProtocolError(message)')
lines.push('    throw decoded ?? error')
lines.push('  }')
lines.push('}')
lines.push('')
lines.push('/**')
lines.push(' * Event subscription with the preload\'s synchronous-unsubscribe contract.')
lines.push(' * Tauri listen resolves asynchronously; a listener disposed before')
lines.push(' * resolution unregisters immediately once it lands.')
lines.push(' */')
lines.push('function bridgeListen<T>(channel: string, listener: (value: T) => void): () => void {')
lines.push('  let disposed = false')
lines.push('  let unlisten: (() => void) | null = null')
lines.push('  void tauriListen<T>(channel, (event) => { listener(event.payload) }).then((stop) => {')
lines.push('    if (disposed) stop()')
lines.push('    else unlisten = stop')
lines.push('  })')
lines.push('  return () => {')
lines.push('    disposed = true')
lines.push('    unlisten?.()')
lines.push('  }')
lines.push('}')
lines.push('')
lines.push('/** Install the Tauri-backed `window.desktop` implementation. */')
lines.push('export function createDesktopApi(): DesktopApi {')
lines.push('  const api: DesktopApi = {')
for (const ns of namespaces) {
  lines.push(`    ${ns.name}: {`)
  for (const method of ns.methods) {
    const channel = channelMap.get(method.ipcKey)
    if (method.kind === 'event') {
      lines.push(`      ${method.name}: (listener) => bridgeListen(${JSON.stringify(channel)}, listener),`)
    } else {
      const argsLiteral = JSON.stringify(method.args)
      lines.push(`      ${method.name}: (${method.args.join(', ')}) => bridgeInvoke(${JSON.stringify(channel)}, ${argsLiteral}),`)
    }
  }
  lines.push('    },')
}
lines.push('  }')
lines.push('  return api')
lines.push('}')
lines.push('')

await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, lines.join('\n'), 'utf8')

const invokeCount = namespaces.reduce((sum, ns) => sum + ns.methods.filter((m) => m.kind === 'invoke').length, 0)
const eventCount = namespaces.reduce((sum, ns) => sum + ns.methods.filter((m) => m.kind === 'event').length, 0)
console.log(`[tauri-bridge] generated ${outPath}`)
console.log(`[tauri-bridge] ${namespaces.length} namespaces, ${invokeCount} invoke methods, ${eventCount} event methods`)
