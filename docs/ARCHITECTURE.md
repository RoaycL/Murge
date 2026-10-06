# 架构

本文描述当前代码的实际结构（v0.9.x）。实现细节以代码为准；各子系统的专题契约见同目录下的其他文档：[MIHOMO_API.md](MIHOMO_API.md)、[NETWORK_RECOVERY.md](NETWORK_RECOVERY.md)、[CONFIG_BACKUP.md](CONFIG_BACKUP.md)、[DIAGNOSTIC_REPORT.md](DIAGNOSTIC_REPORT.md)、[BRANDING.md](BRANDING.md)、[RELEASES.md](RELEASES.md)、[UI_SPEC.md](UI_SPEC.md)。

## 目标

- 面向 Windows（x64 / arm64）的桌面用户体验；开发模式使用夹具内核和模拟控制器，因此 renderer 也可以在 macOS / Linux 上开发。
- 可替换的产品品牌（`brand.config.json`），业务逻辑不耦合到当前名称。
- 最小权限（least-privilege）的 renderer。机密、子进程和操作系统设置保持在 Vue 之外。
- 围绕 mihomo 控制器 API 的可测试边界：每个与操作系统交互的部分都通过接口注入，并有 fake / disabled 实现。
- 配置持久化与实时运行时状态之间的明确分离。

## 进程模型

```text
Vue renderer (Pinia stores)
  │ typed window.desktop API
  ▼
preload allowlist (src/preload)
  │ validated Electron IPC (src/main/ipc)
  ▼
Electron main (src/main/index.ts 负责组装)
  ├── ModeTransitionController ── 内核启停 / TUN 切换的唯一 FIFO 队列
  │     ├── KernelGateway
  │     │     ├── Windows 生产：PrivilegedServiceKernelGateway ──┐
  │     │     └── 开发 / 冒烟 / 非 Windows：KernelSupervisor ── 子进程 mihomo（或夹具）
  │     └── TunCoordinator ── MihomoHotSwitchTunAdapter（控制器热切换）
  ├── MihomoService / MihomoClient ── REST + WebSocket 控制器
  ├── ProfileService ── YAML 配置、订阅、校验
  ├── SystemProxyService ── HKCU Internet Settings
  ├── KernelManagerService ── 内核版本通道与安装
  ├── UpdateService ── 应用自更新（electron-updater）
  ├── SubStoreService ── worker_threads 中运行的 Sub-Store
  └── 其他：启动项、托盘、日志、诊断、备份、流量历史等
                                                                │ 命名管道（JSON，协议 v7）
                                                                ▼
                                   tun-service.exe（Go，LocalSystem Windows 服务，native/tun-service）
                                     └── 唯一的 mihomo 进程（普通模式与 TUN 模式共用）
```

renderer 绝不能接收控制器机密、用户可见配置引用之外的文件系统路径、进程句柄或特权服务凭据。

### 单内核模型

Windows 安装版中，mihomo 进程**不由 Electron 直接派生**，而是由安装器注册的 LocalSystem 服务 `tun-service.exe` 拥有（NSIS 脚本 `resources/nsis/uninstall-restore.nsh` 以 `--install` / `--uninstall` 管理服务）。整个应用运行期间只有一个 mihomo 进程、一组统一端口（控制器 + mixed/http/socks）和一个控制器机密：

- 普通模式与 TUN 模式是同一个进程；开启 / 关闭 TUN 只是通过控制器对运行配置做热补丁（`MihomoHotSwitchTunAdapter`），不会启动第二个进程或交接端口。
- `ModeTransitionController`（`src/main/kernel/mode-transition.ts`）把 `kernel.start/stop`、`tun.enable/disable` 和故障恢复全部串行到一个 FIFO 队列，保证任何时候只有一个宿主绑定统一端口，且系统代理绝不会指向已失效的端口。
- `KernelSupervisor` 仍用于开发模式（夹具内核）、`--kernel-smoke` CI 探针以及非 Windows 生产构建（此时解析器为 disabled，fail-closed）。

## 目录

- `src/main`: 受信任的 Electron 代码和操作系统集成，按子系统分目录（见下文）。
- `src/preload`: 唯一的 renderer 桥接层；为每个操作暴露单独方法，绝不暴露原始 `ipcRenderer`，并把编码过的 `ProtocolError` 解码为稳定错误码。
- `src/renderer`: Vue 页面（`views/`）、组件、Pinia store、composable 和视觉令牌。
- `src/shared`: 进程间共享的可序列化类型、IPC 通道名（`ipc.ts`）、zod 运行时 schema（`schemas/`）和错误码（`protocol-errors.ts`）。
- `native/tun-service`: Go 编写的特权 Windows 服务。
- `native/wintun-abi-audit`: Wintun ABI 审计工具。
- `resources/bin`: 打包时由 `npm run kernel:prepare` 放入的、校验和固定的 mihomo 归档（git 忽略）。
- `resources/defaults`: 首次运行时使用的配置模板。
- `resources/tun-service`、`resources/tray`、`resources/startup`、`resources/nsis`: 服务二进制、托盘图标、计划任务脚本和安装器脚本。
- `scripts`: 品牌检查、许可证检查、内核资源准备、服务构建、发布说明生成。
- `tests`: vitest 测试。
- `docs`: 实现契约和验收标准。

## 主进程子系统

### 内核（`src/main/kernel`）

- `supervisor.ts` — `KernelSupervisor`：解析二进制、物化配置、无 shell 派生、等待就绪、先优雅停止再有界强杀、崩溃退避重启（带重启预算，持续运行后重置）、滚动日志（`bounded-log.ts`），启停经单一 promise 链串行化。在 Windows 非开发构建中（即 `--kernel-smoke` 路径）还会挂载 `crash-watchdog.ts`：应用意外退出时由看门狗强制结束内核。
- `privileged-service-gateway.ts` — `PrivilegedServiceKernelGateway`：Windows 生产网关。生成有效配置后通过 `TunServiceClient` 请求服务启动 / 停止内核，并以控制器 `GET /version` 加端口归属检查（`proxy-port-reclaimer.ts`）确认就绪。
- `controller-ready-gateway.ts`、`single-kernel-gateway.ts`、`mode-transition.ts` — 对内核网关的包装：控制器就绪确认、延迟绑定和统一的模式切换队列。
- `resolvers.ts`、`mihomo-artifact.ts` — 按平台 / 架构解析内核归档，并对照 `resources/mihomo-assets.json` 中固定的 SHA-256 校验。
- `mihomo-config.ts`、`profile-kernel-config.ts`、`mihomo-config-store.ts` — 由活动配置生成运行配置：顶层键 allowlist、强制 `127.0.0.1` 控制器（除非用户在核心设置中选择 `0.0.0.0`）、64 位十六进制机密、持久化 geodata 目录并用安装包自带数据预置。
- `kernel-manager-service.ts` — 内核版本通道（stable / preview / smart / specific），从 GitHub Releases 获取，通过特权服务安装。
- 配置增强：`overrides/`（YAML 合并与 JS 覆写）、`dns/`、`sniffer/`、`core-settings-service.ts`、`geodata-settings-service.ts`，以及把变更热应用到运行中内核的 `live-config-reloader.ts` / `enhancement-live-gateway.ts`。最终文档的处理顺序为：活动配置 → 覆写 → DNS → 嗅探。

### mihomo 控制器（`src/main/services`）

- `mihomo-client.ts` — `MihomoClient`：REST 访问，始终携带 `Authorization: Bearer <secret>`，对动态路径分段百分号编码，有请求超时，错误映射为 `ProtocolError`。
- `mihomo-stream.ts` — WebSocket 流（流量、连接、日志等）：意外断开时以指数退避加抖动重连，长时间稳定后重置退避，不重放缓冲消息；无监听者或内核被有意停止时停止重连。
- `mihomo-service.ts` — `MihomoService`：组合 client 和各条流，实现 `MihomoGateway`。
- 同目录还包含代理选择记忆、延迟测试、外部 IP、网络元数据、流媒体解锁检测、网络变化检测（`network-detector.ts`）、流量 / 进程用量历史和远程图标缓存。

### 配置文件（`src/main/profiles`、`src/main/subscriptions`）

- `profile-repository.ts` — 原子化写入（临时文件 + fsync + rename），保留原始 YAML 文档，针对 GUI 呈现的字段做定点编辑而不丢弃未知键或注释。
- `profile-service.ts` — `ProfileService`：组合仓库、校验器和订阅抓取；只有校验通过的文档才能成为活动配置。Windows 生产中额外的语义校验通过特权服务以 `mihomo -t` 执行。
- `profile-source-store.ts` — 订阅 URL 等来源信息经 Electron `safeStorage` 加密保存，不进入 renderer。
- `profile-auto-reload-gateway.ts`、`profile-auto-update-service.ts` — 活动配置变更后自动重载内核；订阅按周期自动更新。
- `subscriptions/subscription-fetcher.ts` — 订阅下载：拒绝非公网地址、日志中隐去凭据，可经本地代理抓取。

### 系统代理（`src/main/system-proxy`）

- 基于 Windows 的实现，置于一个接口之后。（`WindowsSystemProxyAdapter` 通过 `reg.exe` 拥有三个 HKCU Internet Settings 值，然后告诉 WinINet 重新读取它们；`FakeSystemProxyAdapter` 支撑开发/测试路径；`DisabledSystemProxyAdapter` 使每个非 win32 生产构建 fail-closed。）
- 在启用前存储先前精确的代理状态。（`FileSystemProxyBackupStore` 在【任何】注册表变更【之前】，以原子方式（临时文件+重命名）写入带模式版本化的快照，按键控实例，因此 `enable()` 之后立刻崩溃也可从已提交的备份恢复。）
- 只恢复本应用拥有的值。（`isOwned`/`matchesPrevious` 仅当三个键全部精确匹配所写入的目标时才将代理视为已拥有；冲突（外部修改或已有冲突代理）会以结构化的 `conflictDetail` 暴露 `SYSTEM_PROXY_STATE_CONFLICT`，且不执行任何变更。）
- 崩溃后恢复过期的已拥有状态。（`SystemProxyService.init()` 在启动时运行；`SystemProxyOrderedKernelGateway` 在内核停止前恢复代理，内核进入 `failed` 时也立即恢复，因此代理状态绝不会指向失效端口；退出流程 `quit-guard.ts` 同样会恢复。）
- 代理守护：启用期间定期调用 `verifyIntegrity()`，只在本应用拥有的值被外部改动时重新写回。
- 绕过列表由 `proxy-bypass-store.ts` 持久化；`probe.ts` 在写注册表前用 TCP / HTTP / SOCKS 探测确认 mixed 端口确实可用。
- 不得从 renderer 修改系统代理设置。（UI 读取主进程的 `status`，绝不会乐观地切换；`enable`/`disable` 在主进程内通过 promise-queue 互斥锁串行化。）

分层：`service.ts`（状态机 + 串行化操作 + 内核探测 + 备份）→ `policy.ts`（纯拥有的/合并/格式化辅助函数）→ `adapters/{windows,disabled,fake}-adapter.ts`（平台 I/O）并带 `adapters/windows-helpers.ts` 提供 `reg` argv 构建器、`reg query` 解析器和 WinINet 刷新脚本。该服务只修改每用户的 HKCU Internet Settings 键，不涉及 DNS、路由或防火墙。

### TUN（`src/main/tun`、`native/tun-service`）

- `coordinator.ts` — `TunCoordinator`：TUN 生命周期，注入 `TunMutationAdapter`。非 Windows 或开发构建使用 fail-closed 的 `GatedTunMutationAdapter`。
- `hot-switch-adapter.ts` — Windows 生产适配器：在同一个服务所有的 mihomo 上通过控制器热补丁开启 / 关闭 TUN，并用 `data-plane-readiness.ts` 确认数据面就绪。仅当最终文档启用 DNS 模块时才接管 53 端口。
- `mihomo-tun-config.ts`、`tun-config-service.ts` — TUN 配置生成与用户设置（栈、路由列表等）。TUN 已开启时保存设置会在模式切换队列中立即热应用（`TunCoordinator.reapplyConfig()`），失败则回滚已保存的设置；修改网卡名称需要先关闭再重新开启 TUN。
- `service-client.ts`、`service-protocol.ts`、`named-pipe-transport.ts`、`service-identity.ts` — 与 Go 服务的命名管道协议（zod schema，当前版本 7；操作：`start`、`stop`、`status`、`reconcile`、`install`、`validate`、`provider-content`）。服务端在 `native/tun-service/protocol.go` 中对每个请求做 allowlist 校验，并核对配置的 SHA-256。
- `state-machine.ts`、`audit-log.ts` — renderer 可见的状态：`configured`、`starting`、`active`、`restoring`、`failed`、`conflict`、`unsupported`、`restore-failed`。
- `binary-integrity.ts`、`security-descriptors.ts`、`wintun-abi.ts`、`g1-*` — 二进制签名 / 哈希检查、服务状态目录的 ACL 契约，以及 Wintun 驱动的实验室探针（不在正常运行路径上）。

Go 服务（`native/tun-service`）负责：注册 / 卸载自身（`installer_windows.go`）、持有唯一 mihomo 进程并记录归属（`manager.go`、`store.go`）、启动前回收被占用的代理端口（`port_reclaimer*.go`）、安装指定内核版本（`kernel_versions_windows.go`）、校验配置以及读取 provider 内容。

### 启动与恢复（`src/main/startup`、`src/main/quit-guard.ts`）

- `service.ts` + `scheduled-task-adapter.ts` — 通过 Windows 计划任务实现开机启动（支持静默启动）；开发环境用 `electron-adapter.ts`。
- `runtime-intent.ts`、`runtime-intent-recovery.ts` — 持久化用户意图（内核 / 系统代理 / TUN 是否开启），启动和内核崩溃后按意图恢复。
- 启动恢复顺序：先恢复遗留的系统代理备份，再让特权服务对账并停止遗留内核，最后对账 TUN 事务，之后才回放运行意图。窗口创建不等待这些步骤。
- `quit-guard.ts` — 退出前先恢复本应用拥有的系统代理，确认恢复后才停止内核并退出；恢复失败时保留窗口和内核，让用户重试。

### 其他主进程服务

- `updates/` — `UpdateService` + `ElectronUpdaterDriver`：应用自更新。内核更新见上文 `KernelManagerService`。
- `substore/` — 在 `worker_threads` 中运行 Sub-Store，并管理其资源包。
- `app-settings/` — 应用设置持久化。
- `tray/` — 托盘菜单与随运行模式变化的图标。
- `logging/` — 按 app / core / substore 分类的文件日志，并把 `console` 输出桥接到文件。
- `diagnostics/` — 诊断报告收集（含 Windows 主机信息：计划任务、服务、TUN 适配器）。
- `backup/` — 加密配置备份 / 恢复（`.murge-backup`），可选 WebDAV 上传下载；仅安装版可用。
- `storage/app-data.ts` — 应用数据目录布局与旧命名空间迁移。
- `ipc/` — `register-ipc.ts` 把各 gateway 注册为 IPC 处理器，`handlers.ts` 在主进程用 zod 校验每个参数。
- `testing/` — 开发与测试用的模拟控制器、夹具内核和假容器。

## 状态模型

renderer 按领域拆分 Pinia store（`src/renderer/src/stores`），每个 store 只镜像主进程推送或拉取的状态：

- `kernel`: 生命周期、PID、控制器健康、版本和最后错误。
- `runtime`: 模式、活动配置、代理 / TUN 状态、网络和外部 IP。
- `traffic`: 有界的时间序列缓冲区；renderer 最多保留可见的历史窗口。
- `connections`: 按连接 ID 索引的最新快照。
- `profiles`: 仅元数据；订阅来源等机密保留在主进程存储中。
- `system-proxy`、`tun`、`tun-config`: 主进程状态的只读镜像，UI 不做乐观切换。
- 其余 store 分别对应策略组、规则、provider、日志、DNS / 嗅探增强、覆写、核心设置、内核版本、更新、Sub-Store、用量历史、延迟、解锁检测、外观等页面。

不要为所有控制器数据使用一个全局 store。

## 安全规则

- 保持 `sandbox`、`contextIsolation` 启用，并禁用 `nodeIntegration`。
- 在主进程校验每个 IPC 参数；TypeScript 类型不是运行时校验。
- 默认将 `external-controller` 绑定到 `127.0.0.1`；只有用户在核心设置中显式选择时才绑定 `0.0.0.0`。
- 即使是 localhost 也生成控制器机密。
- 不记录含凭据的订阅 URL 或控制器机密（见 `src/shared/log-redaction.ts`）。
- 新窗口请求只放行品牌配置中的 https 仓库 / 支持链接，其余一律拒绝。
- 不得通过拼接的字符串调用 PowerShell。
- 特权服务只接受 allowlist 中的操作，并校验载荷大小、配置摘要和版本格式。
