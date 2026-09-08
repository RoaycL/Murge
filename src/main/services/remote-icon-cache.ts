import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isPublicAddress, type FetchFn, type FetchResponseLike } from '../subscriptions/subscription-fetcher'

const MAX_ICON_BYTES = 512 * 1024
const MAX_REDIRECTS = 5
const FETCH_TIMEOUT_MS = 12_000
const MAX_CACHE_FILES = 256
const MAX_CACHE_BYTES = 96 * 1024 * 1024
const ALLOWED_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'
])

interface CachedIconRecord {
  dataUrl: string
}

/** Persistent, stale-if-error cache for untrusted policy icon URLs. */
export class RemoteIconCache {
  private readonly inFlight = new Map<string, Promise<string | null>>()

  constructor(
    private readonly root: string,
    private readonly transports: readonly FetchFn[] = [globalThis.fetch as FetchFn],
    private readonly resolveHost: (hostname: string) => Promise<string[]> = async (hostname) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)
  ) {}

  async get(cacheKey: string, url?: string, refresh = false): Promise<string | null> {
    if (typeof cacheKey !== 'string' || cacheKey.length === 0 || cacheKey.length > 512) return null
    const cached = await this.read(cacheKey)
    if (!refresh || !url || url.length > 2048) return cached
    const existing = this.inFlight.get(cacheKey)
    if (existing) return existing
    const operation = this.download(url)
      .then(async (dataUrl) => {
        await this.write(cacheKey, dataUrl)
        return dataUrl
      })
      .catch(() => cached)
      .finally(() => this.inFlight.delete(cacheKey))
    this.inFlight.set(cacheKey, operation)
    return operation
  }

  private pathFor(cacheKey: string): string {
    return join(this.root, `${createHash('sha256').update(cacheKey).digest('hex')}.json`)
  }

  private async read(cacheKey: string): Promise<string | null> {
    try {
      const raw = JSON.parse(await readFile(this.pathFor(cacheKey), 'utf8')) as Partial<CachedIconRecord>
      return typeof raw.dataUrl === 'string' && raw.dataUrl.startsWith('data:image/')
        ? raw.dataUrl
        : null
    } catch {
      return null
    }
  }

  private async write(cacheKey: string, dataUrl: string): Promise<void> {
    const target = this.pathFor(cacheKey)
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    // The URL can carry a subscription-owned token. Persist only the image
    // bytes under the hashed semantic key, never the raw URL.
    await writeFile(temporary, JSON.stringify({ dataUrl } satisfies CachedIconRecord), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
    await this.prune().catch(() => undefined)
  }

  private async prune(): Promise<void> {
    const names = (await readdir(this.root)).filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    const entries = (await Promise.all(names.map(async (name) => {
      const info = await stat(join(this.root, name))
      return { name, size: info.size, modified: info.mtimeMs }
    }))).sort((left, right) => left.modified - right.modified)
    let bytes = entries.reduce((total, entry) => total + entry.size, 0)
    let count = entries.length
    for (const entry of entries) {
      if (count <= MAX_CACHE_FILES && bytes <= MAX_CACHE_BYTES) break
      try {
        await unlink(join(this.root, entry.name))
        count -= 1
        bytes -= entry.size
      } catch { /* another refresh may already have removed it */ }
    }
  }

  private async validate(url: string): Promise<URL> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('unsafe icon URL')
    const bareHost = parsed.hostname.replace(/^\[|\]$/g, '')
    const addresses = isIP(bareHost) ? [bareHost] : await this.resolveHost(bareHost)
    const fakeIpOnly = addresses.length > 0 && addresses.every((address) => /^198\.(?:18|19)\./.test(address))
    if (addresses.length === 0 || (addresses.some((address) => !isPublicAddress(address)) && !fakeIpOnly)) {
      throw new Error('icon host is not public')
    }
    return parsed
  }

  private async fetchWith(transport: FetchFn, initialUrl: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      let currentUrl = initialUrl
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        await this.validate(currentUrl)
        const response = await transport(currentUrl, { signal: controller.signal, redirect: 'manual' })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers?.get('location')
          if (!location || redirects === MAX_REDIRECTS) throw new Error('invalid icon redirect')
          currentUrl = new URL(location, currentUrl).toString()
          continue
        }
        if (!response.ok) throw new Error(`icon HTTP ${response.status}`)
        return this.readResponse(response)
      }
      throw new Error('too many icon redirects')
    } finally {
      clearTimeout(timer)
    }
  }

  private async readResponse(response: FetchResponseLike): Promise<string> {
    const mime = (response.headers?.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
    if (!ALLOWED_TYPES.has(mime)) throw new Error('unsupported icon type')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('icon body unavailable')
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > MAX_ICON_BYTES) {
        await reader.cancel()
        throw new Error('icon too large')
      }
      chunks.push(value)
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    return `data:${mime};base64,${bytes.toString('base64')}`
  }

  private async download(url: string): Promise<string> {
    let lastError: unknown
    for (const transport of this.transports) {
      try {
        return await this.fetchWith(transport, url)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('no icon transport')
  }
}
