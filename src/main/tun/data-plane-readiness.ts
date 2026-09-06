import { ProtocolError, ProtocolErrorCode } from '../../shared/protocol-errors'

export interface TunReadinessClient {
  getVersion(signal?: AbortSignal): Promise<unknown>
  delayTest(name: string, options: { url: string; timeout: number; signal?: AbortSignal }): Promise<unknown>
}

export interface TunDataPlaneReadinessOptions {
  urls?: readonly string[]
  probeTimeoutMs?: number
  retryDelayMs?: number
}

const DEFAULT_URLS = [
  'https://www.msftconnecttest.com/connecttest.txt',
  'https://connectivitycheck.platform.hicloud.com/generate_204'
] as const

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * A responsive controller only proves that mihomo parsed the configuration.
 * On Windows, the TUN interface and routes can become usable later. Confirm one
 * real DIRECT request through the newly started child before publishing active.
 */
export async function waitForTunDataPlaneReady(
  client: TunReadinessClient,
  signal: AbortSignal,
  options: TunDataPlaneReadinessOptions = {}
): Promise<void> {
  const urls = options.urls ?? DEFAULT_URLS
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000
  const retryDelayMs = options.retryDelayMs ?? 150

  while (!signal.aborted) {
    try {
      await client.getVersion(signal)
      // Regional connectivity endpoints are alternatives, not a sequence. The
      // first success proves the path; a blocked Microsoft host must not delay
      // the available Huawei probe by a full request timeout (or vice versa).
      await Promise.any(urls.map((url) =>
        client.delayTest('DIRECT', { url, timeout: probeTimeoutMs, signal })
      ))
      return
    } catch {
      // The child may still be binding its controller; retry until the owner
      // aborts the bounded startup window.
    }
    await waitForRetry(retryDelayMs, signal)
  }

  throw new ProtocolError(ProtocolErrorCode.KERNEL_START_TIMEOUT, 'TUN data-plane readiness timed out')
}
