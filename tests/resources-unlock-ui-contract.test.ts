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

  it('spins the refresh icon of the row currently updating, in both views', async () => {
    const [base, resources, rules] = await Promise.all([
      read('src/renderer/src/styles/base.css'),
      read('src/renderer/src/views/ResourcesView.vue'),
      read('src/renderer/src/views/RulesView.vue')
    ])
    // Shared spin animation (参考 clash-verge-rev: 1s linear infinite).
    expect(base).toMatch(/@keyframes icon-spin/)
    expect(base).toMatch(/icon-spin 1s linear infinite/)
    // 外部资源: per-row refresh buttons spin while that row's op is refreshing.
    expect(resources).toMatch(/spinning: providers\.opOf\(item\.name\)\.refreshing/)
    // 规则页: per-row text buttons replaced by icon buttons with the same spin.
    expect(rules).toMatch(/class="icon-control"/)
    expect(rules).toMatch(/spinning: providers\.opOf\(provider\.name\)\.refreshing/)
  })

  it('keeps batch buttons plain text labelled 全部更新 without icons', async () => {
    const [resources, rules] = await Promise.all([
      read('src/renderer/src/views/ResourcesView.vue'),
      read('src/renderer/src/views/RulesView.vue')
    ])
    // 外部资源: 页首 + 两个分区按钮统一为纯文本「全部更新」，不带图标。
    expect(resources).toMatch(/'全部更新' \}/)
    expect(resources).not.toMatch(/refreshingProxy \? '更新中…' : '更新全部'/)
    expect(resources).not.toMatch(/'spin-icon': refreshingProxy/)
    expect(resources).not.toMatch(/'spin-icon': refreshingRule/)
    expect(resources).not.toMatch(/'spin-icon': refreshing /)
    // 规则页: 一键更新 → 全部更新，无图标。
    expect(rules).toMatch(/refreshingAllRules \? '更新中…' : '全部更新'/)
    expect(rules).not.toMatch(/'spin-icon': refreshingAllRules/)
    expect(rules).not.toMatch(/一键更新/)
  })

  it('opens the four secondary-setting drawers from the overview cards', async () => {
    const overview = await read('src/renderer/src/views/OverviewView.vue')
    // 网络管理 (系统代理 + TUN) 与覆写 (嗅探 + DNS) 四张卡片。
    expect(overview).toMatch(/<h2>网络管理<\/h2>/)
    expect(overview).toMatch(/<h2>覆写<\/h2>/)
    expect(overview).toMatch(/<h3>系统代理<\/h3>/)
    expect(overview).toMatch(/<h3>TUN 模式<\/h3>/)
    expect(overview).toMatch(/<h3>嗅探覆写<\/h3>/)
    expect(overview).toMatch(/<h3>DNS 覆写<\/h3>/)
    // 概览不再承载抽屉表单: 整卡点击跳转设置页, 开关 stop 不触发导航。
    expect(overview).not.toMatch(/DetailDrawer/)
    expect(overview).not.toMatch(/ProxyBypassPanel|TunConfigPanel|SnifferSettingsPanel|DnsSettingsPanel/)
    expect(overview).toMatch(/openSettings\('system-proxy'\)/)
    expect(overview).toMatch(/openSettings\('tun'\)/)
    expect(overview).toMatch(/openSettings\('sniffer'\)/)
    expect(overview).toMatch(/openSettings\('dns'\)/)
    expect(overview).toMatch(/@click\.stop="toggleSystemProxy"/)
    expect(overview).toMatch(/setting-arrow/)
    // 运行状态栏已删除。
    expect(overview).not.toMatch(/runtime-summary/)
    // 覆写卡片上的主开关直接持久化 enabled。
    expect(overview).toMatch(/toggleSniffer/)
    expect(overview).toMatch(/toggleDns/)
    expect(overview).toMatch(/\{ \.\.\.sniffer\.enhancement, enabled: !snifferEnabled\.value \}/)
    expect(overview).toMatch(/\{ \.\.\.dns\.enhancement, enabled: !dnsEnabled\.value \}/)
  })

  it('keeps general settings backed by real persisted preferences', async () => {
    const [shared, service, general] = await Promise.all([
      read('src/shared/app-settings.ts'),
      read('src/main/app-settings/service.ts'),
      read('src/renderer/src/views/GeneralView.vue')
    ])
    // 静默启动/关闭到托盘/代理守护都是持久化字段, 不是摆设开关。
    for (const key of ['silentLaunch', 'closeToTray', 'proxyGuard']) {
      expect(shared).toMatch(new RegExp(`${key}: boolean`))
      expect(service).toMatch(new RegExp(`${key}`))
      expect(general).toMatch(new RegExp(`${key}`))
    }
    // 三个行为真正接进主进程: 登录项参数、窗口关闭、守护定时器。
    expect(read('src/main/startup/electron-adapter.ts')).resolves.toMatch(/getSilentLaunch/)
    expect(read('src/main/index.ts')).resolves.toMatch(/cachedAppSettings\.closeToTray/)
    expect(read('src/main/index.ts')).resolves.toMatch(/cachedAppSettings\.proxyGuard/)
  })
})
