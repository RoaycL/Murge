import { spawn, type ChildProcess } from 'node:child_process'
import type { KernelBinary, KernelExitInfo, KernelProcessAdapter, KernelProcessHandle } from './types'

/** Thin Node-backed adaptation of a spawned child process to the kernel contract. */
class NodeKernelProcessHandle implements KernelProcessHandle {
  readonly pid: number | undefined
  private readonly child: ChildProcess

  constructor(child: ChildProcess) {
    this.child = child
    this.pid = child.pid
  }

  onStdout(listener: (text: string) => void): void {
    this.child.stdout?.on('data', (chunk) => listener(String(chunk)))
  }

  onStderr(listener: (text: string) => void): void {
    this.child.stderr?.on('data', (chunk) => listener(String(chunk)))
  }

  onExit(listener: (info: KernelExitInfo) => void): void {
    this.child.on('exit', (code, signal) => listener({ code, signal }))
  }

  onError(listener: (error: Error) => void): void {
    this.child.on('error', (error) => listener(error))
  }

  sendSignal(signal: NodeJS.Signals): boolean {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return false
    if (this.child.pid == null) return false
    try {
      process.kill(this.child.pid, signal)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Spawns the kernel without a shell, with stdout/stderr piped and the window
 * hidden. No network listener or proxy configuration is created here.
 */
export class NodeKernelProcessAdapter implements KernelProcessAdapter {
  spawn(binary: KernelBinary): KernelProcessHandle {
    const child = spawn(binary.command, binary.args, {
      cwd: binary.cwd,
      env: { ...process.env, ...(binary.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    })
    return new NodeKernelProcessHandle(child)
  }

  /** Process-liveness probe that never alters process state. */
  isProcessAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM means the process exists but we may not signal it.
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
}
