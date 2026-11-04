/** Credentials are supplied for one operation and never persisted. */
export interface WebDavBackupTarget {
  url: string
  username: string
  password: string
}

export const WEBDAV_BACKUP_EXTENSION = '.murge-backup'
export const WEBDAV_DEFAULT_FILE_PATH = 'Murge/murge.murge-backup'

function encodeSegment(segment: string): string {
  let decoded = segment
  try { decoded = decodeURIComponent(segment) } catch { /* keep raw text */ }
  return encodeURIComponent(decoded)
}

/**
 * Joins the WebDAV server address and the remote file path into the single
 * file URL the backend expects. A missing `.murge-backup` suffix is appended,
 * and a path ending in `/` gets the default file name. When the address is
 * already a full `.murge-backup` URL it is used unchanged. Validation (HTTPS,
 * no credentials, no query or fragment) stays in the Rust backend.
 */
export function composeWebDavFileUrl(address: string, filePath: string): string {
  const base = address.trim()
  if (!base) return ''
  if (base.toLowerCase().split(/[?#]/)[0].endsWith(WEBDAV_BACKUP_EXTENSION)) return base
  let path = (filePath.trim() || WEBDAV_DEFAULT_FILE_PATH).replace(/\\/g, '/')
  if (path.endsWith('/')) path += WEBDAV_DEFAULT_FILE_PATH.split('/').pop()
  if (!path.toLowerCase().endsWith(WEBDAV_BACKUP_EXTENSION)) path += WEBDAV_BACKUP_EXTENSION
  const segments = path.split('/').filter((segment) => segment && segment !== '.')
  return `${base.replace(/\/+$/, '')}/${segments.map(encodeSegment).join('/')}`
}
