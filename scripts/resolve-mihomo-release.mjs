/** Resolve a stable upstream release into a complete per-build lock manifest. */
export function resolveMihomoRelease(release, baseline) {
  if (release?.draft || release?.prerelease || !/^v\d+\.\d+\.\d+$/.test(release?.tag_name ?? '') || !Array.isArray(release.assets)) {
    throw new Error('Invalid stable mihomo release')
  }
  const version = release.tag_name
  const releaseBase = `https://github.com/MetaCubeX/mihomo/releases/download/${version}`
  const assets = baseline.assets.map((target) => {
    const stem = target.innerName.replace(/\.exe$/, '')
    const filename = `${stem}-${version}.${target.kind}`
    const matches = release.assets.filter((asset) => asset.name === filename)
    const asset = matches[0]
    if (matches.length !== 1 || !/^sha256:[0-9a-f]{64}$/i.test(asset.digest ?? '') ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 256 * 1024 * 1024 ||
        asset.browser_download_url !== `${releaseBase}/${filename}`) {
      throw new Error(`Missing or invalid mihomo release asset: ${filename}`)
    }
    return { ...target, filename, sha256: asset.digest.slice(7).toLowerCase(), size: asset.size }
  })
  return { ...baseline, version, releaseBase, assets }
}

export async function discoverMihomoRelease(baseline, { fetchFn = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const response = await fetchFn('https://api.github.com/repos/MetaCubeX/mihomo/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    redirect: 'error', signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`Mihomo release lookup: HTTP ${response.status}`)
  return resolveMihomoRelease(await response.json(), baseline)
}
