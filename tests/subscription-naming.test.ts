import { describe, it, expect } from 'vitest'
import {
  parseDispositionFilename,
  deriveFallbackSubscriptionName,
  SubscriptionFetcher
} from '../src/main/subscriptions/subscription-fetcher'

describe('parseDispositionFilename (Clash Party style subscription naming)', () => {
  it('parses the RFC 5987 extended form with percent decoding', () => {
    expect(parseDispositionFilename("attachment; filename*=UTF-8''%E9%A3%9E%E9%B8%9F.yaml")).toBe('飞鸟')
  })

  it('parses the plain quoted and unquoted forms', () => {
    expect(parseDispositionFilename('attachment; filename="my sub.yaml"')).toBe('my sub')
    expect(parseDispositionFilename('attachment; filename=airport.conf')).toBe('airport')
  })

  it('prefers the extended form when both are present', () => {
    expect(
      parseDispositionFilename("attachment; filename=\"fallback.yaml\"; filename*=UTF-8''%E4%BC%98%E5%85%88.yaml")
    ).toBe('优先')
  })

  it('returns null for missing, empty or garbage headers', () => {
    expect(parseDispositionFilename(null)).toBeNull()
    expect(parseDispositionFilename('')).toBeNull()
    expect(parseDispositionFilename('inline')).toBeNull()
    expect(parseDispositionFilename('attachment; filename="  "')).toBeNull()
  })

  it('strips control characters and caps the length', () => {
    expect(parseDispositionFilename('attachment; filename="a\u0007b\nc.yaml"')).toBe('abc')
    expect(parseDispositionFilename(`attachment; filename="${'x'.repeat(80)}"`)).toHaveLength(48)
  })
})

describe('deriveFallbackSubscriptionName', () => {
  it('uses the URL host, never the path (paths can carry tokens)', () => {
    expect(deriveFallbackSubscriptionName('https://example.com/sub?token=secret')).toBe('example.com')
  })

  it('caps overlong hosts and returns null for unparseable URLs', () => {
    expect(deriveFallbackSubscriptionName(`https://${'a'.repeat(80)}.com/sub`)).toHaveLength(48)
    expect(deriveFallbackSubscriptionName('not a url')).toBeNull()
  })
})

describe('SubscriptionFetcher.suggestedName', () => {
  it('derives the name from Content-Disposition and the host fallback', async () => {
    const fetcher = new SubscriptionFetcher({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        headers: { has: () => true, get: () => "attachment; filename*=UTF-8''%E9%A3%9E%E9%B8%9F.yaml" },
        text: async () => 'mode: rule\n'
      })
    })
    const result = await fetcher.fetch('https://example.com/tokenish-path')
    expect(result.suggestedName).toBe('飞鸟')

    const plain = new SubscriptionFetcher({
      fetchFn: async () => ({ ok: true, status: 200, text: async () => 'mode: rule\n' })
    })
    const fallback = await plain.fetch('https://airport.example.com/sub')
    expect(fallback.suggestedName).toBe('airport.example.com')
  })

  it('never suggests a name containing the URL token path', async () => {
    const fetcher = new SubscriptionFetcher({
      fetchFn: async () => ({ ok: true, status: 200, text: async () => 'mode: rule\n' })
    })
    const result = await fetcher.fetch('https://gist.githubusercontent.com/user/8bb18928838278784d6a534b23b929ab/raw')
    expect(result.suggestedName).toBe('gist.githubusercontent.com')
    expect(result.suggestedName).not.toContain('8bb18928838278784d6a534b23b929ab')
  })
})
