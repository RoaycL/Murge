import { describe, it, expect } from 'vitest'
import {
  traceLocation,
  extractQuotedField,
  classifyBlockedStatus,
  chatgpt,
  claude,
  gemini,
  grok,
  netflix,
  disneyPlus,
  tiktok,
  youtube,
  github,
  spotify,
  detectService,
  SERVICE_DETECTORS,
  type ProbeResponse
} from '../src/main/services/service-detectors'
import type { ProbeStep } from '../src/main/services/service-detectors'
import type { ServiceUnlockResult } from '../src/shared/unlock'

/** Scripted transport: each probe pops the next canned response. */
function scripted(responses: ProbeResponse[]): (step: ProbeStep) => Promise<ProbeResponse> {
  const queue = [...responses]
  return async () => queue.shift() ?? { status: null, body: '', headers: {} }
}

function ok(body: string, headers: Record<string, string | string[]> = {}): ProbeResponse {
  return { status: 200, body, headers }
}

function fail(status: number): ProbeResponse {
  return { status, body: '', headers: {} }
}

describe('unlock helpers', () => {
  it('reads the Cloudflare trace loc= line case-insensitively to Verge semantics', () => {
    expect(traceLocation('fl=1\nloc=US\ntls=1.3')).toBe('US')
    expect(traceLocation('loc=de\n')).toBe('DE')
    expect(traceLocation('no marker here')).toBeNull()
    expect(traceLocation('loc=\n')).toBeNull()
  })

  it('scrapes quoted JSON fields like Verge extract_quoted_field', () => {
    expect(extractQuotedField('{"GL":"US","x":1}', 'GL')).toBe('US')
    expect(extractQuotedField('a "countryCode": "kr" b', 'countryCode')).toBe('kr')
    expect(extractQuotedField('missing', 'GL')).toBeNull()
  })

  it('maps 403/451 to unsupported and other non-2xx to error', () => {
    expect(classifyBlockedStatus(403)).toBe('unsupported')
    expect(classifyBlockedStatus(451)).toBe('unsupported')
    expect(classifyBlockedStatus(502)).toBe('error')
    expect(classifyBlockedStatus(null)).toBe('error')
    expect(classifyBlockedStatus(204)).toBeNull()
  })
})

describe('per-service detectors', () => {
  it('ChatGPT: unsupported_country body marks 不支持, clean body marks 支持 (Verge chatgpt.rs)', async () => {
    const blocked = await chatgpt.steps(scripted([ok('loc=SG'), ok('{"data":"unsupported_country"}')]))
    expect(blocked).toEqual({ name: 'ChatGPT', status: 'unsupported', region: 'SG' })
    const clean = await chatgpt.steps(scripted([ok('loc=JP'), fail(500), ok('all good')]))
    // Verge accepts ANY status on the compliance endpoint — decision is body-only.
    expect(clean.status).toBe('supported')
    expect(clean.region).toBe('JP')
  })

  it('Claude: blocked country list → 不支持; missing trace → 测试失败', async () => {
    const blocked = await claude.steps(scripted([ok('loc=HK')]))
    expect(blocked.status).toBe('unsupported')
    expect(blocked.region).toBe('HK')
    const okCase = await claude.steps(scripted([ok('loc=SG')]))
    expect(okCase.status).toBe('supported')
    const failed = await claude.steps(scripted([{ status: null, body: '', headers: {} }]))
    expect(failed.status).toBe('error')
  })

  it('Gemini: 3-char uppercase marker after the payload constant; blocked list → 不支持', async () => {
    const payload = 'x,2,1,200,"SGP rest'
    const okCase = await gemini.steps(scripted([ok(payload)]))
    expect(okCase).toEqual({ name: 'Gemini', status: 'supported', region: 'SGP' })
    const blocked = await gemini.steps(scripted([ok('a,2,1,200,"HKG')]))
    expect(blocked.status).toBe('unsupported')
    const broken = await gemini.steps(scripted([ok('marker missing')]))
    expect(broken.status).toBe('error')
  })

  it('Grok: homepage gate + trace region', async () => {
    const okCase = await grok.steps(scripted([ok('loc=US'), ok('welcome')]))
    expect(okCase).toEqual({ name: 'Grok', status: 'supported', region: 'US' })
    const blocked = await grok.steps(scripted([ok('loc=CN'), fail(403)]))
    expect(blocked.status).toBe('unsupported')
  })

  it('Netflix: fast.com CDN verdict, 403 → IP banned, titles gate → stage-3 region', async () => {
    const cdnBody = JSON.stringify({ targets: [{ location: { country: 'JP' } }] })
    const banned = await netflix.steps(scripted([fail(403)]))
    expect(banned.status).toBe('unsupported')
    // Both titles 200/301 → stage-3 region probe; no location header falls
    // back to the CDN region (JP here).
    const okCase = await netflix.steps(
      scripted([ok(cdnBody), ok('title page'), ok('title page')])
    )
    expect(okCase).toEqual({ name: 'Netflix', status: 'supported', region: 'JP' })
    // Stage-3 location header (absolute URL; 4th path segment, pre-dash)
    // wins over the CDN region — Verge's nth(3) semantics.
    const withLocation = await netflix.steps(
      scripted([
        ok(cdnBody),
        { status: 301, body: '', headers: {} },
        { status: 200, body: '', headers: {} },
        { status: 200, body: '', headers: { location: 'https://www.netflix.com/us/title/80018499' } }
      ])
    )
    expect(withLocation).toEqual({ name: 'Netflix', status: 'supported', region: 'US' })
    const noRegion = await netflix.steps(scripted([ok(JSON.stringify({ targets: [] }))]))
    expect(noRegion.status).toBe('error')
  })

  it('Disney+: JP short-circuits to 支持; inSupportedLocation false → 不支持', async () => {
    const assertion = JSON.stringify({ assertion: 'A1' })
    const token = JSON.stringify({ refresh_token: 'R1' })
    const graph = (country: string, supported: boolean): string =>
      JSON.stringify({ data: { activeSession: { countryCode: country, inSupportedLocation: supported } } })
    const jp = await disneyPlus.steps(
      scripted([
        ok(assertion),
        ok(token),
        ok(JSON.stringify({ data: { countryCode: 'JP', inSupportedLocation: false } }))
      ])
    )
    expect(jp).toEqual({ name: 'Disney+', status: 'supported', region: 'JP' })
    const banned = await disneyPlus.steps(scripted([fail(403)]))
    expect(banned.status).toBe('unsupported')
    const soon = await disneyPlus.steps(
      scripted([ok(assertion), ok(token), ok(graph('TR', false))])
    )
    expect(soon.status).toBe('unsupported')
    const supported = await disneyPlus.steps(
      scripted([ok(assertion), ok(token), ok(graph('SG', true))])
    )
    expect(supported).toEqual({ name: 'Disney+', status: 'supported', region: 'SG' })
  })

  it('TikTok: keyword blocklist → 不支持; trace region wins, homepage marker as fallback', async () => {
    const blocked = await tiktok.steps(scripted([ok('loc=SG'), ok('Access Denied')]))
    expect(blocked.status).toBe('unsupported')
    // Verge prefers the trace loc= region; the homepage "region" marker is
    // only a fallback when the trace was unavailable.
    const withTrace = await tiktok.steps(scripted([ok('loc=SG'), ok('{"region":"ALISG-1"}')]))
    expect(withTrace).toEqual({ name: 'TikTok', status: 'supported', region: 'SG' })
    const fallback = await tiktok.steps(scripted([ok(''), ok('{"region":"ALISG-1"}')]))
    expect(fallback).toEqual({ name: 'TikTok', status: 'supported', region: 'ALISG' })
  })

  it('YouTube Premium: availability keywords + GL region (Verge youtube.rs)', async () => {
    const okCase = await youtube.steps(scripted([ok('Enjoy YouTube Premium ad-free {"GL":"US"}')]))
    expect(okCase).toEqual({ name: 'YouTube', status: 'supported', region: 'US' })
    const blocked = await youtube.steps(scripted([ok('Premium is not available in your country {"GL":"CN"}')]))
    expect(blocked.status).toBe('unsupported')
    expect(blocked.region).toBe('CN')
  })

  it('GitHub: homepage reachable → 支持 with trace region', async () => {
    const okCase = await github.steps(scripted([ok('loc=NL'), ok('github home')]))
    expect(okCase).toEqual({ name: 'GitHub', status: 'supported', region: 'NL' })
    const blocked = await github.steps(scripted([ok('loc=NL'), fail(451)]))
    expect(blocked.status).toBe('unsupported')
  })

  it('Spotify: country-selector API gate + countryCode market', async () => {
    const okCase = await spotify.steps(scripted([ok('{"countryCode":"US","lists":[]}')]))
    expect(okCase).toEqual({ name: 'Spotify', status: 'supported', region: 'US' })
    const blocked = await spotify.steps(scripted([ok('not available in your country')]))
    expect(blocked.status).toBe('unsupported')
    const banned = await spotify.steps(scripted([fail(403)]))
    expect(banned.status).toBe('unsupported')
  })

  it('detectService degrades unknown names and detector throws to an error row', async () => {
    const unknown = await detectService('Murge' as never, scripted([]))
    expect(unknown).toEqual({ name: 'Murge', status: 'error', region: null })
    const all = await Promise.all(SERVICE_DETECTORS.map((detector) => detector.steps(scripted([{ status: null, body: '', headers: {} }]))))
    expect(all.every((entry: ServiceUnlockResult) => entry.status === 'error')).toBe(true)
  })
})
