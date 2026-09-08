# Phase 0 — IPC 契约清单（基线）

> 迁移计划 Phase 0 交付物：*"Export an inventory mapping every `window.desktop`
> method/event and every IPC channel to its owning service and tests."*
>
> 生成方式：脚本从 `src/shared/ipc.ts`（IPC 键 → 通道名）与 `src/preload/index.ts`
> （`DesktopApi` 命名空间 → 方法签名）交叉提取，并与 `src/main/ipc/handlers.ts` +
> `src/main/ipc/register-ipc.ts` 的注册表逐一核对。Tauri 迁移期间本文件是
> `window.desktop` 兼容桥的行为规格；任何 Phase 3+ 的差异必须在本文件的
> 「Tauri 对等状态」列或迁移 PR 进度表中显式记录。

## 总量核对（2025-09-08，tauri 分支 @ 6dbc1b6）

| 项 | 数量 | 核对结果 |
|---|---|---|
| `IPC` 通道键（`src/shared/ipc.ts`） | 121 | — |
| `window.desktop` 方法+事件（`src/preload/index.ts`） | 121 | 与 IPC 键 **1:1**，无孤儿、无缺失 |
| invoke 通道（renderer → main） | 111 | **全部** 在 `handlers.ts` / `register-ipc.ts` 注册 |
| 主进程 → renderer 事件 | 10 | **全部** 有主进程发送方（9 个经 `register-ipc.ts` 转发，`app:navigate-event` 由 `index.ts` `showMainWindowAt` 发送） |
| 覆盖这些通道的测试文件 | `tests/handlers.test.ts`（全通道契约，fake 容器）+ `tests/ipc-schema.test.ts`（全通道参数校验）+ 各服务专项测试 | 见下表 |

通用约定（迁移时必须保持）：

1. **参数校验两层**：preload 之前 renderer 可信度为零；`handlers.ts` 用
   `@shared/schemas/ipc` 的 zod 解析器对**每个**参数再校验（`tests/ipc-schema.test.ts` 锁定）。
2. **错误协议**：主进程抛出的 `ProtocolError` 经 `encodeProtocolError` 编码进 Error
   message；preload 的 `invoke` 包装用 `decodeProtocolError` 还原（`tests/protocol-errors.test.ts`）。
3. **事件扇出**：9 个状态/流事件通过 `register-ipc.ts` 的 `forward()` 发给**所有**打开的
   BrowserWindow；共享网关的传输层扇出，窗口重建不开新 socket，无监听器跨窗口存活。
4. **Tauri 语义差异**（Phase 2/3 必须桥接）：Electron 事件 = 任意窗口进程内发送；
   Tauri 事件 = 每窗口/全局广播。兼容桥需保证「多窗口不多订阅、窗口销毁监听器即亡」。

## 契约表

列：**实现** = 主进程当前所有者（handlers → gateway → 服务实现链）；
**测试** = 当前仓库中直接覆盖该行为的测试（`tests/` 下，`*.test.ts`）。

### app（6）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `app.getBrand()` | invoke | `app:get-brand` | `brand` 常量（`src/shared/brand.ts`，`parseBrandConfig` 校验） | `brand-wiring` `brand.schema` `brand-sync` |
| `app.getInfo()` | invoke | `app:get-info` | `register-ipc.ts` 内联 `{version, platform, arch}` | `handlers` `preload-build-path` |
| `app.getProcessIcon(path)` | invoke | `app:get-process-icon` | `register-ipc.ts` 内联：`app.getFileIcon`，仅本地盘符 `.exe`、≤1024 字符，LRU 512 上限 | `handlers` |
| `app.getCachedIcon(cacheKey, url, refresh)` | invoke | `app:get-cached-icon` | `RemoteIconCache`（磁盘持久 stale-if-error，双 fetch 通道） | `remote-icon-cache` `handlers` |
| `app.listNetworkInterfaces()` | invoke | `app:list-network-interfaces` | `register-ipc.ts` 内联：`node:os` 过滤（有地址、非空、≤255、无控制字符）+ 排序 | `handlers` |
| `app.onNavigate(listener)` | 事件 ⇐ | `app:navigate-event` | `index.ts` `showMainWindowAt('/about')`（更新通知点击导航） | `update-notification-navigation` |

### kernel（4）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `kernel.getStatus()` | invoke | `kernel:get-status` | `queuedKernelGateway` → `ModeTransitionController` → `SystemProxyOrderedKernelGateway` → `ControllerReadyKernelGateway` → `PrivilegedServiceKernelGateway`\|`KernelSupervisor` | `handlers` `single-kernel-gateway` `mode-transition` `controller-ready-gateway` `kernel-supervisor` `privileged-service-kernel-gateway` |
| `kernel.start()` | invoke | `kernel:start` | 同上（独占 FIFO 模式队列；生产就绪 = 监听 + `/version` + 端口归属校验） | 同上 + `kernel-evidence` `kernel-fixture.integration` |
| `kernel.stop()` | invoke | `kernel:stop` | 同上（先恢复已拥有系统代理再停止，见 `SystemProxyOrderedKernelGateway`） | 同上 + `system-proxy-service` |
| `kernel.onStatus(listener)` | 事件 ⇐ | `kernel:status-event` | `register-ipc.ts` 转发 `kernel.onStatus` 至全部窗口 | `handlers` `mode-transition` |

### kernelManager（6）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `kernelManager.getState()` | invoke | `kernel-manager:get-state` | `KernelManagerService` | `kernel-manager-service` `kernel-settings-ui-contract` |
| `kernelManager.setEnabled(enabled)` | invoke | `kernel-manager:set-enabled` | 同上（Smart 开关；安装后经 `applyInstalledKernelVersion` 有序热切换 + 版本未生效回滚） | 同上 |
| `kernelManager.setChannel(channel)` | invoke | `kernel-manager:set-channel` | 同上（stable/preview/smart/specific 滚动通道语义） | 同上 |
| `kernelManager.listVersions()` | invoke | `kernel-manager:list-versions` | 同上 | 同上 |
| `kernelManager.install(version)` | invoke | `kernel-manager:install` | 同上（特权服务 `installVersion` 验证安装） | 同上 |
| `kernelManager.onState(listener)` | 事件 ⇐ | `kernel-manager:state-event` | `register-ipc.ts` 转发 | `handlers` |

### runtime（2）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `runtime.getSummary()` | invoke | `runtime:get-summary` | `register-ipc.ts` `buildRuntimeSummary`（活动配置名、mode、代理/TUN 真实状态，各段失败降级） | `runtime-summary` |
| `runtime.getExternalIp()` | invoke | `runtime:get-external-ip` | `register-ipc.ts` `resolveExternalIp` → `fetchExternalIpViaProxy`（经内核 mixed port） | `external-ip` |

### mihomo（21 方法 + 4 事件）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `mihomo.getConfig()` | invoke | `mihomo:get-config` | `ProxySelectionGateway` → `MihomoService` → `MihomoClient`（Bearer、超时、百分号编码） | `handlers` `mihomo-service` `mihomo-client` `proxy-selection` |
| `mihomo.patchConfig(patch)` | invoke | `mihomo:patch-config` | 同上（出站模式等白名单 patch） | 同上 |
| `mihomo.getProxies()` | invoke | `mihomo:get-proxies` | 同上 | 同上 |
| `mihomo.internetLatency()` | invoke | `mihomo:internet-latency` | `InternetLatencyService`（网关 RTT + 内核 DNS + 选中节点链路延迟） | `internet-latency-service` `route-latency-service` |
| `mihomo.selectProxy(group, name)` | invoke | `mihomo:select-proxy` | 同上 + `ProxySelectionService`（记忆每次接受的节点选择，内核重载后重放） | `proxy-selection` `handlers` |
| `mihomo.getRules()` | invoke | `mihomo:get-rules` | `ProxySelectionGateway` 链 | `mihomo-service` |
| `mihomo.getProxyProviders()` | invoke | `mihomo:get-proxy-providers` | 同上 | 同上 |
| `mihomo.refreshProxyProvider(name)` | invoke | `mihomo:refresh-proxy-provider` | 同上 | 同上 |
| `mihomo.healthCheckProxyProvider(name)` | invoke | `mihomo:health-check-proxy-provider` | 同上 | 同上 |
| `mihomo.getRuleProviders()` | invoke | `mihomo:get-rule-providers` | 同上 | 同上 |
| `mihomo.refreshRuleProvider(name)` | invoke | `mihomo:refresh-rule-provider` | 同上 | 同上 |
| `mihomo.delayTest(name, opts)` | invoke | `mihomo:delay-test` | 同上（URL 来源受 `delayTestUrlScope` 设置控制） | 同上 |
| `mihomo.groupMemberDelayTest(group, name, opts)` | invoke | `mihomo:group-member-delay-test` | 同上 | 同上 |
| `mihomo.groupDelayTest(name, opts)` | invoke | `mihomo:group-delay-test` | 同上 | 同上 |
| `mihomo.getConnections()` | invoke | `mihomo:get-connections` | 同上 | 同上 |
| `mihomo.closeConnection(id)` | invoke | `mihomo:close-connection` | 同上 | 同上 |
| `mihomo.dnsQuery(name, type)` | invoke | `mihomo:dns-query` | 同上 | 同上 |
| `mihomo.flushDnsCache()` | invoke | `mihomo:flush-dns-cache` | 同上 | 同上 |
| `mihomo.flushFakeIpCache()` | invoke | `mihomo:flush-fakeip-cache` | 同上 | 同上 |
| `mihomo.logsSnapshot(afterSeq)` | invoke | `mihomo:logs-snapshot` | `MihomoService` + 主进程日志环形缓冲（`LogBuffer`，内核日志同时落盘 `FileLogService.writeCore`） | `log-buffer` `logs` `file-log-service` |
| `mihomo.clearLogs()` | invoke | `mihomo:clear-logs` | 同上 | 同上 |
| `mihomo.onTraffic(listener)` | 事件 ⇐ | `mihomo:traffic-event` | `register-ipc.ts` 转发 `mihomo.onTraffic`（WS 流；与页面挂载无关持续采集） | `mihomo-stream` `usage-service` |
| `mihomo.onConnections(listener)` | 事件 ⇐ | `mihomo:connections-event` | 同上 | 同上 |
| `mihomo.onLogs(listener)` | 事件 ⇐ | `mihomo:log-event` | 同上 | 同上 |
| `mihomo.onStreamError(listener)` | 事件 ⇐ | `mihomo:stream-error-event` | 同上（重连退避语义见 `MihomoService`） | `mihomo-stream` |

### profiles（17）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `profiles.getActiveGroupOrder()` | invoke | `profiles:get-active-group-order` | `handlers` 选项 `resolveActiveGroupOrder` = 增强后活动文档（overrides→DNS→sniffer）的组顺序 | `handlers` `profile-kernel-config` |
| `profiles.getActiveProviderCatalog()` | invoke | `profiles:get-active-provider-catalog` | 同上 `resolveActiveProviderCatalog` | `handlers` |
| `profiles.getProviderContent(kind, name)` | invoke | `profiles:get-provider-content` | 特权服务读取 `tunServiceClient.getProviderContent`（renderer 永不直接读路径） | `handlers` `tun-helper-protocol` |
| `profiles.inspectActiveConfig()` | invoke | `profiles:inspect-active-config` | `index.ts` `resolveActiveConfigInspection`（存储文档 vs 生效文档逐项对比，TUN 感知） | `profile-config-inspection` |
| `profiles.list()` | invoke | `profiles:list` | `ProfileAutoReloadGateway` → `ProfileService` → `ProfileRepository` | `profile-service` `profile-repository` |
| `profiles.get(id)` | invoke | `profiles:get` | 同上 | 同上 |
| `profiles.import(request)` | invoke | `profiles:import` | 同上（`SubscriptionFetcher` 严格校验、重定向逐跳复检） | `subscription-fetcher` `subscription-naming` `profile-service` |
| `profiles.importFromUrl(name, url, activate)` | invoke | `profiles:import-from-url` | 同上；生产附加内核代理回退传输（`createSubscriptionProxyFetchFn`）；开发构建禁止真实抓取 | 同上 |
| `profiles.updateFromSource(id)` | invoke | `profiles:update-from-source` | 同上 | 同上 |
| `profiles.activate(id)` | invoke | `profiles:activate` | 同上 + 内核热重载（先控制器 patch，失败回退有内核重启；选择重放） | `profile-auto-reload-gateway` `mode-transition` |
| `profiles.delete(id)` | invoke | `profiles:delete` | 同上（连带删除该配置的记忆节点选择） | `profile-service` `proxy-selection` |
| `profiles.rename(id, name)` | invoke | `profiles:rename` | 同上 | `profile-service` |
| `profiles.editDocument(id, edits)` | invoke | `profiles:edit-document` | 同上（autoActivateOnEdit → 热重载） | `profile-auto-reload-gateway` |
| `profiles.replaceDocument(id, document)` | invoke | `profiles:replace-document` | 同上 | 同上 |
| `profiles.getSourceUrl(id)` | invoke | `profiles:get-source-url` | `EncryptedProfileSourceStore`（safeStorage 加密） | `profile-source-store` |
| `profiles.setSourceUrl(id, url)` | invoke | `profiles:set-source-url` | 同上 | 同上 |
| `profiles.validate(document)` | invoke | `profiles:validate` | `ProfileService.validateDocument`（mihomo 配置校验；特权服务存在时走语义校验器） | `profile-service` `profile-repository` |

### systemProxy（6 + 1 事件）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `systemProxy.getStatus()` | invoke | `system-proxy:get-status` | `SystemProxyService`（状态机 + promise-queue 串行化） | `system-proxy-service` `system-proxy-handlers` |
| `systemProxy.enable()` | invoke | `system-proxy:enable` | `handlers`：**意图先行**（先写 `systemProxyDesired: true`）→ 确保内核运行 → `enable()`（先原子备份后写注册表；活体探针读真实 mixed port） | 同上 + `system-proxy-backup-store` `system-proxy-probe` |
| `systemProxy.disable()` | invoke | `system-proxy:disable` | `handlers`：意图先行（`false`）→ `disable()` | 同上 |
| `systemProxy.onStatus(listener)` | 事件 ⇐ | `system-proxy:status-event` | `register-ipc.ts` 转发 | `system-proxy-service` |
| `systemProxy.getProxyBypass()` | invoke | `system-proxy:get-proxy-bypass` | `SystemProxyService` bypass 策略 | `system-proxy-policy` |
| `systemProxy.setProxyBypass(input)` | invoke | `system-proxy:set-proxy-bypass` | 同上 | 同上 |
| `systemProxy.previewProxyBypass(input)` | invoke | `system-proxy:preview-proxy-bypass` | 同上（纯格式化） | 同上 |

### startup（2）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `startup.getStatus()` | invoke | `startup:get-status` | `StartupService` → `ScheduledTaskStartupAdapter`（计划任务 + Run-key 回退） | `startup-service` `electron-startup-adapter` |
| `startup.setEnabled(enabled)` | invoke | `startup:set-enabled` | 同上 | 同上 |

### unlock（2）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `unlock.testAll()` | invoke | `network:unlock-test-all` | `ServiceUnlockService`（并发全预设服务；经内核 LIVE mixed port，内核停止则 fail-closed） | `unlock-store` `handlers` |
| `unlock.testOne(name)` | invoke | `network:unlock-test-one` | 同上（单服务行级刷新） | 同上 |

### appSettings（2）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `appSettings.get()` | invoke | `app-settings:get` | `AppSettingsService`（原子 JSON 持久化） | `app-settings-service` `handlers` |
| `appSettings.set(patch)` | invoke | `app-settings:set` | 同上（zod patch 校验；silentLaunch 变化触发登录项参数刷新；subStore 设置热应用） | 同上 |

### subStore（5）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `subStore.getState()` | invoke | `substore:get-state` | `SubStoreService`（完整持久快照：enabled/useProxy 镜像） | `substore-service` |
| `subStore.ensureRunning()` | invoke | `substore:ensure-running` | 同上（验证过的资产、受控生命周期、代理环境） | `substore-service` `substore-zip` |
| `subStore.stop()` | invoke | `substore:stop` | 同上 | 同上 |
| `subStore.checkUpdate()` | invoke | `substore:check-update` | 同上 | 同上 |
| `subStore.openExternal(url)` | invoke | `substore:open-external` | 同上（URL 协议 allowlist 校验） | `substore-service` |

### overrides（10）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `overrides.list()` | invoke | `overrides:list` | `OverrideService`（快照含运行时效果） | `override-service` `override-preview` `apply-overrides` |
| `overrides.create(input)` | invoke | `overrides:create` | 同上 | 同上 |
| `overrides.update(id, input)` | invoke | `overrides:update` | 同上 | 同上 |
| `overrides.remove(id)` | invoke | `overrides:remove` | 同上 | 同上 |
| `overrides.setEnabled(id, enabled)` | invoke | `overrides:set-enabled` | 同上 | 同上 |
| `overrides.move(id, direction)` | invoke | `overrides:move` | 同上 | 同上 |
| `overrides.preview()` | invoke | `overrides:preview` | 同上（对活动配置预览） | 同上 |
| `overrides.validate()` | invoke | `overrides:validate` | 同上 | 同上 |
| `overrides.lastKnownGood()` | invoke | `overrides:last-known-good` | 同上 | 同上 |
| `overrides.resetToLastGood()` | invoke | `overrides:reset-to-last-good` | 同上 | 同上 |

### dns / sniffer（各 3）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `dns.get()` | invoke | `dns:get` | `LiveDnsEnhancementGateway` → `DnsEnhancementService` | `dns-enhancement-service` `dns-enhancement-store` `dns-model` |
| `dns.set(input)` | invoke | `dns:set` | 同上 + `EnhancementApplyCoordinator`（运行中经控制器热 patch `dns` 段，**不重启内核**） | `enhancement-live-gateway` `apply-dns` |
| `dns.preview(input)` | invoke | `dns:preview` | 同上（YAML 文档预览） | `apply-dns` |
| `sniffer.get()` | invoke | `sniffer:get` | `LiveSnifferEnhancementGateway` → `SnifferEnhancementService` | `apply-sniffer` `enhancement-live-gateway` |
| `sniffer.set(input)` | invoke | `sniffer:set` | 同上（热 patch `sniffer` 段） | 同上 |
| `sniffer.preview(input)` | invoke | `sniffer:preview` | 同上 | 同上 |

### updates（4 + 1 事件）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `updates.getState()` | invoke | `updates:get-state` | `UpdateService` → `ElectronUpdaterDriver`（Tauri 侧换 `TauriUpdaterDriver`，状态机不变） | `update-service` |
| `updates.check()` | invoke | `updates:check` | 同上（手动检查总可用；自动检查受 `autoCheckUpdate` 设置门控） | 同上 |
| `updates.download()` | invoke | `updates:download` | 同上（后台下载，进度事件） | 同上 |
| `updates.install()` | invoke | `updates:install` | 同上（下载完成后退出安装） | 同上 |
| `updates.onState(listener)` | 事件 ⇐ | `updates:state-event` | `register-ipc.ts` 转发 | `update-service` |

### tun（3 + 1 事件）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `tun.getStatus()` | invoke | `tun:get-status` | `queuedTunGateway` → `ModeTransitionController` → `TunCoordinator`（configured/starting/active/failed 状态机；事务恢复） | `tun-coordinator` `tun-contracts` `tun-handlers` |
| `tun.enable()` | invoke | `tun:enable` | `handlers`：意图先行（`tunDesired: true`）→ 排队启用（原地热切换：普通内核先停、提权子进程接管统一端口，成功不触碰已拥有代理） | 同上 + `mode-transition` `hot-switch-tun-adapter` |
| `tun.disable()` | invoke | `tun:disable` | `handlers`：意图先行（`false`）→ `emergencyDisable()` | 同上 |
| `tun.onStatus(listener)` | 事件 ⇐ | `tun:status-event` | `register-ipc.ts` 转发 | `tun-coordinator` |

### tunConfig / core / geodata（各 3）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `tunConfig.get()` | invoke | `tun-config:get` | `TunConfigService`（持久化 + 快照） | `tun-config-service` `tun-config-model` `tun-config-schema` |
| `tunConfig.set(input)` | invoke | `tun-config:set` | 同上（运行中变更走 `runEnhancementUpdate` → 控制器热 patch/内核重载） | 同上 |
| `tunConfig.preview(input)` | invoke | `tun-config:preview` | 同上（`generateProxiedTunConfig` 文档预览） | `mihomo-tun-config` |
| `core.get()` | invoke | `core-settings:get` | `CoreSettingsService`（监听端口/控制器/secret 等受控核心键） | `core-settings-service` `core-settings-model` `core-settings-schema` |
| `core.set(input)` | invoke | `core-settings:set` | 同上（变更需内核重载生效） | 同上 + `core-settings-config.integration` |
| `core.preview(input)` | invoke | `core-settings:preview` | 同上 | 同上 |
| `geodata.get()` | invoke | `geodata-settings:get` | `LiveGeodataSettingsGateway` → `GeodataSettingsService` | `geodata-settings-service` `geodata-settings-model` `geodata-settings-schema` |
| `geodata.set(input)` | invoke | `geodata-settings:set` | 同上（热 patch `geodata` 段） | 同上 + `enhancement-live-gateway` |
| `geodata.preview(input)` | invoke | `geodata-settings:preview` | 同上 | 同上 |

### usageHistory（4）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `usageHistory.getWindow(window)` | invoke | `usage-history:get-window` | `UsageHistoryService`（打包用 `FileSystemUsageHistoryStore`，dev 内存版；后台随 WS 流持续持久化，与页面挂载无关） | `usage-service` `usage-store` `usage-model` |
| `usageHistory.rank(window, ranking, limit)` | invoke | `usage-history:rank` | 同上 | 同上 |
| `usageHistory.clear()` | invoke | `usage-history:clear` | 同上 | 同上 |
| `usageHistory.getCapacity()` | invoke | `usage-history:get-capacity` | 同上 | `usage-schema` |

### networkMetadata（5）

| 契约 | 类型 | 通道 | 实现 | 测试 |
|---|---|---|---|---|
| `networkMetadata.getProviders()` | invoke | `network-metadata:get-providers` | `NetworkMetadataService`（经代理 fetch JSON 元数据） | `network-metadata-service` `network-metadata-model` |
| `networkMetadata.getState()` | invoke | `network-metadata:get-state` | 同上 | 同上 |
| `networkMetadata.selectProvider(id)` | invoke | `network-metadata:select-provider` | 同上 | 同上 |
| `networkMetadata.resolve(force)` | invoke | `network-metadata:resolve` | 同上 | 同上 |
| `networkMetadata.resolveAll(force)` | invoke | `network-metadata:resolve-all` | 同上 | `network-metadata-schema` |

## 主进程侧事件源汇总（非 renderer 轮询，全部推送）

| 事件通道 | 触发源 | 语义 |
|---|---|---|
| `kernel:status-event` | 内核网关状态机（启动/停止/失败/恢复） | 全窗口扇出 |
| `system-proxy:status-event` | `SystemProxyService`（enable/disable/restore-failed/conflict） | 全窗口扇出 |
| `tun:status-event` | `TunCoordinator` | 全窗口扇出 |
| `updates:state-event` | `UpdateService` 状态机（idle/checking/available/downloading/ready/error） | 全窗口扇出 |
| `kernel-manager:state-event` | `KernelManagerService` | 全窗口扇出 |
| `mihomo:traffic-event` | 控制器 WS `/traffic` | 全窗口扇出；同时喂 `UsageHistoryService` |
| `mihomo:connections-event` | 控制器 WS `/connections` | 全窗口扇出；同时喂用量统计 |
| `mihomo:log-event` | 控制器 WS `/logs` + 环形缓冲 | 全窗口扇出；同时落盘核心日志 |
| `mihomo:stream-error-event` | WS 重连失败 | 全窗口扇出 |
| `app:navigate-event` | 更新通知点击 → `showMainWindowAt('/about')` | 单窗口导航指令 |

## 横切守护（无 renderer 契约，但 Tauri 侧必须等价实现）

| 机制 | 周期/时机 | 源码位置 |
|---|---|---|
| 系统代理守护（外部篡改修复） | 30 s（`PROXY_GUARD_INTERVAL_MS`，受 `proxyGuard` 设置） | `index.ts` proxyGuardTimer |
| 特权内核活性探针 | 5 s，异常退出 → 恢复代理 → 意图恢复循环 | `index.ts` privileged liveness monitor |
| 网络连通性探测 | 15 s + 电源 resume 即刻 | `NetworkDetector` + `powerMonitor.on('resume')` |
| 更新轮询 | 10 min（会话中捡拾新发布） | `UpdateService.startPolling()` |
| 运行时意图恢复协调器 | 启动 + 内核/网络事件唤醒 | `RuntimeIntentRecoveryCoordinator` |
| 登录项注册维护 | 启动一次性（Run-key → 计划任务迁移、`--hidden` 参数重写） | `StartupService.refreshRegistration` |
| Sub-Store 设置热应用 | `appSettingsService.onChange` | `SubStoreService.onSettings` |
| 渲染进程崩溃/加载失败日志 | `render-process-gone` / `did-fail-load` | `createWindow` |
| 单实例锁 + 第二实例深链转发 | 启动时 | `requestSingleInstanceLock` + `second-instance` |
