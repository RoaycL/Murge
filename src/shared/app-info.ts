export interface AppInfo {
  version: string
  platform: 'win32' | 'darwin' | 'linux' | 'other'
  arch: string
}
