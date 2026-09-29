import { MAX_ARCHIVE_BYTES } from './config-backup'
import type { WebDavBackupTarget } from '../../shared/webdav-backup'

export type WebDavFetch = typeof fetch

/** A user-selected HTTPS file target, with no URL-embedded credentials or redirect. */
export function validateWebDavTarget(input: unknown): WebDavBackupTarget {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('WebDAV 参数无效')
  const target = input as Record<string, unknown>
  if (typeof target.url !== 'string' || target.url.length > 2048 ||
      typeof target.username !== 'string' || target.username.length > 256 ||
      typeof target.password !== 'string' || target.password.length > 1024) throw new Error('WebDAV 参数无效')
  let parsed: URL
  try { parsed = new URL(target.url) }
  catch { throw new Error('请输入有效的 WebDAV 文件地址') }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash ||
      !parsed.pathname.toLowerCase().endsWith('.murge-backup')) {
    throw new Error('WebDAV 地址须为 HTTPS 且指向 .murge-backup 文件，不能包含账号、查询参数或片段')
  }
  if (target.password && !target.username) throw new Error('请填写 WebDAV 用户名')
  return { url: parsed.href, username: target.username, password: target.password }
}

function headers(target: WebDavBackupTarget): HeadersInit {
  const result: Record<string, string> = { 'Cache-Control': 'no-store' }
  if (target.username) result.Authorization = `Basic ${Buffer.from(`${target.username}:${target.password}`, 'utf8').toString('base64')}`
  return result
}

function checkResponse(response: Response, expected: readonly number[]): void {
  if (expected.includes(response.status)) return
  if (response.status === 401 || response.status === 403) throw new Error('WebDAV 认证失败或没有权限')
  if (response.status === 404) throw new Error('WebDAV 备份文件不存在')
  if (response.status >= 300 && response.status < 400) throw new Error('WebDAV 服务要求重定向，请填写最终 HTTPS 文件地址')
  throw new Error(`WebDAV 请求失败（HTTP ${response.status}）`)
}

async function request(target: WebDavBackupTarget, init: RequestInit, fetchFn: WebDavFetch): Promise<Response> {
  try {
    return await fetchFn(target.url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) })
  } catch { throw new Error('WebDAV 网络连接失败或超时') }
}

export async function uploadWebDavBackup(input: WebDavBackupTarget, archive: Buffer, fetchFn: WebDavFetch = fetch): Promise<void> {
  const target = validateWebDavTarget(input)
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('备份文件超过上限')
  const response = await request(target, {
    method: 'PUT', headers: { ...headers(target), 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(archive)
  }, fetchFn)
  checkResponse(response, [200, 201, 204])
}

export async function downloadWebDavBackup(input: WebDavBackupTarget, fetchFn: WebDavFetch = fetch): Promise<Buffer> {
  const target = validateWebDavTarget(input)
  const response = await request(target, { method: 'GET', headers: headers(target), cache: 'no-store' }, fetchFn)
  checkResponse(response, [200])
  if (Number(response.headers.get('content-length') ?? 0) > MAX_ARCHIVE_BYTES) throw new Error('WebDAV 备份文件超过上限')
  if (!response.body) throw new Error('WebDAV 未返回备份内容')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_ARCHIVE_BYTES) throw new Error('WebDAV 备份文件超过上限')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}
