export interface ConfigBackupPreview {
  token: string
  createdAt: string
  appVersion: string
  compatible: boolean
  compatibilityMessage: string
  profileCount: number
  subscriptionSourceCount: number
  includesOverrides: boolean
  includesSubStore: boolean
  fileCount: number
  replaceCount: number
  addCount: number
  removeCount: number
}

export interface ConfigBackupResult { saved: boolean }
