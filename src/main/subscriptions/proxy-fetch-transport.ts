import { net } from 'electron'
import type { ClientRequest, IncomingMessage } from 'electron'
import type { FetchFn, FetchResponseLike } from './subscription-fetcher'

interface ProxyRequestInit {
  signal?: AbortSignal
  headers?: Record<string, string>
}

function abortError(): Error {
  const error = new Error('request aborted')
  error.name = 'AbortError'
  return error
}

/**
 * A 3xx handed back to SubscriptionFetcher as a normal-looking response: the
 * fetcher sees `status >= 300` plus `location` and runs its own per-hop
 * validation (scheme, DNS, private/loopback rejection, redirect budget) before
 * requesting the next hop through this transport again. Chromium reports the
 * redirect target as an ABSOLUTE URL, which the fetcher's `new URL(location,
 * currentUrl)` resolution accepts unchanged. `url` mirrors the REQUESTED hop
 * so the fetcher's final-URL adoption stays a no-op for redirects.
 */
function syntheticRedirectResponse(statusCode: number, location: string, requestedUrl: string): FetchResponseLike {
  return {
    ok: false,
    status: statusCode,
    url: requestedUrl,
    headers: {
      has: (name) => name.toLowerCase() === 'location',
      get: (name) => (name.toLowerCase() === 'location' ? location : null)
    },
    text: () => Promise.resolve('')
  }
}

function wrapResponse(response: IncomingMessage, requestedUrl: string, request: ClientRequest): FetchResponseLike {
  const rawHeaders = response.headers ?? {}
  const status = response.statusCode ?? 0
  const chunks: Buffer[] = []
  let ended = false
  const waiters: Array<(result: { done: boolean; value?: Uint8Array }) => void> = []
  const finish = (): void => {
    ended = true
    while (waiters.length) waiters.shift()!({ done: true })
  }
  // ONE data collector: chunks are buffered eagerly so text() works even when
  // the whole body arrived before it is called, and the streaming reader
  // drains the same buffer. Never attach a second 'data' listener.
  response.on('data', (chunk: Buffer) => {
    const waiter = waiters.shift()
    if (waiter) waiter({ done: false, value: new Uint8Array(chunk) })
    else chunks.push(chunk)
  })
  response.on('end', finish)
  response.on('error', finish)
  response.on('aborted', finish)
  const allText = (): string => Buffer.concat(chunks).toString('utf8')
  return {
    ok: status >= 200 && status < 300,
    status,
    url: requestedUrl,
    headers: {
      has: (name) => Object.prototype.hasOwnProperty.call(rawHeaders, name.toLowerCase()),
      get: (name) => {
        const value = rawHeaders[name.toLowerCase()]
        if (value === undefined) return null
        return Array.isArray(value) ? value.join(', ') : value
      }
    },
    text: () => {
      // A truncated body cannot pass config validation downstream; treat
      // aborts and stream errors as end-of-body instead of hanging.
      if (ended) return Promise.resolve(allText())
      return new Promise<string>((resolve) => {
        response.on('end', () => resolve(allText()))
        response.on('error', () => resolve(allText()))
        response.on('aborted', () => resolve(allText()))
      })
    },
    body: {
      getReader: () => ({
        read: () => {
          const chunk = chunks.shift()
          if (chunk) return Promise.resolve({ done: false, value: new Uint8Array(chunk) })
          if (ended) return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve) => waiters.push(resolve))
        },
        cancel: () => {
          try {
            request.abort()
          } catch {
            /* request already dead */
          }
          return Promise.resolve()
        }
      })
    }
  }
}

/**
 * Exactly ONE HTTP outcome: either an intercepted redirect (synthetic 3xx) or
 * the final response. Hop sequencing belongs to SubscriptionFetcher — it owns
 * redirect budgeting and validates every target before the next request.
 */
function fetchOnce(url: string, init?: ProxyRequestInit): Promise<FetchResponseLike> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (run: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      run()
    }
    const signal = init?.signal
    const onAbort = (): void => {
      try {
        req.abort()
      } catch {
        /* request already dead */
      }
      settle(() => reject(abortError()))
    }
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
    }
    if (signal?.aborted) {
      reject(abortError())
      return
    }

    // redirect: 'manual' is mandatory here: Electron's ClientRequest cancels
    // the transfer when followRedirect() is not invoked synchronously during
    // the redirect event, so 'follow' via net.fetch is the only alternative —
    // and that auto-follows each hop inside Chromium before any validation
    // (CVE-2026-70605: a redirect could reach the local file loader).
    const req = net.request({ method: 'GET', url, redirect: 'manual' })
    for (const [name, value] of Object.entries(init?.headers ?? {})) {
      try {
        req.setHeader(name, value)
      } catch {
        /* drop a malformed header rather than failing the whole probe */
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    req.on('redirect', (statusCode: number, _method: string, redirectUrl: string) => {
      // Hand the hop to the fetcher and DO NOT touch the request afterwards:
      // with no followRedirect() call, ClientRequest dies on its own with
      // "Redirect was cancelled" (electron/electron#43715), which cancels the
      // paused transfer without following the hop. Calling abort() HERE would
      // set the request's _aborted flag, suppress that cancellation, and let
      // Chromium follow the redirect unvalidated. The resulting error event is
      // discarded because this settle() already claimed the outcome.
      settle(() => resolve(syntheticRedirectResponse(statusCode, redirectUrl, url)))
    })
    req.on('response', (response: IncomingMessage) => {
      settle(() => resolve(wrapResponse(response, url, req)))
    })
    req.on('error', (error: Error) => {
      settle(() => reject(error))
    })
    req.end()
  })
}

/**
 * Build the kernel-proxy fallback transport on Electron's net stack, which —
 * unlike Node's global fetch — honors the system proxy (the app's own mixed
 * port when the system proxy is enabled), so tunnel-only subscription hosts
 * stay reachable when the direct route is not.
 *
 * Redirects are resolved hop-by-hop OUTSIDE Chromium: each 3xx is intercepted
 * synchronously and surfaced to SubscriptionFetcher as a synthetic 3xx
 * response; the fetcher validates the target (scheme, DNS resolution,
 * private/loopback rejection, redirect budget) and issues the next request
 * through this transport itself. net.fetch cannot be used for this on
 * Electron 38 — with redirect:'manual' it rejects every redirect with
 * "Redirect was cancelled" (electron/electron#43715) — and auto-following
 * bypasses validation entirely, which is the exact pattern CVE-2026-70605
 * turned into a local-file exposure.
 */
export function createSubscriptionProxyFetchFn(): FetchFn {
  return (url, init) => fetchOnce(url, init)
}
