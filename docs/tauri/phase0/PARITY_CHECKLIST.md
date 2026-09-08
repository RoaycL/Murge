# Phase 0 — 对等验收清单（基线）

> 迁移计划 Phase 0 交付物：*"Add a parity checklist for all tray commands,
> settings pages, headless commands, deep links, updater states, and shutdown
> paths."*
>
> 用法：Phase 2–6 每个阶段把本清单当作验收矩阵——Tauri 侧实现一项勾一项，
> 差异必须显式记录而不是默默接受。**不因实现方便而删行**；确实要删除的行为
> 需要产品决策（迁移计划「Instructions for implementation agents」第 3 条）。

## 1. 托盘命令（`src/main/tray/tray-controller.ts` + `electron-tray.ts`）

托盘图标状态：idle / 系统代理 / TUN 三态强调色 × 明暗两套主题
（`runtime-icon.ts` + `resolveRuntimeAccent`，`tests/runtime-accent.test.ts`）。

| # | 命令 | 当前行为要点 | Tauri 对等 |
|---|---|---|---|
| T1 | 显示主窗口 | 恢复/显示/聚焦既有窗口，必要时重建 | ☐ |
| T2 | 网络质量（禁用项） | 显示当前 INTERNET 延迟 ms 或 — | ☐ |
| T3 | 系统代理（checkbox） | 勾选态 = `phase==='enabled'`；点击 enable/disable；经模式队列；失败回滚勾选态 | ☐ |
| T4 | TUN 模式（checkbox） | 勾选态 = `phase==='active'`；点击 enable/emergencyDisable；提权流程 | ☐ |
| T5 | 复制终端代理命令 | 剪贴板写入含真实 mixed port 的代理环境变量命令 | ☐ |
| T6 | 检查更新 | 触发 `updates.check()`，失败仅告警 | ☐ |
| T7 | 退出 | 走完整 quit flow（见 §6），不绕过恢复顺序 | ☐ |
| T8 | 出站模式子菜单 | 规则/全局/直连 三选一，patchConfig({mode})，当前项标记 | ☐ |
| T9 | 策略组子菜单 | 每个活动配置的代理组一个子菜单，成员节点选择；组名 · 当前选中 动态标签 | ☐ |
| T10 | 策略组图标 | 组图标来自共享 RemoteIconCache（与 renderer 同缓存），刷新语义一致 | ☐ |
| T11 | 进程与客户端 | 显示活动连接数；子菜单列出连接 · 流量 | ☐ |
| T12 | 配置子菜单 | 活动配置列表（点击激活）；重新载入当前配置（热重载）；启动/重启内核；更新当前/全部订阅 | ☐ |
| T13 | 打开目录子菜单 | 应用目录/工作目录/内核目录/日志目录（后三个先 mkdir -p；openPath 失败抛错） | ☐ |
| T14 | 托盘图标运行时强调色 | idle/代理/TUN 三态 × 明暗主题即时切换（nativeTheme.updated + 状态事件） | ☐ |
| T15 | 窗口隐藏时保持最新 | 托盘状态/菜单在窗口隐藏时仍随状态事件刷新（不依赖 renderer 存活） | ☐ |
| T16 | 托盘初始化不阻塞启动 | `trayReady` 与恢复工作并行；失败仅记录 | ☐ |
| T17 | 单击/双击行为 | 与当前 electron-tray 事件绑定一致（对照 `electron-tray.ts` 实测） | ☐ |

## 2. 设置页面（renderer 视图 ↔ store ↔ 后端服务）

| # | 视图 | 后端契约（`window.desktop` 命名空间） | Tauri 对等 |
|---|---|---|---|
| S1 | OverviewView（活动仪表盘） | runtime.getSummary/getExternalIp、mihomo.internetLatency、kernel.get* | ☐ |
| S2 | ActivityView | mihomo.onTraffic/getConnections + traffic/connections stores | ☐ |
| S3 | PolicyView | mihomo.getProxies/selectProxy/delayTest/group* + profiles.getActiveGroupOrder | ☐ |
| S4 | RulesView | mihomo.getRules | ☐ |
| S5 | ConnectionsView | mihomo.getConnections/closeConnection + onConnections | ☐ |
| S6 | LogsView | mihomo.logsSnapshot/clearLogs/onLogs（页面关闭仍采集） | ☐ |
| S7 | ProfilesView（ConfigView 配置组） | profiles.*（导入/URL 导入/激活/删除/重命名/编辑/替换/源 URL/校验/更新） | ☐ |
| S8 | SubStoreView | subStore.* + appSettings.subStore* | ☐ |
| S9 | OverridesView | overrides.* | ☐ |
| S10 | DnsView / DnsSnifferView | dns.get/set/preview、sniffer.get/set/preview（热 patch 不重启内核） | ☐ |
| S11 | NetworkSettingsView（系统代理/绕过） | systemProxy.* + proxy-bypass 策略 + runtime | ☐ |
| S12 | KernelSettingsView（内核管理） | kernelManager.*（通道/版本选择/安装/启用） | ☐ |
| S13 | CoreSettingsView（GeneralView 内核心设置） | core.get/set/preview | ☐ |
| S14 | ProviderSettingsView | providers store + mihomo provider 刷新/健康检查 + profiles.getProviderContent | ☐ |
| S15 | ResourcesView（geodata 等） | geodata.* | ☐ |
| S16 | TUN 设置（NetworkSettingsView 内） | tun.get/enable/disable + tunConfig.get/set/preview | ☐ |
| S17 | AppearanceView | appSettings（主题/强调色/accent）+ appearance store | ☐ |
| S18 | GeneralView（通用偏好） | appSettings.get/set（closeToTray、silentLaunch、autoCheckUpdate、proxyGuard、delayTestUrl* 等） + startup.get/set（开机启动） | ☐ |
| S19 | AboutView（关于/更新） | updates.*（check/download/install + onState）、app.getBrand/getInfo | ☐ |
| S20 | ProcessListView / DeviceListView | mihomo.connections（进程图标 app.getProcessIcon、网络接口列表） | ☐ |
| S21 | MoreView（解锁测试/网络元数据） | unlock.testAll/testOne、networkMetadata.*、app.getCachedIcon | ☐ |
| S22 | usageHistory（用量统计入口） | usageHistory.getWindow/rank/clear/getCapacity | ☐ |

（渲染层 store 全集：`src/renderer/src/stores/` 29 个 —— 迁移后这些 store 不应
感知宿主是 Electron 还是 Tauri。）

## 3. Headless 命令（`--` 参数与 CI 探针；`src/main/index.ts`）

| # | 命令/标志 | 行为 | 门控 | Tauri 对等 |
|---|---|---|---|---|
| H1 | `--packaging-smoke` | 写 profile 根哨兵文件 → 证据行 JSON → exit 0；不建窗口/内核/socket | 任意打包构建 | ☐ |
| H2 | `--restore-system-proxy` | 无头恢复已拥有系统代理（读稳定命名空间备份）；冲突=外部编辑→exit 0，损坏→exit 1；30 s 看门狗 | NSIS 卸载器 + CI | ☐ |
| H3 | `--kernel-smoke` | 打包内核完整生命周期（验证归档→解压→spawn→`/version`→停止） | 非开发构建 | ☐ |
| H4 | `--system-proxy-enable` | 启动内核 → 证明 mixed port（TCP/HTTP/SOCKS）→ 无头启用 HKCU 代理 → 停内核 → exit | `MURGE_CI_SYSTEM_PROXY_ENABLE=1` **且** `GITHUB_ACTIONS=true` 双门控 | ☐ |
| H5 | `--hidden-smoke` | 隐藏窗口 + 原生托盘 + 内核停止断言（登录启动形态） | 非开发 + `GITHUB_ACTIONS` + `MURGE_CI_HIDDEN_START=1` | ☐ |
| H6 | `--ui-smoke` | `did-finish-load` 后在页面内执行 `window.desktop.app.getBrand()` + mihomo 桥探针 → exit 0/1 | CI GUI smoke | ☐ |
| H7 | `--hidden` | 静默启动（登录项形态；窗口不显示，但运行时意图照常恢复） | 启动服务 | ☐ |
| H8 | `--no-kernel-autostart` | 抑制启动时运行时意图重放 | 仅 `GITHUB_ACTIONS=true` 生效 | ☐ |
| H9 | `MURGE_CI_BOOT_FLAGS` / `MURGE_CI_BOOT_DIAG*` | CI 启动参数透传与 argv 诊断转储 | CI only | ☐ |
| H10 | 打包 smoke 看门狗 | `--packaging-smoke` 60 s 加载看门狗强制 exit 1 | CI only | ☐ |

## 4. 深链（`murge://`，`brand.protocolScheme`）

| # | 行为 | 当前实现 | Tauri 对等 |
|---|---|---|---|
| D1 | 协议注册 | Windows 运行时 `app.setAsDefaultProtocolClient`（HKCU，免提权；NSIS 不写注册表） | ☐ |
| D2 | 单实例所有权 | `requestSingleInstanceLock`；无锁直接 quit | ☐ |
| D3 | 启动 argv 深链 | 启动参数里的 `murge://…` 入队 `pendingDeepLinks` | ☐ |
| D4 | 第二实例转发 | `second-instance` 事件提取 argv 深链 → 入队 → 恢复/显示/聚焦主窗口 | ☐ |
| D5 | 不丢链接 | 窗口未就绪/不存在时链接排队，renderer 起来后投递（Phase 7 前不定义 UI 反应，但投递管道不丢） | ☐ |

## 5. 更新器状态机（`src/shared/updates.ts` + `UpdateService`）

状态集：`UpdatePhase`（idle → checking → available/downloading(progress) → ready/canInstall → error；语义见 `UpdateState` 归一化：坏载荷不得破坏 UI 状态机）。

| # | 行为 | 当前实现 | Tauri 对等 |
|---|---|---|---|
| U1 | 手动检查永远可用 | 托盘 T6 / About 页 check() | ☐ |
| U2 | 启动自动检查 | 受 `autoCheckUpdate` 设置；失败只告警不阻塞启动 | ☐ |
| U3 | 会话中轮询 | 10 min；捡拾会话期间发布的新版本 | ☐ |
| U4 | 后台下载 + 进度事件 | `updates:state-event` 推送（progress） | ☐ |
| U5 | 安装 = 退出时替换 | `canInstall` 后 install()/退出安装 | ☐ |
| U6 | 通知点击导航 | 系统通知 → `showMainWindowAt('/about')` → `app:navigate-event` | ☐ |
| U7 | 代理感知 | 走系统代理（Electron net 栈语义） | ☐ |
| U8 | 本地代理环境 | 配置的本地代理、有界超时 | ☐ |
| U9 | Tauri 更新签名 | —（新增：Tauri updater 签名密钥管理与轮换，Phase 5 前置） | ☐ |
| U10 | Electron→Tauri 升级桥 | —（新增：最后一份 Electron 版本向首个 Tauri 版本的显式迁移路径；`latest.yml` 与 Tauri 元数据不可互换） | ☐ |

## 6. 关停路径（`quit-guard.ts` + `beginApplicationShutdown`）

顺序不变量：**恢复已拥有系统代理必须先于内核停止**（注册表绝不指向将死的端口）；
恢复失败 → 不停内核、不退出（除 session-end 外），显示窗口让用户处理。

| # | 路径 | 行为 | Tauri 对等 |
|---|---|---|---|
| Q1 | 托盘「退出」/before-quit | `before-quit` 拦截 → `beginApplicationShutdown(false)` | ☐ |
| Q2 | close 按钮 | `closeToTray` 开 → 隐藏；关 → 同一恢复-关停流 | ☐ |
| Q3 | session-end（注销/关机/重启） | 窗口 `session-end` → `beginApplicationShutdown(true)`；完成后 `app.exit(0)` 防重入 | ☐ |
| Q4 | `powerMonitor shutdown` | 应用级关停事件 → 同一 promise（幂等） | ☐ |
| Q5 | 恢复失败（非 session-end） | 显示窗口、复位 isQuitting、不退出；renderer 收 restore-failed 状态 | ☐ |
| Q6 | 恢复失败（session-end） | flush 日志、保留备份/TUN 审计 → `app.exit(0)`；下次启动 init() 恢复 | ☐ |
| Q7 | 恢复重试 | 3 次 × 250 ms 退避 | ☐ |
| Q8 | 关停清理序 | 等待配置操作排空 → **代理恢复先行**（模式队列内，成功即确认；TUN `emergencyDisable` 随后）→ 停内核（模式队列内）→ dispose（托盘/IPC/更新器/用量/守护定时器/网络探测/意图恢复/Sub-Store/mihomo 流/mock server）→ 日志 | ☐ |
| Q9 | 启动期孤儿恢复 | `systemProxyService.init()`：启动即恢复孤儿备份（不门控窗口）；特权内核 reconcile；TUN 事务 reconcile；然后按 `systemProxyDesired`/`tunDesired` 重放意图 | ☐ |
| Q10 | 崩溃/强杀 | 看门狗（内核 job-object）+下次启动恢复链（Q9） | ☐ |
| Q11 | NSIS 卸载 | H2 无头恢复 → 卸载 Go 服务 → 注册表快照证明 | ☐ |
| Q12 | 更新器退出 | 更新安装退出路径同样经过恢复顺序 | ☐ |

## 7. 启动顺序（创建窗口前后的义务顺序，Phase 2 的启动桥必须保序）

1. 模块级：CI 标志解析 → 日志目录/文件日志 → 存储预热（迁移 → 工作区）→ 设置服务预热
2. `whenReady`：品牌校验 → setName/AppUserModelId/协议注册 → profileRoot → ProfileService → 各设置/增强服务 → 内核（特权 or 普通监督器）→ 控制器网关 → CI 探针分支（H1/H2/H3/H4）→ SystemProxyService(init) → 有序内核网关 → 代理守护 → TUN 协调器 → 模式队列 → 特权活性监视 → 网络探测器 → profile 网关（热重载）→ 更新服务 → 用量服务 → Sub-Store → 注册 IPC → **createWindow** → 托盘 → 外观联动 → 运行时意图恢复 → 网络探测启动 → 自动更新检查
3. 失败面：初始化任何未捕获异常 → 错误对话框（打包时无控制台）→ exit 1

> 本清单核对基准：tauri 分支 `6dbc1b6`（2025-09-08）。
> 每个迁移 PR 结束时按列勾选并在 `TAURI_MIGRATION_PLAN.md` 进度表引用证据。
