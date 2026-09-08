import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

describe('Activity fluid-layout UI contract', () => {
  it('starts traffic and connection statistics at app mount instead of page mount', async () => {
    const [app, activity, connections, processes, devices] = await Promise.all([
      read('src/renderer/src/App.vue'),
      read('src/renderer/src/views/ActivityView.vue'),
      read('src/renderer/src/views/ConnectionsView.vue'),
      read('src/renderer/src/views/ProcessListView.vue'),
      read('src/renderer/src/views/DeviceListView.vue')
    ])

    expect(app).toContain('traffic.connect()')
    expect(app).toContain('connections.connect()')
    for (const source of [activity, connections, processes, devices]) {
      expect(source).not.toContain('store.disconnect')
      expect(source).not.toContain('connections.disconnect()')
      expect(source).not.toContain('traffic.disconnect()')
    }
  })

  it('opens on the 934x672 reference viewport while allowing a smaller fluid minimum', async () => {
    const [main, tokens, css] = await Promise.all([
      read('src/main/index.ts'),
      read('src/renderer/src/styles/tokens.css'),
      read('src/renderer/src/styles/base.css')
    ])

    expect(main).toMatch(/width:\s*934,\s*\n\s*height:\s*672,\s*\n\s*useContentSize:\s*true/)
    // 最小窗口锁在 280px 列宽；Surge 横卡比例修正后 640px 高即可完整展示。
    expect(main).toMatch(/minWidth:\s*848,\s*\n\s*minHeight:\s*640,/)
    expect(main).toMatch(/titleBarStyle:\s*'hidden'/)
    expect(main).toMatch(/titleBarOverlay:\s*\{[^}]*height:\s*34/s)
    expect(tokens).toMatch(/--sidebar-width:\s*205px/)
    expect(css).toMatch(/\.app-window\s*\{[^}]*height:\s*100%;\s*overflow:\s*hidden;/)
    expect(css).not.toMatch(/\.app-window\s*\{[^}]*padding:/)
    // 完全流式仪表盘：弹性列 + 居中内容壳，禁止回到写死列宽。
    expect(css).toMatch(/\.dashboard-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(css).toMatch(/\.dashboard-grid\s*\{[^}]*width:\s*100%/)
    expect(css).toMatch(/\.dashboard-grid\s*\{[^}]*margin:\s*6px auto 0/)
    // Surge 实图：左列横卡约 2.1:1；上传/下载和跨两行流量卡约 1:1。
    expect(css).toMatch(/\.latency-card\s*\{[^}]*aspect-ratio:\s*2\.1 \/ 1/)
    expect(css).toMatch(/\.connections-card\s*\{[^}]*aspect-ratio:\s*2\.1 \/ 1/)
    expect(css).toMatch(/\.total-card\s*\{[^}]*aspect-ratio:\s*2\.1 \/ 1/)
    expect(css).toMatch(/\.speed-card\s*\{[^}]*aspect-ratio:\s*1 \/ 1/)
    expect(css).toMatch(/\.traffic-card\s*\{[^}]*aspect-ratio:\s*1 \/ 1/)
    // 卡片到达最小尺寸后网格不再压缩（与 848px 最小窗口互为兜底）。
    expect(css).toMatch(/\.dashboard-grid\s*\{[^}]*min-width:\s*calc\(2 \* var\(--card-min\) \+ 15px\)/)
    expect(css).toMatch(/\.activity-view\.page-shell\s*\{[^}]*min-width:\s*calc\(2 \* var\(--card-min\) \+ 15px\)/)
    expect(css).toMatch(/\.activity-view\.page-shell\s*\{[^}]*max-width:\s*none/)
    expect(css).toMatch(/\.activity-view\.page-shell\s*\{[^}]*padding-left:\s*5px/)
    expect(css).toMatch(/\.activity-view\.page-shell\s*\{[^}]*padding-right:\s*35px/)
    expect(css).toMatch(/\.page-shell\s*\{[^}]*max-width:\s*var\(--content-max-width\)/)
    expect(css).toMatch(/\.page-shell\s*\{[^}]*margin:\s*0 auto/)
    // 所有者要求：任何宽度下都保持规范的双列仪表盘，不做单列降级。
    expect(css).not.toMatch(/\.dashboard-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  })

  it('anchors horizontal-card details to the bottom and compacts them by card width', async () => {
    const css = await read('src/renderer/src/styles/base.css')

    expect(css).toMatch(/\.latency-card\s*\{[^}]*container-type:\s*inline-size[^}]*display:\s*flex[^}]*flex-direction:\s*column/)
    expect(css).toMatch(/\.connections-card\s*\{[^}]*container-type:\s*inline-size[^}]*display:\s*flex[^}]*flex-direction:\s*column/)
    expect(css).toMatch(/\.total-card\s*\{[^}]*container-type:\s*inline-size[^}]*display:\s*flex[^}]*flex-direction:\s*column/)
    expect(css).toMatch(/\.latency-breakdown\s*\{[^}]*margin-top:\s*auto/)
    expect(css).toMatch(/\.topology-inline\s*\{[^}]*margin-top:\s*auto/)
    expect(css).toMatch(/\.total-labels\s*\{[^}]*margin-top:\s*auto/)
    expect(css).toMatch(/@container\s*\(max-width:\s*320px\)/)
  })

  it('renders both speed metrics through the same card surface as the other Activity cards', async () => {
    const [component, css, tokens] = await Promise.all([
      read('src/renderer/src/components/SpeedSparkline.vue'),
      read('src/renderer/src/styles/base.css'),
      read('src/renderer/src/styles/tokens.css')
    ])

    expect(component).toContain("import SurfaceCard from './SurfaceCard.vue'")
    expect(component).toContain('<SurfaceCard class="speed-card">')
    expect(component).toContain('trafficChartScale(props.series)')
    expect(component).not.toContain('ceiling: string')
    expect(component).not.toContain('middle: string')
    expect(css).toMatch(/\.surface-card\s*\{[^}]*border:\s*1px solid var\(--app-surface-border\)/)
    expect(tokens).toContain('--app-surface-border: rgba(255, 255, 255, 0.05);')
  })

  it('uses native process icons and concrete policy-group icons in the ranking', async () => {
    const [activity, store] = await Promise.all([
      read('src/renderer/src/views/ActivityView.vue'),
      read('src/renderer/src/stores/connections.ts')
    ])

    expect(activity).toContain("import ProcessIcon from '../components/ProcessIcon.vue'")
    expect(activity).toContain("import CachedRemoteIcon from '../components/CachedRemoteIcon.vue'")
    expect(activity).toContain(':path="item.iconPath"')
    expect(store).toContain('connectionChainHops(c.chains)[0]')
  })

  it('keeps runtime facts aligned while presenting outbound mode as text until clicked', async () => {
    const [activity, select, css] = await Promise.all([
      read('src/renderer/src/views/ActivityView.vue'),
      read('src/renderer/src/components/AppSelect.vue'),
      read('src/renderer/src/styles/base.css')
    ])

    expect(activity).toContain('<div class="runtime-mode-picker"><span>出站模式</span><AppSelect')
    expect(activity).toMatch(/<AppSelect[^>]*\splain\s*\/>/)
    expect(css).toMatch(/\.runtime-context\s*\{[^}]*align-items:\s*start/)
    expect(css).toMatch(/\.runtime-context\s*>\s*div,\s*\.runtime-context\s*>\s*button\s*\{[^}]*flex-direction:\s*column/)
    expect(css).toMatch(/\.runtime-mode-picker \.app-select\s*\{[^}]*margin-top:\s*3px/)
    expect(select).toMatch(/\.app-select\.plain \.app-select-trigger\s*\{[^}]*font-size:\s*16px[^}]*font-weight:\s*650/)
    expect(select).toMatch(/\.app-select\.plain \.trigger-chevron\s*\{[^}]*opacity:\s*0/)
    expect(select).toContain('<Teleport to="body">')
    expect(select).toContain('<div v-if="open" ref="menu" class="app-select-menu"')
    expect(select).toMatch(/\.app-select-menu\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*3000/)
    expect(select).toContain("window.addEventListener('scroll', positionMenu, true)")
  })

  it('keeps drawer actions on one line and omits Activity drawer explanatory copy', async () => {
    const [activity, network, topology, usage, css] = await Promise.all([
      read('src/renderer/src/views/ActivityView.vue'),
      read('src/renderer/src/components/NetworkMetadataPanel.vue'),
      read('src/renderer/src/components/TopologyPanel.vue'),
      read('src/renderer/src/components/UsageHistoryPanel.vue'),
      read('src/renderer/src/styles/base.css')
    ])
    const source = [activity, network, topology, usage].join('\n')

    expect(source).not.toContain('活动页的扩展信息，不改变主仪表盘布局')
    expect(source).not.toContain('仅显示出口节点的公开元数据')
    expect(source).not.toContain('只读视图，源于当前实时连接/策略链')
    expect(source).not.toMatch(/最多保留 .* 个分桶/)
    expect(css).toMatch(/\.detail-drawer-footer\s*\{[^}]*flex-wrap:\s*nowrap/)
    expect(css).toMatch(/\.detail-drawer button\s*\{[^}]*white-space:\s*nowrap/)
  })

  it('refreshes the latency card when opening diagnostics and keeps the drawer focused on network information', async () => {
    const [activity, network] = await Promise.all([
      read('src/renderer/src/views/ActivityView.vue'),
      read('src/renderer/src/components/NetworkMetadataPanel.vue')
    ])

    // “网络诊断”打开抽屉的同一动作会刷新活动页延迟卡片。
    expect(activity).toMatch(/function openNetworkDiagnostics\(\): void \{[\s\S]*summaryDrawer\.value = 'network'[\s\S]*latency\.probe\(\)/)
    expect(activity).toContain('@click="openNetworkDiagnostics"')
    expect(activity).toContain('#actions')
    expect(activity).toContain('latency.probe()')
    // 抽屉不再重复展示延迟诊断区块。
    expect(network).not.toContain("import { useLatencyStore } from '../stores/latency'")
    expect(network).not.toContain('latency.probe()')
    expect(network).not.toContain('window.desktop.mihomo.internetLatency')
    expect(network).not.toContain('网络诊断')
    expect(network).not.toContain('路由网关')
    expect(network).not.toContain('DNS 解析')
    // 出口信息在解锁测试之前；仍保留遮罩 + 手动显示，隐私默认不暴露 IP。
    expect(network.indexOf('出口网络信息')).toBeLessThan(network.indexOf('服务解锁测试'))
    expect(network).toMatch(/@click="toggleReveal"/)
    expect(network).not.toContain('复制信息')
  })

  it('lays kernel versions out as an adaptive multi-column chip grid', async () => {
    const modal = await read('src/renderer/src/components/KernelVersionModal.vue')

    expect(modal).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(220px,\s*100%\),\s*1fr\)\)/)
    expect(modal).not.toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  })
})
