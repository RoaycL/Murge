/**
 * Pure helpers for the fail-closed loopback listener assertion (P1 #8).
 *
 * They operate on already-captured listener output so they can be unit-tested
 * without any listener tooling or a running kernel. `listenersOn` in the gated
 * real-kernel integration test shells out, then feeds the captured stdout here.
 */

export interface HostPort {
  host: string
  port: number
}

/**
 * Parse a `host:port` token, handling IPv6 bracket form `[::1]:8080` as well as
 * bare IPv4 `127.0.0.1:8080`. Returns null when the token is not an address
 * (state/PID/peer-wildcard like `0.0.0.0:*`).
 */
export function parseHostPort(token: string): HostPort | null {
  const bracketed = token.match(/^\[([^\]]+)\]:(\d+)$/)
  if (bracketed) return { host: bracketed[1], port: Number(bracketed[2]) }
  const idx = token.lastIndexOf(':')
  if (idx <= 0) return null
  const host = token.slice(0, idx)
  const port = Number(token.slice(idx + 1))
  if (!Number.isInteger(port) || port <= 0) return null
  return { host, port }
}

/**
 * Return the distinct listener hosts on `port` from listener output text.
 * Handles `127.0.0.1`, `0.0.0.0`, `::1`, `::` and `[IPv6]:port`. Non-loopback
 * hosts are returned too so the caller can reject them. Throws when no matching
 * listener is found, so an empty parse or unavailable tooling fails the test
 * instead of silently passing.
 */
export function listenersMatchingText(text: string, port: number, isWin: boolean): string[] {
  const listenState = isWin ? 'LISTENING' : 'LISTEN'
  const hosts = new Set<string>()
  let matched = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const tokens = line.split(/\s+/)
    if (!tokens.includes(listenState)) continue
    // The address token is the first token that parses as host:port on our port;
    // the peer address for LISTEN rows is `0.0.0.0:*` / `0.0.0.0:0`, which never
    // matches the numeric port, so we only ever pick the local address.
    for (const token of tokens) {
      const parsed = parseHostPort(token)
      if (parsed && parsed.port === port) {
        hosts.add(parsed.host)
        matched = true
        break
      }
    }
  }
  // Fail closed rather than "pass because nothing was parseable".
  if (!matched || hosts.size === 0) {
    throw new Error(`no listener found on port ${port}`)
  }
  return [...hosts]
}

/** True only for loopback listeners (`127.0.0.1` / `::1`). */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}
