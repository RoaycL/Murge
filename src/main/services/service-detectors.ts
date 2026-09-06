import type { ServiceUnlockResult, UnlockServiceName } from '@shared/unlock'

/**
 * Per-service unlock detection, 参考 clash-verge-rev 的解锁测试 crate
 * (`clash-verge-media-unlock`) 的判定语义。This module is PURE: every probe
 * step is data + a decision over {status, body, headers}, so the verdicts are
 * unit-testable without Electron. The transport lives in
 * `service-unlock-service.ts` (Electron `net` through the kernel mixed-port).
 */

export type UnlockStatus = ServiceUnlockResult['status']

export interface ProbeResponse {
  /** HTTP status code; `null` when the request never completed. */
  status: number | null
  body: string
  headers: Record<string, string | string[]>
}

export interface ProbeStep {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

/** 403 / 451 mean the egress is actively blocked, not a transient failure. */
export function classifyBlockedStatus(status: number | null): UnlockStatus | null {
  if (status === 403 || status === 451) return 'unsupported'
  if (status === null || status < 200 || status >= 300) return 'error'
  return null
}

/** Verge `get_trace_location`: value of the `loc=` line in a Cloudflare trace. */
export function traceLocation(body: string): string | null {
  const line = body.split(/\r?\n/).find((candidate) => candidate.startsWith('loc='))
  const value = line?.slice(4).trim()
  return value ? value.toUpperCase() : null
}

/** Verge `extract_quoted_field`: first `"key":"value"` occurrence in a JSON-ish body. */
export function extractQuotedField(body: string, key: string): string | null {
  const pattern = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, 'i')
  const match = pattern.exec(body)
  return match?.[1] ?? null
}

const CLAUDE_BLOCKED = ['AF', 'BY', 'CN', 'CU', 'HK', 'IR', 'KP', 'MO', 'RU', 'SY']
const GEMINI_BLOCKED = ['CHN', 'RUS', 'BLR', 'CUB', 'IRN', 'PRK', 'SYR', 'HKG', 'MAC']
// Grok (x.ai) publishes no machine-readable availability endpoint; its block
// list tracks the same sanctioned/unsupported regions as the other AI vendors.
const GROK_BLOCKED = ['AF', 'BY', 'CN', 'CU', 'HK', 'IR', 'KP', 'MO', 'RU', 'SY']

/** Detector body: region/status only — the factory stamps the service name. */
type DetectorBody = (probe: (step: ProbeStep) => Promise<ProbeResponse>) => Promise<Omit<ServiceUnlockResult, 'name'>>

export interface Detector {
  name: UnlockServiceName
  steps: (probe: (step: ProbeStep) => Promise<ProbeResponse>) => Promise<ServiceUnlockResult>
}

function defineDetector(name: UnlockServiceName, body: DetectorBody): Detector {
  return {
    name,
    steps: async (probe) => ({ name, ...(await body(probe)) })
  }
}

function normalizeRegion(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim().toUpperCase()
  return trimmed.length > 0 ? trimmed : null
}

/** ChatGPT — Verge chatgpt.rs: compliance endpoint body + optional trace region. */
export const chatgpt = defineDetector('ChatGPT', async (probe) => {
  const trace = await probe({ url: 'https://chat.openai.com/cdn-cgi/trace' })
  const region = normalizeRegion(traceLocation(trace.body))
  const compliance = await probe({ url: 'https://api.openai.com/compliance/cookie_requirements' })
  if (compliance.status === null) return { status: 'error', region }
  if (compliance.body.toLowerCase().includes('unsupported_country')) return { status: 'unsupported', region }
  return { status: 'supported', region }
})

/** Claude — Verge claude.rs: trace loc= against the blocked-country list. */
export const claude = defineDetector('Claude', async (probe) => {
  const trace = await probe({ url: 'https://claude.ai/cdn-cgi/trace' })
  if (trace.status === null) return { status: 'error', region: null }
  const region = normalizeRegion(traceLocation(trace.body))
  if (!region) return { status: 'error', region: null }
  return { status: CLAUDE_BLOCKED.includes(region) ? 'unsupported' : 'supported', region }
})

/** Gemini — Verge gemini.rs: alpha-3 marker after the hardcoded payload marker. */
export const gemini = defineDetector('Gemini', async (probe) => {
  const page = await probe({ url: 'https://gemini.google.com' })
  if (page.status === null) return { status: 'error', region: null }
  const marker = ',2,1,200,"'
  const index = page.body.indexOf(marker)
  const code = index >= 0 ? page.body.slice(index + marker.length, index + marker.length + 3) : ''
  if (!/^[A-Z]{3}$/.test(code)) return { status: 'error', region: null }
  return { status: GEMINI_BLOCKED.includes(code) ? 'unsupported' : 'supported', region: code }
})

/** Grok — authored for this app (Verge has no check): homepage gate + trace region. */
export const grok = defineDetector('Grok', async (probe) => {
  const trace = await probe({ url: 'https://grok.com/cdn-cgi/trace' })
  const region = normalizeRegion(traceLocation(trace.body))
  const page = await probe({ url: 'https://grok.com/' })
  const blocked = classifyBlockedStatus(page.status)
  if (blocked) return { status: blocked, region }
  if (page.body.toLowerCase().includes('not available in your region')) return { status: 'unsupported', region }
  return { status: 'supported', region }
})

/** Netflix — Verge netflix.rs: fast.com CDN, then original/non-original titles. */
export const netflix = defineDetector('Netflix', async (probe) => {
  const cdn = await probe({ url: 'https://api.fast.com/netflix/speedtest/v2?https=true&token=YXNkZmFzZGxmbnNkYWZoYXNkZmhrYWxm&urlCount=5' })
  if (cdn.status === null) return { status: 'error', region: null }
  if (cdn.status === 403) return { status: 'unsupported', region: null }
  let cdnRegion: string | null = null
  try {
    const parsed = JSON.parse(cdn.body) as { targets?: Array<{ location?: { country?: string } }> }
    const country = parsed.targets?.[0]?.location?.country
    cdnRegion = normalizeRegion(country)
    if (!cdnRegion || !parsed.targets || parsed.targets.length === 0) return { status: 'error', region: null }
  } catch {
    return { status: 'error', region: null }
  }
  const [selfProduced, regionLocked] = await Promise.all([
    probe({ url: 'https://www.netflix.com/title/81280792' }),
    probe({ url: 'https://www.netflix.com/title/70143836' })
  ])
  if (selfProduced.status === 404 && regionLocked.status === 404) return { status: 'unsupported', region: cdnRegion }
  if (selfProduced.status === 403 || regionLocked.status === 403) return { status: 'unsupported', region: cdnRegion }
  const ok = (value: number | null): boolean => value === 200 || value === 301
  if (!ok(selfProduced.status) || !ok(regionLocked.status)) return { status: 'error', region: cdnRegion }
  const regionProbe = await probe({ url: 'https://www.netflix.com/title/80018499' })
  const location = Array.isArray(regionProbe.headers.location) ? regionProbe.headers.location[0] : regionProbe.headers.location
  const segment = typeof location === 'string' ? location.split('/')[3] : undefined
  return { status: 'supported', region: normalizeRegion(segment?.split('-')[0] ?? null) ?? cdnRegion }
})

/** Disney+ — Verge disney_plus.rs: device-assertion → token → graphql country. */
export const disneyPlus = defineDetector('Disney+', async (probe) => {
  const AUTH = 'Bearer ZGlzbmV5JmJyb3dzZXImMS4wLjA.Cu56AgSfBTDag5NiRA81oLHkDZfu5L3CKadnefEAY84'
  const assertionStep = await probe({
    url: 'https://disney.api.edge.bamgrid.com/devices',
    method: 'POST',
    headers: { authorization: AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceFamily: 'browser', applicationRuntime: 'chrome', deviceProfile: 'windows', attributes: {} })
  })
  if (assertionStep.status === 403) return { status: 'unsupported', region: null }
  if (assertionStep.status === null) return { status: 'error', region: null }
  let assertion: string | null = null
  try {
    assertion = (JSON.parse(assertionStep.body) as { assertion?: string }).assertion ?? null
  } catch {
    assertion = null
  }
  if (!assertion) return { status: 'error', region: null }
  const tokenStep = await probe({
    url: 'https://disney.api.edge.bamgrid.com/token',
    method: 'POST',
    headers: { authorization: AUTH, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      latitude: '0',
      longitude: '0',
      platform: 'browser',
      subject_token: assertion,
      subject_token_type: 'urn:bamtech:params:oauth:token-type:device'
    }).toString()
  })
  if (tokenStep.status === 403 || tokenStep.body.includes('forbidden-location') || tokenStep.body.includes('403 ERROR')) {
    return { status: 'unsupported', region: null }
  }
  let refreshToken: string | null = null
  try {
    refreshToken = (JSON.parse(tokenStep.body) as { refresh_token?: string }).refresh_token ?? null
  } catch {
    refreshToken = null
  }
  if (!refreshToken) return { status: 'error', region: null }
  const graph = await probe({
    url: 'https://disney.api.edge.bamgrid.com/graph/v1/device/graphql',
    method: 'POST',
    headers: { authorization: AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'mutation refreshToken($input: RefreshTokenInput!) { refreshToken(refreshToken: $input) { activeSession { sessionId } } }',
      variables: { input: { refreshToken } }
    })
  })
  if (graph.status === null || graph.status < 200 || graph.status >= 300) return { status: 'error', region: null }
  let country: string | null = null
  let inSupported: boolean | null = null
  const walk = (node: unknown): void => {
    if (country !== null && inSupported !== null) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'countryCode' && typeof value === 'string' && country === null) country = value
        if (key === 'inSupportedLocation' && typeof value === 'boolean' && inSupported === null) inSupported = value
        walk(value)
      }
    }
  }
  try {
    walk(JSON.parse(graph.body))
  } catch {
    return { status: 'error', region: null }
  }
  const region = normalizeRegion(country)
  if (!region) return { status: 'error', region: null }
  if (region === 'JP') return { status: 'supported', region }
  if (inSupported === true) return { status: 'supported', region }
  if (inSupported === false) return { status: 'unsupported', region }
  return { status: 'error', region }
})

/** TikTok — Verge tiktok.rs: homepage gate + trace/marker region. */
export const tiktok = defineDetector('TikTok', async (probe) => {
  const trace = await probe({ url: 'https://www.tiktok.com/cdn-cgi/trace' })
  const region = normalizeRegion(traceLocation(trace.body))
  const homepage = await probe({ url: 'https://www.tiktok.com/' })
  const blocked = classifyBlockedStatus(homepage.status)
  if (!blocked) {
    const text = homepage.body.toLowerCase()
    if (text.includes('access denied') || text.includes('not available in your region') || text.includes('tiktok is not available')) {
      return { status: 'unsupported', region }
    }
    if (homepage.status !== null && homepage.status >= 200 && homepage.status < 300) {
      const marker = normalizeRegion(extractQuotedField(homepage.body, 'region')?.split('-')[0] ?? null)
      return { status: 'supported', region: region ?? marker }
    }
  }
  return { status: blocked ?? 'error', region }
})

/** YouTube Premium — Verge youtube.rs: premium availability markers + GL region. */
export const youtube = defineDetector('YouTube', async (probe) => {
  const page = await probe({ url: 'https://www.youtube.com/premium?hl=en' })
  if (page.status === null) return { status: 'error', region: null }
  const region = normalizeRegion(
    extractQuotedField(page.body, 'GL') ?? extractQuotedField(page.body, 'countryCode') ?? extractQuotedField(page.body, 'country_code')
  )
  const text = page.body.toLowerCase()
  if (text.includes('premium is not available in your country') || text.includes('premium is not available in your region')) {
    return { status: 'unsupported', region }
  }
  if (page.status !== null && page.status >= 200 && page.status < 300) {
    if (text.includes('youtube premium') || text.includes('ad-free') || text.includes('"browseid":"spunlimited"')) {
      return { status: 'supported', region }
    }
  }
  return { status: 'error', region }
})

/** GitHub — authored for this app (Verge has no check): homepage gate + trace region. */
export const github = defineDetector('GitHub', async (probe) => {
  const trace = await probe({ url: 'https://github.com/cdn-cgi/trace' })
  const region = normalizeRegion(traceLocation(trace.body))
  const page = await probe({ url: 'https://github.com/' })
  const blocked = classifyBlockedStatus(page.status)
  if (blocked) return { status: blocked, region }
  return { status: 'supported', region }
})

/** Spotify — Verge spotify.rs: country-selector API gate + market region. */
export const spotify = defineDetector('Spotify', async (probe) => {
  const selector = await probe({ url: 'https://www.spotify.com/api/content/v1/country-selector?platform=web&format=json' })
  if (selector.status === 403 || selector.status === 451) return { status: 'unsupported', region: null }
  if (selector.status === null || selector.status < 200 || selector.status >= 300) return { status: 'error', region: null }
  if (selector.body.toLowerCase().includes('not available in your country')) return { status: 'unsupported', region: null }
  const region = normalizeRegion(extractQuotedField(selector.body, 'countryCode'))
  return { status: 'supported', region }
})

export const SERVICE_DETECTORS: readonly Detector[] = [chatgpt, gemini, claude, grok, netflix, disneyPlus, tiktok, youtube, github, spotify]

const DETECTOR_BY_NAME = new Map<string, Detector>(SERVICE_DETECTORS.map((detector) => [detector.name, detector]))

/**
 * Run one named detector. A probe resolves to `{status, body, headers}`;
 * every transport failure is the detector's `error` verdict, never a throw.
 * Unknown names resolve as an error row so a stale renderer cannot crash IPC.
 */
export async function detectService(name: UnlockServiceName, probe: (step: ProbeStep) => Promise<ProbeResponse>): Promise<ServiceUnlockResult> {
  const detector = DETECTOR_BY_NAME.get(name)
  if (!detector) return { name, status: 'error', region: null }
  try {
    return await detector.steps(probe)
  } catch {
    return { name, status: 'error', region: null }
  }
}
