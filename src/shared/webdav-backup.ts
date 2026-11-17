/**
 * One WebDAV operation's target. `password: null` uses the password saved in
 * the system credential store (see `WebDavBackupSettings.hasPassword`).
 */
export interface WebDavBackupTarget {
  url: string
  username: string
  password: string | null
}

/** Remembered target and schedule (`backup.webdavSave`). Never holds secrets. */
export interface WebDavBackupForm {
  address: string
  filePath: string
  /** The composed file URL, see `composeWebDavFileUrl`. */
  url: string
  username: string
  autoEnabled: boolean
  intervalHours: number
}

/** `null` or `''` keeps the saved value; a non-empty string replaces it. */
export interface WebDavBackupSecrets {
  password: string | null
  passphrase: string | null
}

/**
 * What the backend returns: the saved form plus schedule status. The WebDAV
 * password and the archive passphrase live in the system credential store and
 * are only reported as saved or not.
 */
export interface WebDavBackupSettings extends WebDavBackupForm {
  hasPassword: boolean
  hasPassphrase: boolean
  lastSuccessAt: number | null
  lastAttemptAt: number | null
  lastError: string | null
  /** Offered auto-backup intervals, in hours. */
  intervals: number[]
}

export const WEBDAV_AUTO_INTERVALS = [1, 6, 12, 24, 72, 168] as const

export const WEBDAV_BACKUP_EXTENSION = '.murge-backup'
/** Default remote path, e.g. `<Product>/<product>.murge-backup`. */
export function defaultWebDavFilePath(productName: string): string {
  const name = productName.trim().replace(/[\\/:*?"<>|#%]+/g, '') || 'backup'
  return `${name}/${name.toLowerCase().replace(/\s+/g, '-')}${WEBDAV_BACKUP_EXTENSION}`
}

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
export function composeWebDavFileUrl(address: string, filePath: string, defaultPath = defaultWebDavFilePath('')): string {
  const base = address.trim()
  if (!base) return ''
  if (base.toLowerCase().split(/[?#]/)[0].endsWith(WEBDAV_BACKUP_EXTENSION)) return base
  let path = (filePath.trim() || defaultPath).replace(/\\/g, '/')
  if (path.endsWith('/')) path += defaultPath.split('/').pop()
  if (!path.toLowerCase().endsWith(WEBDAV_BACKUP_EXTENSION)) path += WEBDAV_BACKUP_EXTENSION
  const segments = path.split('/').filter((segment) => segment && segment !== '.')
  return `${base.replace(/\/+$/, '')}/${segments.map(encodeSegment).join('/')}`
}
