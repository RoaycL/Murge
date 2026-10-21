/** Credentials are supplied for one operation and never persisted. */
export interface WebDavBackupTarget {
  url: string
  username: string
  password: string
}
