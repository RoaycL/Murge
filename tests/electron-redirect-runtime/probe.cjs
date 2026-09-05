// Electron main-process probe for the kernel-proxy subscription transport.
// Invoked by tests/electron-redirect-runtime.test.ts as:
//   electron --no-sandbox --host-resolver-rules="MAP <hosts> 127.0.0.1" <dir>
//
// The probe is fully OFFLINE: subscription hosts are RFC-2606 .test names
// mapped to a local HTTP server by Chromium's --host-resolver-rules (the
// connection layer), while the fetcher's injected resolveHost simulates the
// validation layer's DNS view. Validation and connection intentionally see
// different answers for one host — the DNS-rebinding shape this SSRF
// protection must hold against. No leg depends on internet reachability, so
// CI cannot go flaky on a network hiccup.
//
// Transport level (no URL validation involved):
//   A1  a 302 with a relative location surfaces as a synthetic redirect
//       response — NOT "Redirect was cancelled" (the Electron 38 net.fetch +
//       redirect:'manual' regression this transport replaces, see
//       electron/electron#43715)
//   A2  an aborted signal rejects with AbortError instead of hanging
//   A3  across the WHOLE probe the protected target /final is requested ZERO
//       times: catches a transport that follows hops without validation
// Fetcher level (real SubscriptionFetcher, production-style wiring):
//   B1  a strict-validation multi-hop chain resolves and streams the final
//       body: every hop's URL passes per-hop validation before its request
//   B2  a redirect to a host whose resolved address is private is rejected
//       and the private target
//       receives ZERO requests (a network failure cannot produce
//       INVALID_ARGUMENT + 禁止访问内部地址 naming the host)
//   B3  a chain longer than maxRedirects fails with the budget error after
//       exactly maxRedirects+1 requests (runs with strictUrlValidation
//       disabled: the counter is independent of URL validation)
const { app, session } = require('electron')
const http = require('node:http')
const path = require('node:path')

const OUT = []
const log = (key, value) => OUT.push(`PROBE ${key}: ${value}`)
const pass = (key, condition, detail) => log(key, `${condition ? 'PASS' : 'FAIL'} ${detail}`)

const PUBLIC_HOST = 'public-label.test'
const PRIVATE_HOST = 'private-label.test'

function startProbeServer() {
  let server
  let port = 0
  const hits = new Map()
  const start = new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://probe.local')
      hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1)
      if (url.pathname === '/relative') {
        res.writeHead(302, { location: '/final' })
        res.end()
      } else if (url.pathname === '/redirect-to-private') {
        // 302 to a second .test host that the VALIDATION layer resolves to a
        // private address and the CONNECTION layer maps to this same server.
        res.writeHead(302, { location: `http://${PRIVATE_HOST}:${port}/final` })
        res.end()
      } else if (url.pathname === '/chain') {
        const n = Number(url.searchParams.get('n') || '0')
        if (n <= 0) {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('chain-end')
        } else {
          res.writeHead(302, { location: `/chain?n=${n - 1}` })
          res.end()
        }
      } else if (url.pathname === '/final') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('proxies: []')
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port
      resolve({ server, port, hits })
    })
  })
  return { start, close: () => new Promise((resolve) => server.close(resolve)) }
}

async function main() {
  const bundleDir = process.env.PROBE_BUNDLE_DIR
  if (!bundleDir) throw new Error('PROBE_BUNDLE_DIR not set')
  // The probe is intentionally loopback-only. Do not inherit the desktop's
  // current system proxy (often this desktop client itself), otherwise RFC-2606 test hosts are
  // sent to that proxy before Chromium's host-resolver rules can map them and a
  // local 200/302 becomes a misleading proxy-generated 503.
  await session.defaultSession.setProxy({ mode: 'direct' })
  const { createSubscriptionProxyFetchFn } = require(path.join(bundleDir, 'proxy-fetch-transport.cjs'))
  const { SubscriptionFetcher } = require(path.join(bundleDir, 'subscription-fetcher.cjs'))

  const { start, close } = startProbeServer()
  const { server, port, hits } = await start
  try {
    const fetchFn = createSubscriptionProxyFetchFn()

    // A1: manual-redirect interception returns the hop instead of cancelling.
    // Chromium reports the redirect target as an ABSOLUTE URL; the fetcher's
    // `new URL(location, currentUrl)` resolution accepts that unchanged.
    const a1 = await fetchFn(`http://127.0.0.1:${port}/relative`)
    pass(
      'A1 synthetic-redirect',
      a1.status === 302 && a1.ok === false && Boolean(a1.headers.get('location')?.endsWith('/final')),
      `status=${a1.status} location=${a1.headers.get('location')}`
    )

    // A2: aborted signal -> AbortError, no hang
    const controller = new AbortController()
    controller.abort()
    const a2 = await fetchFn(`http://127.0.0.1:${port}/relative`, { signal: controller.signal })
      .then(() => 'resolved (unexpected)')
      .catch((error) => `${error.name}: ${error.message}`)
    pass('A2 abort-before-request', a2.startsWith('AbortError'), a2)

    // Production-style fetcher over the real transport: strictUrlValidation
    // defaults to ON. The injected resolveHost is the VALIDATION layer's DNS
    // view: the public host resolves public (so source URLs pass validation
    // and requests are actually issued through Chromium, whose resolver maps
    // the same name to 127.0.0.1), while the private host resolves to a
    // loopback address — which per-hop validation must reject.
    const fetcher = new SubscriptionFetcher({
      proxyFetchFn: fetchFn,
      resolveHost: async (hostname) => (hostname === PRIVATE_HOST ? ['127.0.0.1'] : ['93.184.216.34'])
    })
    const base = `http://${PUBLIC_HOST}:${port}`

    // B1: multi-hop chain under strict validation — each hop passes its URL
    // check (public view) before the transport asks for it; the final body
    // streams back intact.
    const b1 = await fetcher
      .fetch(`${base}/chain?n=2`, { viaProxy: true })
      .then((result) => `doc=${result.document.trim()}`)
      .catch((error) => `REJECTED code=${error.code} msg=${error.message}`)
    pass('B1 strict-multi-hop', b1 === 'doc=chain-end', b1)

    // B2: a redirect to a host resolving private must be rejected by the
    // fetcher's per-hop validation with the exact code and the resolved-
    // address rejection message naming the private host — and the private
    // target must receive ZERO requests (finalHits would count any
    // unvalidated follow-through, from transport or kernel). A network
    // failure cannot produce INVALID_ARGUMENT + this message.
    const b2 = await fetcher
      .fetch(`${base}/redirect-to-private`, { viaProxy: true })
      .then(() => 'resolved (unexpected)')
      .catch((error) => `code=${error.code} msg=${error.message}`)
    pass(
      'B2 private-redirect-rejected',
      b2.includes('code=INVALID_ARGUMENT') &&
        b2.includes('订阅域名解析到非公网地址') &&
        b2.includes(PRIVATE_HOST) &&
        (hits.get('/final') ?? 0) === 0,
      `${b2.slice(0, 90)} finalHits=${hits.get('/final') ?? 0}`
    )

    // B3: redirect budget, offline and exact: 5 redirects are allowed, the
    // 6th response trips UPSTREAM_HTTP_ERROR + 重定向次数过多. The chain
    // endpoint must see exactly 6 more requests (/chain?n=8..n=3): the 6th
    // response trips the error and is never followed. Runs with
    // strictUrlValidation disabled — the budget counter sits outside URL
    // validation, and a network failure cannot produce this error code.
    const lenientFetcher = new SubscriptionFetcher({
      proxyFetchFn: fetchFn,
      strictUrlValidation: false
    })
    const countChain = () =>
      [...hits.entries()].filter(([name]) => name === '/chain').reduce((sum, [, count]) => sum + count, 0)
    const chainBefore = countChain()
    const b3 = await lenientFetcher
      .fetch(`${base}/chain?n=8`, { viaProxy: true })
      .then(() => 'resolved (unexpected)')
      .catch((error) => `code=${error.code} msg=${error.message}`)
    const chainRequests = countChain() - chainBefore
    pass(
      'B3 redirect-budget',
      b3.includes('code=UPSTREAM_HTTP_ERROR') &&
        b3.includes('重定向次数过多') &&
        chainRequests === 6,
      `${b3.slice(0, 60)} chainRequests=${chainRequests}`
    )

    // A3 (after everything): the protected target /final must never have been
    // requested across the whole probe. Any transport that follows a hop
    // without handing it to the fetcher lands here and fails this line.
    pass(
      'A3 no-unvalidated-follow',
      (hits.get('/final') ?? 0) === 0,
      `finalHits=${hits.get('/final') ?? 0}`
    )
  } finally {
    await close()
  }

  console.log('PROBE-Begin')
  for (const line of OUT) console.log(line)
  console.log('PROBE-End')
  app.exit(OUT.some((line) => line.includes('FAIL')) ? 1 : 0)
}

app
  .whenReady()
  .then(main)
  .catch((error) => {
    console.error('PROBE fatal:', error)
    app.exit(2)
  })
