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
  // Metadata merged into the packaged package.json. `author.name` is what
  // electron-builder reports as the Windows `CompanyName`, and `copyright`
  // becomes the `LegalCopyright` VersionInfo string — both sourced from brand
  // so a rename needs a single edit.
  extraMetadata: {
    author: { name: brand.companyName }
  },
  copyright: brand.copyright,
  extraResources: [
    { from: 'resources/bin', to: 'bin', filter: ['**/*'] },
    { from: 'resources/defaults', to: 'defaults', filter: ['**/*'] },
    { from: 'resources/THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' }
  ],
  win: {
    icon: 'icon.ico',
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    artifactName: `${brand.productName}-Setup-${'${version}'}-${'${arch}'}.${'${ext}'}`
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    // Assisted installer default keeps user data on uninstall. This is set
    // explicitly so the preserve-user-profiles behavior is a documented,
    // deliberate choice rather than an incidental default: user profiles live
    // in the application-data namespace and must survive an uninstall.
    deleteAppDataOnUninstall: false,
    // The EULA/license page is intentionally <em>not</em> configured here: the
    // application license is pending an owner decision (see docs/ROADMAP.md
    // Phase 6). The third-party notices are shipped as a bundled resource
    // instead of being presented as a license agreement.
  },
  protocols: [{ name: brand.productName, schemes: [brand.protocolScheme] }]
}
