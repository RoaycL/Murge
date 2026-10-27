import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'
import type { KernelBinary } from './types'

/** The core's own `-t` budget (the TUN service runtime uses the same 30s). */
const CHECK_TIMEOUT_MS = 30_000
/** Keep the tail of a long rejection, like the service does. */
const MAX_MESSAGE_CHARS = 3500

export interface ConfigCheckPaths {
  /** The kernel home (`-d`), so geodata the real core uses is found. */
  homeDir: string
  /** Where the temporary document is written. */
  workDir: string
}

/**
 * Run `mihomo -t -d <home> -f <document>` as the current user.
 *
 * `-t` reads a file and exits: it opens no port, touches no adapter and needs
 * no elevation, so the app runs it itself (Mihomo Party does the same) and an
 * import never depends on the privileged TUN service being installed.
 *
 * Resolves when the core accepts the document. Rejects with INVALID_ARGUMENT
 * (the core's own output) when the core rejects it, and with any other code
 * when the check could not run at all — which must never gate a write.
 */
export async function checkConfigWithCore(
  binary: KernelBinary,
  paths: ConfigCheckPaths,
  document: string
): Promise<void> {
  try {
    await mkdir(paths.homeDir, { recursive: true })
    await mkdir(paths.workDir, { recursive: true })
  } catch (error) {
    throw new ProtocolError(ProtocolErrorCode.KERNEL_SPAWN_FAILED, `配置校验目录不可用：${messageOf(error)}`)
  }
  const configPath = join(paths.workDir, `validate-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.yaml`)
  try {
    await writeFile(configPath, document, 'utf8')
  } catch (error) {
    throw new ProtocolError(ProtocolErrorCode.KERNEL_SPAWN_FAILED, `配置校验文件写入失败：${messageOf(error)}`)
  }
  try {
    await runCheck(binary, paths, configPath)
  } finally {
    await rm(configPath, { force: true }).catch(() => undefined)
  }
}

function runCheck(binary: KernelBinary, paths: ConfigCheckPaths, configPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      binary.command,
      [...binary.args, '-t', '-d', paths.homeDir, '-f', configPath],
      {
        cwd: paths.workDir,
        env: { ...process.env, ...(binary.env ?? {}) },
        timeout: CHECK_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve()
          return
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string }
        if (failure.killed) {
          reject(new ProtocolError(ProtocolErrorCode.KERNEL_START_TIMEOUT, '配置校验超时：内核未在 30 秒内完成检查'))
          return
        }
        if (typeof failure.code !== 'number') {
          // ENOENT, EACCES, …: the core never ran, so it has no opinion.
          reject(new ProtocolError(ProtocolErrorCode.KERNEL_SPAWN_FAILED, `无法运行内核配置检查：${failure.message}`))
          return
        }
        const message = tail(`${stdout}${stderr}`.trim())
        reject(new ProtocolError(
          ProtocolErrorCode.INVALID_ARGUMENT,
          message || `内核拒绝了这份配置（退出码 ${failure.code}）`
        ))
      }
    )
  })
}

function tail(text: string): string {
  const chars = Array.from(text)
  return chars.length <= MAX_MESSAGE_CHARS ? text : chars.slice(-MAX_MESSAGE_CHARS).join('')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
