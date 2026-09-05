// Electron main-process probe for the kernel-proxy subscription transport.
// Invoked by tests/electron-redirect-runtime.test.ts as:
//   electron --no-sandbox <this-dir>   (with PROBE_BUNDLE_DIR in the env)
//
// Part A (local HTTP server, transport level — no URL validation involved):
//   A1  a 302 with a RELATIVE location surfaces as a synthetic redirect
//       outcome { status: 302, location } — NOT "Redirect was cancelled"
//       (the Electron 38 net.fetch + redirect:'manual' regression this
//       transport replaces, see electron/electron#43715)
//   A2  an aborted signal rejects with AbortError instead of hanging
// Part B (real SubscriptionFetcher, strictUrlValidation defaults to ON, public
// https targets on httpbingo.org — matching production validation exactly):
//   B1  multi-hop public redirect chain resolves and streams the final body
//   B2  a redirect into a loopback literal is rejected by per-hop validation
//   B3  a chain longer than maxRedirects (5) fails with the budget error
const { app, net } = require('electron')
const http = require('node:http')
const path = require('node:path')

const OUT = []
const log = (key, value) => OUT.push(`PROBE ${key}: ${value}`)
const pass = (key, condition, detail) => log(key, `${condition ? 'PASS' : 'FAIL'} ${detail}`)

function startChainServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://probe.local')
      if (url.pathname === '/relative') {
        res.writeHead(302, { location: '/final' })
        res.end()
      } else if (url.pathname === '/final') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('proxies: []')
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function main() {
  const bundleDir = process.env.PROBE_BUNDLE_DIR
  if (!bundleDir) throw new Error('PROBE_BUNDLE_DIR not set')
  const { createSubscriptionProxyFetchFn } = require(path.join(bundleDir, 'proxy-fetch-transport.cjs'))
  const { SubscriptionFetcher } = require(path.join(bundleDir, 'subscription-fetcher.cjs'))

  const { server, port } = await startChainServer()
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

    // B: the real fetcher with production-grade validation over the real
    // transport. httpbingo.org is used because strict SSRF validation rejects
    // loopback targets, so the multi-hop sweep needs a public host.
    const networkUp = await new Promise((resolve) => {
      const request = net.request({ method: 'HEAD', url: 'https://httpbingo.org/' })
      request.on('response', () => resolve(true))
      request.on('error', () => resolve(false))
      setTimeout(() => {
        try {
          request.abort()
        } catch {
          /* already dead */
        }
        resolve(false)
      }, 5000)
      request.end()
    })
    if (!networkUp) {
      log('B1 public-multi-hop', 'SKIP offline')
      log('B2 loopback-redirect-rejected', 'SKIP offline')
      log('B3 redirect-budget', 'SKIP offline')
    }

    const fetcher = new SubscriptionFetcher({ proxyFetchFn: fetchFn })

    if (networkUp) {
    const b1 = await fetcher
      .fetch('https://httpbingo.org/redirect/2', { viaProxy: true })
      .then((result) => `doc-head=${result.document.slice(0, 24).replace(/\s+/g, ' ')}`)
      .catch((error) => `REJECTED ${error.constructor.name}: ${error.message}`)
    pass('B1 public-multi-hop', !b1.startsWith('REJECTED'), b1)

    const b2 = await fetcher
      .fetch('https://httpbingo.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A9%2F', { viaProxy: true })
      .then(() => 'resolved (unexpected)')
      .catch((error) => `REJECTED ${error.constructor.name}: ${error.message}`)
    pass('B2 loopback-redirect-rejected', b2.startsWith('REJECTED'), b2.slice(0, 80))

    const b3 = await fetcher
      .fetch('https://httpbingo.org/redirect/8', { viaProxy: true })
      .then(() => 'resolved (unexpected)')
      .catch((error) => `REJECTED ${error.constructor.name}: ${error.message}`)
    pass('B3 redirect-budget', b3.startsWith('REJECTED'), b3.slice(0, 60))
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
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
