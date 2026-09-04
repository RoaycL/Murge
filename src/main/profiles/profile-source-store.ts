import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'

export interface ProfileSourceStore {
  get(id: string): Promise<string | null>
  set(id: string, url: string): Promise<void>
  delete(id: string): Promise<void>
}

export interface SecretCodec {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

/** Main-process-only storage for raw subscription URLs. */
export class EncryptedProfileSourceStore implements ProfileSourceStore {
  constructor(private readonly rootDir: string, private readonly codec: SecretCodec) {}

  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new ProtocolError(ProtocolErrorCode.INVALID_ARGUMENT, 'invalid profile id')
    }
    return join(this.rootDir, `${id}.source.enc`)
  }

  async get(id: string): Promise<string | null> {
    try {
      return this.codec.decrypt(await readFile(this.path(id)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new ProtocolError(ProtocolErrorCode.INTERNAL, '无法解密订阅地址')
    }
  }

  async set(id: string, url: string): Promise<void> {
    if (!this.codec.isAvailable()) {
      throw new ProtocolError(ProtocolErrorCode.UNSUPPORTED, '系统安全存储不可用，无法安全保存订阅地址')
    }
    const target = this.path(id)
    await mkdir(dirname(target), { recursive: true })
    const temp = join(this.rootDir, `.tmp-${randomUUID()}`)
    try {
      await writeFile(temp, this.codec.encrypt(url), { mode: 0o600 })
      await rename(temp, target)
    } finally {
      await rm(temp, { force: true })
    }
  }

  async delete(id: string): Promise<void> {
    await rm(this.path(id), { force: true })
  }
}

export class MemoryProfileSourceStore implements ProfileSourceStore {
  private readonly values = new Map<string, string>()
  async get(id: string): Promise<string | null> { return this.values.get(id) ?? null }
  async set(id: string, url: string): Promise<void> { this.values.set(id, url) }
  async delete(id: string): Promise<void> { this.values.delete(id) }
}
