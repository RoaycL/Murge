import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

/**
 * 任务 2/4 的 UI 契约：解锁测试卡片挂进网络诊断抽屉；外部资源页改用「集合」
 * 措辞、每节配「更新全部」、每行配「查看配置」入口（详情抽屉合并 profile
 * 声明与控制器状态）。These read the sources so a revert cannot slip through.
 */
describe('network drawer + resources UI contract', () => {
  it('renders the unlock test block with 测试全部, per-row retest and 支持/不支持 verdicts', async () => {
    const panel = await read('src/renderer/src/components/NetworkMetadataPanel.vue')
    expect(panel).toMatch(/服务解锁测试/)
    expect(panel).toMatch(/测试全部/)
    expect(panel).toMatch(/useUnlockStore/)
    expect(panel).toMatch(/unlock\.testAll\(\)/)
    expect(panel).toMatch(/重新测试 \$\{row\.name\}/)
    expect(panel).toMatch(/statusLabel\(row\.status\)/)
    // Verdicts: 支持 (green) / 不支持 + 测试失败 (danger) / 待检测 (muted).
    expect(panel).toMatch(/supported: '支持'/)
    expect(panel).toMatch(/unsupported: '不支持'/)
    expect(panel).toMatch(/error: '测试失败'/)
    // Region badge renders when the service returns one.
    expect(panel).toMatch(/unlock-region/)
  })

  it('exposes the unlock IPC surface end to end (shared map → preload → DesktopApi)', async () => {
    const [shared, preload] = await Promise.all([
      read('src/shared/ipc.ts'),
      read('src/preload/index.ts')
    ])
    expect(shared).toMatch(/unlockTestAll: 'network:unlock-test-all'/)
    expect(shared).toMatch(/unlockTestOne: 'network:unlock-test-one'/)
    expect(shared).toMatch(/testAll\(\): Promise<ServiceUnlockResult\[\]>/)
    expect(shared).toMatch(/testOne\(name: string\): Promise<ServiceUnlockResult>/)
    expect(preload).toMatch(/unlock: \{/)
    expect(preload).toMatch(/testAll: \(\) => invoke\(IPC\.unlockTestAll\)/)
    expect(preload).toMatch(/testOne: \(name\) => invoke\(IPC\.unlockTestOne, name\)/)
  })

  it('renames Provider sections to 集合 with per-section 更新全部 and per-row 配置查看', async () => {
    const view = await read('src/renderer/src/views/ResourcesView.vue')
    expect(view).toMatch(/集中查看代理集合、规则集合与地理数据库/)
    expect(view).toMatch(/代理集合/)
    expect(view).toMatch(/规则集合/)
    expect(view).not.toMatch(/代理 Provider|规则 Provider/)
    expect(view).toMatch(/refreshAllProxyProviders/)
    expect(view).toMatch(/refreshAllRuleProviders/)
    expect(view).toMatch(/查看代理集合配置/)
    expect(view).toMatch(/查看规则集合配置/)
    expect(view).toMatch(/DetailDrawer/)
    expect(view).toMatch(/集合配置/)
    // Drawer merges profile-declared fields with live controller metadata.
    expect(view).toMatch(/远程地址/)
    expect(view).toMatch(/自动更新间隔/)
    expect(view).toMatch(/providers\.loadProviderCatalog\(\)/)
  })

  it('wires the provider catalog IPC through preload and the store', async () => {
    const [shared, preload, store] = await Promise.all([
      read('src/shared/ipc.ts'),
      read('src/preload/index.ts'),
      read('src/renderer/src/stores/providers.ts')
    ])
    expect(shared).toMatch(/profilesGetActiveProviderCatalog: 'profiles:get-active-provider-catalog'/)
    expect(shared).toMatch(/getActiveProviderCatalog\(\): Promise<ProfileProviderCatalog>/)
    expect(preload).toMatch(/getActiveProviderCatalog: \(\) => invoke\(IPC\.profilesGetActiveProviderCatalog\)/)
    expect(store).toMatch(/loadProviderCatalog/)
    expect(store).toMatch(/providerCatalog = ref<ProfileProviderCatalog>/)
    // 批量更新保持串行（防 503）: shared batch helper used by all entry points.
    expect(store).toMatch(/refreshProxyProvidersBatch/)
    expect(store).toMatch(/refreshRuleProvidersBatch/)
  })
})
