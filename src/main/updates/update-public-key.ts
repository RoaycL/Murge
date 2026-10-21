/**
 * The release-signing public key (base64 of the minisign `.pub` file that
 * `tauri signer generate` writes) — the same key the Tauri build pins in
 * `src-tauri/tauri.conf.json` `plugins.updater.pubkey`. The private half
 * lives only in the repository's GitHub secrets.
 *
 * While empty, the Electron build keeps the electron-updater driver; once
 * set, it only ever installs installers signed with this key.
 */
export const UPDATE_PUBLIC_KEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEIxM0MxOEYyN0U1QUREMUEKUldRYTNWcCs4aGc4c1VvUmNaR2VUSlNjUU9CNWdFVk9uTTlTVXk5a2ZjMjdRQm5VNVVLYVJ1aVMK'
