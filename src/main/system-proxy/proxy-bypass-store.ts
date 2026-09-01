import { join, dirname } from 'node:path'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { ProxyBypassPolicy } from '../../shared/proxy-bypass'
import { coerceProxyBypassPolicy, EMPTY_PROXY_BYPASS_POLICY } from '../../shared/proxy-bypass'

/** How the policy is persisted. `read` always returns a valid (coerced) model. */
export interface ProxyBypassStore {
  read(): Promise<ProxyBypassPolicy>
  write(policy: ProxyBypassPolicy): Promise<void>
}

export const SYSTEM_PROXY_BYPASS_FILE = 'proxy-bypass-policy.json'

/** Resolve the controlled proxy-bypass policy file under the app-data base. */
export function resolveSystemProxyBypassPath(appDataBase: string): string {
  return join(appDataBase, 'system-proxy', SYSTEM_PROXY_BYPASS_FILE)
}

/**
 * File-backed proxy-bypass policy store. Writes are atomic (temp file in the
 * same directory, then rename) so a crash mid-write can never leave a
 * half-written JSON payload. A malformed file is coerced to the safe default
 * rather than surfaced as a hard failure — the bypass policy is a convenience,
 * not a crash-recovery-critical value like the owned-proxy backup.
 */
export class FileSystemProxyBypassStore implements ProxyBypassStore {
  constructor(private readonly filePath: string) {}

  static forAppDataBase(appDataBase: string): FileSystemProxyBypassStore {
    return new FileSystemProxyBypassStore(resolveSystemProxyBypassPath(appDataBase))
  }

  async read(): Promise<ProxyBypassPolicy> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_PROXY_BYPASS_POLICY }
      // An unreadable file is a fail-closed default; never crash the proxy setup.
      return { ...EMPTY_PROXY_BYPASS_POLICY }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ...EMPTY_PROXY_BYPASS_POLICY }
    }
    return coerceProxyBypassPolicy(parsed)
  }

  async write(policy: ProxyBypassPolicy): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = join(dirname(this.filePath), `.${SYSTEM_PROXY_BYPASS_FILE}.${randomUUID()}.tmp`)
    await writeFile(tmp, JSON.stringify(policy, null, 2) + '\n', 'utf8')
    await rename(tmp, this.filePath)
  }
}

/** In-memory store for the dev build and unit tests. */
export class InMemoryProxyBypassStore implements ProxyBypassStore {
  private value: ProxyBypassPolicy = { ...EMPTY_PROXY_BYPASS_POLICY }

  async read(): Promise<ProxyBypassPolicy> {
    return { ...this.value }
  }

  async write(policy: ProxyBypassPolicy): Promise<void> {
    this.value = { ...policy, customEntries: [...policy.customEntries] }
  }
}
