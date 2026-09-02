# 阶段 3 — Activity，实现 vs. 规范参考

下面两张截图均为 **934 × 672** 内容视口截图（Electron `useContentSize`）；
`docs/ui-reference/murge-ui-preview.html` 是经所有者批准的规范参考。

> 截图通过 `electron-vite` 生产构建（`out/renderer/index.html`）以无头方式（Xvfb :99）生成，
> 并注入 `window.desktop` 提供模拟形态的实时数据，以便 Activity 视图在参考画布尺寸下运作其实时流。
> 测试框架位于仓库之外（`/tmp/murge-shots/`），并且**不**属于随附应用的一部分。随附应用在开发模式下
> 接入进程内 mock 服务器（`src/main/testing/mock-mihomo-server.ts`）；在生产模式下它会与真实控制器通信。

打开 `activity-comparison.html` 以并排查看两张截图。

| Capture | File |
| --- | --- |
| Implementation | `activity-impl-934x672.png` |
| Normative reference | `activity-ref-934x672.png` |

## 数据源已变更（fixture → 实时 mock 流）

| Element | Before (fixture) | Now (live/mock) |
| --- | --- | --- |
| 活动连接 total | fixed 120 | live snapshot count (5 from mock) |
| 总计 (down+up) | fixed "2.3 MB" style | live `totalDownload` via `formatBytesParts` ("8.1 MB") |
| 速率 | fixed numbers | live `traffic.current.up/down` via `formatRate`, framed 1/s |
| 排名 (top processes) | hard-coded rows | aggregated from `connections` snapshot (5 rows: Browser … Desktop) |
| DIRECT / proxy | fixed split | computed from snapshot `chains` (DIRECT vs proxy) |
| 延迟 | static "6ms" | static "6ms" (no live latency endpoint in scope) |

排名行的**计数与宽度**现在来自 mock 聚合；参考使用的是代表性
fixture，因此数字/总数不同，但布局密度保持一致（列表仍填充相同的
行数，下载量现已紧凑格式化）。

## 在参考几何尺寸内新增（无尺寸/位置变更）

在不移动固定网格的前提下新增了健壮流状态：

- `traffic/connections` 存储暴露 `loading | live | disconnected | error`；Activity 视图仅在非 live 状态下显示
  一个小圆点 + 标签（`.stream-state`）。在健康 live 状态下（如截图所示）
  **不会**绘制指示器，因此几何尺寸与参考完全一致。已通过捕获探针确认：
  处于 live 时 `streamState: null`。
- 在断开/出错时，圆点通过作用域类（`.online-dot.pending` / `.online-dot.offline`）变为琥珀色/红色；
  标签为“载入中 / 已断开 / 数据异常”。
- 当 `systemProxyEnabled` / `tunEnabled` 为 false 时，头部胶囊变暗（`pill-dim`）。

## 有待所有者批准的刻意偏差

1. **健壮流状态指示器**（圆点 + 标签）是参考不绘制的新增配饰。
   它们仅在非 live 状态下渲染，因此参考状态（健康）的像素几何尺寸不变。
2. **实时总数与排名密度** —— 用 mock 派生值替换了 fixture 值；大小、计数以及
   DIRECT/proxy 拆分随数据变化，而非由几何尺寸决定。

## 验证

- `npm run build`（brand:check + typecheck + electron-vite build）→ 退出码 0。
- `vitest` → 121 通过（包含 `tests/mihomo-service.test.ts`、`tests/stores.test.ts`，分别覆盖实时
  转发与流错误映射）。
- 捕获已验证（处于 live 时的 DOM 探针）：路由 `#/activity`、`.dashboard-grid` 存在、2 个 `.speed-card`
  迷你图含真实 `d` 路径（10 点序列）、5 个 `.rank-row`、活动连接 = 5、总计 = 8.1 MB。

## 视觉复核刷新 — 2026-08-28

在参考尺寸对齐通过后，实现 PNG 从真实 Electron 窗口重新截取。
它已对照规范 PNG 和已安装的 Surge Activity 页面进行视觉检查。该截图精确为
934×672，所有仪表盘卡片均停留在首屏，且没有可见滚动条。由于实现使用的是
实时 mock 数据，运行时的数值与图形路径会刻意有所不同。
