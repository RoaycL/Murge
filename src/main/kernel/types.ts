/**
 * Kernel process contract.
 *
 * These interfaces are the injection boundaries for the kernel supervisor. The
 * real, Node-backed implementations live alongside the supervisor; unit tests
 * supply fakes so no process is ever spawned and no network state is touched.
 *
 * During the fixture milestone every default implementation resolves to a
 * harmless fixture process (a Node script that opens no socket) so lifecycle
 * behaviour can be proven without ever executing a real kernel, configuring
 * a proxy port or mutating the system network.
 */

/** A resolved command line ready to be spawned. */
export interface KernelBinary {
  /** Executable path (or on-PATH name). */
  command: string
  /** Fixed arguments, e.g. the fixture script path. */
  args: string[]
  /** Working directory for the child, when the caller specifies one. */
  cwd?: string
  /** Extra environment variables for the child. */
  env?: Record<string, string>
  /** Version surfaced in KernelStatus.version when not probed at runtime. */
  version?: string | null
}

export interface KernelResolveOptions {
  /** Architecture hint; defaults to process.arch when omitted. */
  arch?: string
  /** Explicit version to resolve, when the caller already knows it. */
  version?: string
}

/**
 * Resolves the executable to launch for the current platform.
 *
 * In development builds and for the fixture milestone this MUST return a
 * harmless fixture binary (or throw a ProtocolError with UNSUPPORTED) rather
 * than a real kernel, so no untrusted binary is ever executed.
 */
export interface KernelBinaryResolver {
  resolve(options?: KernelResolveOptions): Promise<KernelBinary>
}

/** Runtime configuration the kernel is launched with, plus its workspace. */
export interface KernelConfig {
  /** Path to the config document the kernel was told to read. */
  configPath: string
  /** Workspace directory owning the config (created for isolation). */
  rootDir: string
  /** Extra environment variables the child needs. */
  env?: Record<string, string>
  /**
   * Extra command-line arguments appended to the binary's own args when the
   * materialized config must be passed positionally (e.g. mihomo `-f <path>`).
   * Appended after the resolver's fixed args so a real kernel always reads the
   * freshly written, isolated config.
   */
  args?: string[]
}

/**
 * Materializes a runtime config into an isolated workspace and tracks it for
 * later cleanup. Implementations must not enable a proxy or controller
 * listener while the fixture milestone is in force.
 */
export interface KernelConfigStore {
  materialize(binary: KernelBinary, secret: string): Promise<KernelConfig>
  cleanup(config: KernelConfig): Promise<void>
}

export interface KernelExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
}

/**
 * A lightweight, stream-agnostic process handle. The supervisor never touches
 * Node streams directly, so a fake can drive it deterministically in tests.
 */
export interface KernelProcessHandle {
  /** Assigned PID, or undefined when the process failed to spawn. */
  readonly pid: number | undefined
  /** Register a stdout text listener (string chunks). */
  onStdout(listener: (text: string) => void): void
  /** Register a stderr text listener (string chunks). */
  onStderr(listener: (text: string) => void): void
  /** Register an exit notification. */
  onExit(listener: (info: KernelExitInfo) => void): void
  /** Register a spawn failure notification. */
  onError(listener: (error: Error) => void): void
  /** Send a signal; returns true when it was delivered. */
  sendSignal(signal: NodeJS.Signals): boolean
}

/** Boundary over child-process spawning so tests can substitute fakes. */
export interface KernelProcessAdapter {
  spawn(binary: KernelBinary): KernelProcessHandle
  /** Whether a previously recorded PID still refers to a live process. */
  isProcessAlive(pid: number): boolean
}

/** Everything the supervisor needs to run a kernel process. */
export interface KernelDependencies {
  resolver: KernelBinaryResolver
  configStore: KernelConfigStore
  adapter: KernelProcessAdapter
  /** Controller secret forwarded to the config store on each start. */
  secret: string
}
