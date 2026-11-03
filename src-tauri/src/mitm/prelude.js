// Surge-compatible script globals, evaluated before every script.
// `__host` is the Rust bridge; everything here is plain JS on top of it.
(function () {
  'use strict'
  const H = globalThis.__host
  delete globalThis.__host
  const input = JSON.parse(H.input())
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  // `A="x"&B=true` → { A: 'x', B: true } (Loon object arguments).
  const argumentObject = (text) => {
    const out = {}
    for (const part of String(text || '').split('&')) {
      if (!part) continue
      const eq = part.indexOf('=')
      const key = eq < 0 ? part : part.slice(0, eq)
      let value = eq < 0 ? '' : part.slice(eq + 1)
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
      out[key] = value === 'true' ? true : value === 'false' ? false : value
    }
    return out
  }

  // --- console / timers ---------------------------------------------------
  const show = (v) => {
    if (typeof v === 'string') return v
    if (v instanceof Error) return v.stack ? `${v.message}\n${v.stack}` : String(v)
    try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
  }
  const log = (level) => (...args) => H.log(level, args.map(show).join(' '))
  define('console', { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') })

  const timers = new Map()
  let timerSeq = 0
  define('setTimeout', (fn, ms, ...args) => {
    const id = ++timerSeq
    timers.set(id, { fn, args, repeat: null })
    H.timer(id, Math.max(0, Number(ms) || 0))
    return id
  })
  define('setInterval', (fn, ms, ...args) => {
    const id = ++timerSeq
    const delay = Math.max(1, Number(ms) || 0)
    timers.set(id, { fn, args, repeat: delay })
    H.timer(id, delay)
    return id
  })
  const clear = (id) => { timers.delete(id) }
  define('clearTimeout', clear)
  define('clearInterval', clear)
  define('__fireTimer', (id) => {
    const timer = timers.get(id)
    if (!timer) return
    if (timer.repeat === null) timers.delete(id)
    else H.timer(id, timer.repeat)
    if (typeof timer.fn === 'function') timer.fn(...timer.args)
  })

  // --- text / base64 ------------------------------------------------------
  class TextEncoder {
    get encoding() { return 'utf-8' }
    encode(text = '') { return H.utf8Encode(String(text)) }
  }
  class TextDecoder {
    constructor(label = 'utf-8', options = {}) {
      const name = String(label).toLowerCase()
      if (name !== 'utf-8' && name !== 'utf8') throw new RangeError(`不支持的编码 ${label}`)
      this.fatal = !!(options && options.fatal)
      this.ignoreBOM = !!(options && options.ignoreBOM)
    }
    get encoding() { return 'utf-8' }
    decode(input) {
      if (input === undefined || input === null) return ''
      return H.utf8Decode(input, this.fatal, this.ignoreBOM)
    }
  }
  define('TextEncoder', TextEncoder)
  define('TextDecoder', TextDecoder)

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  define('btoa', (input) => {
    const s = String(input)
    let out = ''
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2)
      if (a > 255 || b > 255 || c > 255) throw new Error('btoa: 字符超出 Latin1 范围')
      const n = (a << 16) | ((b || 0) << 8) | (c || 0)
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] +
        (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=')
    }
    return out
  })
  define('atob', (input) => {
    const s = String(input).replace(/[\s=]+/g, '')
    let out = ''
    let buffer = 0, bits = 0
    for (const ch of s) {
      const v = B64.indexOf(ch === '-' ? '+' : ch === '_' ? '/' : ch)
      if (v < 0) throw new Error('atob: 非法字符')
      buffer = (buffer << 6) | v
      bits += 6
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((buffer >> bits) & 255) }
    }
    return out
  })

  // --- URL / URLSearchParams (enough for scripts) -------------------------
  class URLSearchParams {
    constructor(init = '') {
      this._list = []
      if (typeof init === 'string') {
        const text = init.startsWith('?') ? init.slice(1) : init
        for (const part of text.split('&')) {
          if (!part) continue
          const i = part.indexOf('=')
          const dec = (v) => { try { return decodeURIComponent(v.replace(/\+/g, ' ')) } catch { return v } }
          this._list.push(i < 0 ? [dec(part), ''] : [dec(part.slice(0, i)), dec(part.slice(i + 1))])
        }
      } else if (init && typeof init === 'object') {
        const entries = Array.isArray(init) || typeof init[Symbol.iterator] === 'function' ? init : Object.entries(init)
        for (const [k, v] of entries) this._list.push([String(k), String(v)])
      }
    }
    get(name) { const hit = this._list.find(([k]) => k === name); return hit ? hit[1] : null }
    getAll(name) { return this._list.filter(([k]) => k === name).map(([, v]) => v) }
    has(name) { return this._list.some(([k]) => k === name) }
    set(name, value) {
      const i = this._list.findIndex(([k]) => k === name)
      if (i < 0) this._list.push([name, String(value)])
      else { this._list[i][1] = String(value); this._list = this._list.filter(([k], j) => k !== name || j === i) }
      this._onchange && this._onchange()
    }
    append(name, value) { this._list.push([name, String(value)]); this._onchange && this._onchange() }
    delete(name) { this._list = this._list.filter(([k]) => k !== name); this._onchange && this._onchange() }
    forEach(fn, self) { for (const [k, v] of this._list) fn.call(self, v, k, this) }
    keys() { return this._list.map(([k]) => k)[Symbol.iterator]() }
    values() { return this._list.map(([, v]) => v)[Symbol.iterator]() }
    entries() { return this._list.map((e) => [...e])[Symbol.iterator]() }
    [Symbol.iterator]() { return this.entries() }
    get size() { return this._list.length }
    toString() {
      const enc = (v) => encodeURIComponent(v).replace(/%20/g, '+')
      return this._list.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&')
    }
  }
  const URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/(?:([^:@\/?#]*)(?::([^@\/?#]*))?@)?(\[[^\]]+\]|[^:\/?#]*)(?::(\d*))?([^?#]*)(\?[^#]*)?(#.*)?$/
  class URL {
    constructor(url, base) {
      let text = String(url)
      if (base !== undefined && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) {
        const b = new URL(base)
        if (text.startsWith('//')) text = b.protocol + text
        else if (text.startsWith('/')) text = b.origin + text
        else if (text.startsWith('?')) text = b.origin + b.pathname + text
        else if (text.startsWith('#')) text = b.origin + b.pathname + b.search + text
        else text = b.origin + b.pathname.replace(/[^/]*$/, '') + text
      }
      const m = URL_RE.exec(text)
      if (!m) throw new TypeError(`Invalid URL: ${text}`)
      this.protocol = m[1].toLowerCase()
      this.username = m[2] || ''
      this.password = m[3] || ''
      this.hostname = (m[4] || '').toLowerCase()
      this.port = m[5] || ''
      this.pathname = m[6] || '/'
      this.hash = m[8] || ''
      this._params = new URLSearchParams(m[7] || '')
      this._search = m[7] && m[7] !== '?' ? m[7] : ''
      this._params._onchange = () => { const s = this._params.toString(); this._search = s ? `?${s}` : '' }
    }
    get search() { return this._search }
    set search(v) { const s = String(v); this._search = s && s !== '?' ? (s.startsWith('?') ? s : `?${s}`) : ''; const p = new URLSearchParams(this._search); this._params._list = p._list }
    get searchParams() { return this._params }
    get host() { return this.port ? `${this.hostname}:${this.port}` : this.hostname }
    set host(v) { const [h, p] = String(v).split(':'); this.hostname = h; this.port = p || '' }
    get origin() { return `${this.protocol}//${this.host}` }
    get href() {
      const auth = this.username ? `${this.username}${this.password ? `:${this.password}` : ''}@` : ''
      return `${this.protocol}//${auth}${this.host}${this.pathname}${this.search}${this.hash}`
    }
    set href(v) { Object.assign(this, new URL(v)) }
    toString() { return this.href }
    toJSON() { return this.href }
  }
  define('URL', URL)
  define('URLSearchParams', URLSearchParams)

  // Header objects answer any capitalisation (`headers['content-type']` and
  // `headers['Content-Type']` both work), whatever the wire protocol used.
  const headerBag = (raw) => {
    const find = (target, prop) => {
      if (typeof prop !== 'string') return undefined
      if (Object.prototype.hasOwnProperty.call(target, prop)) return prop
      const lower = prop.toLowerCase()
      return Object.keys(target).find((key) => key.toLowerCase() === lower)
    }
    return new Proxy({ ...(raw || {}) }, {
      get: (target, prop, receiver) => {
        const key = find(target, prop)
        return key === undefined ? Reflect.get(target, prop, receiver) : target[key]
      },
      has: (target, prop) => find(target, prop) !== undefined || prop in target,
      set: (target, prop, value) => {
        const key = find(target, prop)
        if (key !== undefined && key !== prop) delete target[key]
        target[prop] = value
        return true
      },
      deleteProperty: (target, prop) => {
        if (typeof prop === 'string') {
          const lower = prop.toLowerCase()
          for (const key of Object.keys(target)) if (key.toLowerCase() === lower) delete target[key]
        }
        return true
      },
    })
  }

  // --- $request / $response ----------------------------------------------
  const binary = input.binary
  const withBody = (message, body) => {
    if (body === null || body === undefined) return message
    message.body = body
    if (binary) message.bodyBytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    return message
  }
  define('$request', withBody({
    url: input.request.url,
    method: input.request.method,
    headers: headerBag(input.request.headers),
    id: input.id,
  }, H.requestBody()))
  if (input.response) {
    define('$response', withBody({
      status: input.response.status,
      statusCode: input.response.status,
      headers: headerBag(input.response.headers),
    }, H.responseBody()))
  }

  // Loon plugins pass `argument=[{A},{B}]`, which scripts see as an object.
  define('$argument', input.argumentObject ? argumentObject(input.argument) : input.argument)
  define('$script', { name: input.name, type: input.type, startTime: new Date(), sessionIndex: 0 })
  define('$environment', Object.freeze({
    'surge-version': '5.20.0',
    'surge-build': '3500',
    language: 'zh-Hans',
    system: 'macOS',
    murge: true,
  }))

  // --- $persistentStore / $notification / $utils -------------------------
  define('$persistentStore', {
    read: (key) => H.storeRead(key === undefined || key === null ? '' : String(key)),
    write: (value, key) => H.storeWrite(
      value === undefined || value === null ? null : String(value),
      key === undefined || key === null ? '' : String(key),
    ),
  })
  define('$notification', {
    post: (title, subtitle, body, options) => {
      let url = ''
      if (typeof options === 'string') url = options
      else if (options && typeof options === 'object') url = options.url || options['open-url'] || options.openUrl || ''
      H.notify(String(title ?? ''), String(subtitle ?? ''), String(body ?? ''), String(url))
    },
  })
  define('$utils', {
    geoip: () => '',
    ipasn: () => '',
    ipaso: () => '',
    ungzip: (data) => H.ungzip(data),
  })

  // --- $httpClient ----------------------------------------------------------
  const callbacks = new Map()
  let httpSeq = 0
  const toBytes = (body) => {
    if (body === undefined || body === null) return null
    if (body instanceof Uint8Array) return body
    if (body instanceof ArrayBuffer) return new Uint8Array(body)
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    if (typeof body === 'object') return H.utf8Encode(JSON.stringify(body))
    return H.utf8Encode(String(body))
  }
  const request = (method) => (options, callback) => {
    const opts = typeof options === 'string' ? { url: options } : { ...(options || {}) }
    const id = ++httpSeq
    callbacks.set(id, typeof callback === 'function' ? callback : () => {})
    const meta = {
      method: String(opts.method || method).toUpperCase(),
      url: String(opts.url || ''),
      headers: opts.headers || {},
      timeout: Number(opts.timeout) || 0,
      binary: !!opts['binary-mode'],
      redirect: opts['auto-redirect'] !== false && opts.followRedirect !== false,
      insecure: !!opts.insecure,
    }
    H.http(id, JSON.stringify(meta), toBytes(opts.body ?? opts.bodyBytes))
  }
  const client = {}
  for (const m of ['get', 'post', 'put', 'delete', 'head', 'options', 'patch']) client[m] = request(m)
  define('$httpClient', client)
  define('__deliverHttp', (id, error, meta, data) => {
    const callback = callbacks.get(id)
    callbacks.delete(id)
    if (!callback) return
    if (error) return callback(error, null, null)
    const response = JSON.parse(meta)
    response.headers = headerBag(response.headers)
    response.statusCode = response.status
    if (data instanceof Uint8Array) {
      response.body = data
      response.bodyBytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    } else response.body = data
    callback(null, response, data)
  })

  define('$done', (value) => H.done(value === undefined ? null : value))

  // --- Quantumult X names, only for scripts imported from QX syntax -----
  if (input.qx) {
    define('$prefs', {
      valueForKey: (key) => $persistentStore.read(key),
      setValueForKey: (value, key) => $persistentStore.write(value, key),
      removeValueForKey: (key) => $persistentStore.write(null, key),
      removeAllValues: () => false,
    })
    define('$notify', (title, subtitle, body, options) => $notification.post(title, subtitle, body, options && (options['open-url'] || options.url)))
    define('$task', {
      fetch: (options) => new Promise((resolve, reject) => {
        const opts = typeof options === 'string' ? { url: options } : { ...(options || {}) }
        if (opts.opts && opts.opts.redirection === false) opts['auto-redirect'] = false
        $httpClient[String(opts.method || 'GET').toLowerCase()] ?
          $httpClient[String(opts.method || 'GET').toLowerCase()](opts, (error, response, data) => {
            if (error) return reject({ error })
            resolve({ statusCode: response.status, status: response.status, headers: response.headers, body: data, bodyBytes: response.bodyBytes })
          }) : reject({ error: `不支持的方法 ${opts.method}` })
      }),
    })
  }
})()
