import { readFileSync } from 'node:fs'

const brand = JSON.parse(readFileSync(new URL('./brand.config.json', import.meta.url), 'utf8'))

export default {
  appId: brand.appId,
  productName: brand.productName,
  executableName: brand.executableName,
  directories: {
    output: 'dist',
    buildResources: 'resources'
  },
  files: ['out/**/*', 'brand.config.json'],
  extraResources: [
    { from: 'resources/bin', to: 'bin', filter: ['**/*'] },
    { from: 'resources/defaults', to: 'defaults', filter: ['**/*'] }
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    artifactName: `${brand.productName}-Setup-${'${version}'}-${'${arch}'}.${'${ext}'}`
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true
  },
  protocols: [{ name: brand.productName, schemes: [brand.protocolScheme] }]
}
