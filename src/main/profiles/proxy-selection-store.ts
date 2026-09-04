import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

/** Filename of the persisted proxy-selection cache, inside the app-data namespace. */
export const PROXY_SELECTIONS_FILE = 'proxy-selections.json'

/**
 * Durable cache of the user's chosen node per policy group, keyed by profile id
 * (mirrors how sparkle/clash-party persist `selected` per profile so a restart
 * or a profile switch restores the user's nodes instead of the config file's
 * defaults).
 *
 * Shape: `{ [profileId]: { [groupName]: nodeName } }`.
 *
 * Writes are atomic (temp file + rename) and serialized through a local queue so
 * a burst of selection IPCs can never interleave a truncated document. Reads are
 * fail-open: a missing/corrupt cache yields an empty map, which simply means
 * "nothing to restore" — the kernel then keeps the config's own defaults.
 */
export class ProxySelectionStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly appDataBase: string) {}

  /** All remembered selections for one profile ({} when none). */
  async get(profileId: string): Promise<Record<string, string>> {
    const all = await this.readAll()
    return all[profileId] ?? {}
  }

  /** Remember `node` for `group` under `profileId`. */
  async set(profileId: string, group: string, node: string): Promise<void> {
    await this.serial(async () => {
      const all = await this.readAll()
      all[profileId] = { ...all[profileId], [group]: node }
      await this.write(all)
    })
  }

  /** Drop every remembered selection for a deleted profile. */
  async deleteProfile(profileId: string): Promise<void> {
    await this.serial(async () => {
      const all = await this.readAll()
      if (!(profileId in all)) return
      delete all[profileId]
      await this.write(all)
    })
  }

  private async readAll(): Promise<Record<string, Record<string, string>>> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      // Coerce defensively: a hand-edited or partially-written file must never
      // produce a non-string node name that a later restore would PUT upstream.
      const out: Record<string, Record<string, string>> = {}
      for (const [profileId, groups] of Object.entries(parsed as Record<string, unknown>)) {
        if (!groups || typeof groups !== 'object' || Array.isArray(groups)) continue
        const clean: Record<string, string> = {}
        for (const [group, node] of Object.entries(groups as Record<string, unknown>)) {
          if (typeof node === 'string' && node.length > 0) clean[group] = node
        }
        out[profileId] = clean
      }
      return out
    } catch {
      return {}
    }
  }

  private async write(all: Record<string, Record<string, string>>): Promise<void> {
    await mkdir(this.appDataBase, { recursive: true })
    const tmp = join(this.appDataBase, `.${PROXY_SELECTIONS_FILE}.${randomUUID()}.tmp`)
    await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, 'utf8')
    await rename(tmp, this.filePath)
  }

  private get filePath(): string {
    return join(this.appDataBase, PROXY_SELECTIONS_FILE)
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
