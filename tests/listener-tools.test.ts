import { describe, it, expect } from 'vitest'
import { parseHostPort, listenersMatchingText, isLoopbackHost } from './listener-tools'

describe('parseHostPort', () => {
  it('parses bare IPv4 host:port', () => {
    expect(parseHostPort('127.0.0.1:8080')).toEqual({ host: '127.0.0.1', port: 8080 })
  })

  it('parses bracketed IPv6 [::1]:port', () => {
    expect(parseHostPort('[::1]:8080')).toEqual({ host: '::1', port: 8080 })
    expect(parseHostPort('[::]:8080')).toEqual({ host: '::', port: 8080 })
  })

  it('parses bare IPv6 ::1:port (unbracketed)', () => {
    expect(parseHostPort('::1:8080')).toEqual({ host: '::1', port: 8080 })
  })

  it('parses a non-loopback IPv4 address', () => {
    expect(parseHostPort('192.168.1.50:8443')).toEqual({ host: '192.168.1.50', port: 8443 })
  })

  it('rejects wildcard peer port tokens and junk', () => {
    expect(parseHostPort('0.0.0.0:*')).toBeNull()
    expect(parseHostPort('0.0.0.0:0')).toBeNull() // port 0 is not a real listener
    expect(parseHostPort('TCP')).toBeNull()
    expect(parseHostPort('')).toBeNull()
  })
})

describe('listenersMatchingText', () => {
  const winNetstat = `Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:20000        0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:20001        0.0.0.0:0              LISTENING       5678
  TCP    0.0.0.0:20002          0.0.0.0:0              LISTENING       90
  TCP    [::1]:20003            [::]:0                 LISTENING       91
  TCP    [::]:20004             [::]:0                 LISTENING       92
`

  it('finds the loopback host for a Windows LISTENING port', () => {
    expect(listenersMatchingText(winNetstat, 20000, true)).toEqual(['127.0.0.1'])
    expect(listenersMatchingText(winNetstat, 20001, true)).toEqual(['127.0.0.1'])
  })

  it('surfaces a wildcard bind so the caller can reject it', () => {
    expect(listenersMatchingText(winNetstat, 20002, true)).toEqual(['0.0.0.0'])
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
  })

  it('handles IPv6 loopback and wildcard binders', () => {
    expect(listenersMatchingText(winNetstat, 20003, true)).toEqual(['::1'])
    expect(listenersMatchingText(winNetstat, 20004, true)).toEqual(['::'])
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('::')).toBe(false)
  })

  it('parses unix ss LISTEN output', () => {
    const ss = `State      Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN     0      128    127.0.0.1:20000      0.0.0.0:*       users:(("mihomo",pid=1))
LISTEN     0      128    [::1]:20001          [::]:*          users:(("mihomo",pid=1))
`
    expect(listenersMatchingText(ss, 20000, false)).toEqual(['127.0.0.1'])
    expect(listenersMatchingText(ss, 20001, false)).toEqual(['::1'])
  })

  it('Fails closed with no matching listener or empty input', () => {
    expect(() => listenersMatchingText('', 8080, true)).toThrow(/no listener found/)
    expect(() => listenersMatchingText('TCP    0.0.0.0:9  0.0.0.0:0  LISTENING  1', 8080, true)).toThrow(
      /no listener found/
    )
  })

  it('ignores non-listening rows for the target port (e.g. ESTABLISHED)', () => {
    const text = `TCP    127.0.0.1:20000        127.0.0.1:50000   ESTABLISHED  1
TCP    127.0.0.1:20001        0.0.0.0:0         LISTENING    2
`
    // Only an ESTABLISHED row exists on 20000, so it must fail closed (an
    // established socket is not a listener).
    expect(() => listenersMatchingText(text, 20000, true)).toThrow(/no listener found/)
    // The LISTENING row on 20001 is correctly found.
    expect(listenersMatchingText(text, 20001, true)).toEqual(['127.0.0.1'])
  })
})
