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
    { from: 'resources/icon.png', to: 'icon.png' },
    // Each installer carries only its own architecture's pinned mihomo archive.
    // The archive is verified before packaging and re-verified at runtime before
    // extraction, so first launch never depends on GitHub availability.
    { from: `resources/bin/${'${arch}'}`, to: 'bin', filter: ['*.zip'] },
    { from: 'resources/defaults', to: 'defaults', filter: ['**/*'] },
    { from: 'LICENSE', to: 'LICENSE.txt' },
    { from: 'resources/THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
    // Retained upstream license texts for every bundled dependency. Shipped
    // alongside the app so the notice-preservation obligation is met by the
    // installed artifact itself, not just the source tree.
    { from: 'resources/licenses', to: 'licenses', filter: ['**/*'] }
  ],
  win: {
    icon: 'icon.ico',
    // Strategy A: ship exactly two per-arch installers (x64 + arm64) and never
    // the combined multi-arch one. The combined artifact is produced by the NSIS
    // universal-installer path, so it is disabled here via `buildUniversalInstaller:
    // false`; the arch-suffixed artifact name then yields exactly
    // `-x64.exe` and `-arm64.exe` and no ~373MB combined file.
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    artifactName: `${brand.productName}-Setup-${'${version}'}-${'${arch}'}.${'${ext}'}`
  },
  nsis: {
    oneClick: false,
    // Restore an owned system proxy before the uninstaller deletes the app files
    // (see resources/nsis/uninstall-restore.nsh). The installed app's headless
    // `--restore-system-proxy` CLI reads its owned backup from app-data and puts
    // the HKCU Internet Settings proxy back to the exact pre-enable values only
    // if the registry still matches the enabled state.
    include: 'resources/nsis/uninstall-restore.nsh',
    // Never build the NSIS universal/combined installer. Produces one file per
    // arch (see `win.target`) instead of a big combined one, so a full build
    // yields exactly two distributable installers.
    buildUniversalInstaller: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    // Documentary only: electron-builder's schema scopes this flag to the
    // one-click installer, so with `oneClick: false` it is never read. It is
    // recorded explicitly so the preserve-user-profiles behavior is a stated,
    // deliberate choice rather than an incidental default — user profiles live
    // in the application-data namespace and must survive an uninstall.
    deleteAppDataOnUninstall: false,
    // GPL-3.0-only is a grant of software freedom, not an installer EULA that
    // users must accept. Its complete text and the third-party notices are
    // shipped as installed resources instead of being shown as click-through
    // contract terms.
  },
  protocols: [{ name: brand.productName, schemes: [brand.protocolScheme] }]
}
