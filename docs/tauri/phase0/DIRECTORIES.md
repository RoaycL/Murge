# Phase 0 — 目录与持久化基线

> 迁移计划 Phase 0 交付物：*"Record the current app-data, executable, logs,
> working, kernel, Sub-Store, and service directories."*
>
> 所有路径都从 `brand.config.json` 派生（不变量 9：品牌即身份）。Tauri 侧
> **必须逐字复刻**：产品改名不能移动数据，Tauri 可执行文件换名不能让用户
> 丢失 profile / 设置 / 备份。

## 命名空间规则

- 平台 app-data 根：
  - Windows `%APPDATA%`（`app.getPath('appData')`，典型 `C:\Users\<user>\AppData\Roaming`）
  - macOS `~/Library/Application Support`
  - Linux `$XDG_CONFIG_HOME` 或 `~/.config`
- 应用命名空间 = `appId`（`io.murge.desktop`），**不**使用产品名。
  生产构建通过 `app.setPath('userData', appDataRoot(...))` 在 `ready` 前钉死
  （`src/main/index.ts` 模块级；`storage/app-data.ts`）。
- 开发构建：真实用户数据零接触 —— profile 工作区是每次启动 `mkdtemp` 的临时目录
  （`DEV_PROFILE_TMP_PREFIX = 'proxy-profiles-'`），用量统计用内存 store。
- 旧命名空间迁移：`migrateLegacyAppData` 按 `brand.legacyProductNames` +
  `brand.legacyAppDataNamespaces` 构建迁移映射（当前各为 `["Murge"]` / `[]`），
  两阶段（staging 副本 → 不覆盖提交）、迁移标记 `migration-state.json`（v1）、
  崩溃可重入、符号链接跳过、路径逃逸防护。Tauri 首版也必须执行同样的迁移
  （Electron 时代的文件夹 → 同一稳定命名空间）。

## 目录树（生产，Windows 视角）

| 目录 | 路径 | 所有者/写入者 | 内容 | Tauri 对等要求 |
|---|---|---|---|---|
| 应用数据命名空间 | `%APPDATA%\io.murge.desktop` | 主进程（pin 为 `userData`） | 以下全部子目录 | Rust 侧用同一常量；不得改用 Tauri 默认 `identifier` 路径 |
| ↳ profiles | `…\profiles` | `ProfileRepository` | 用户 YAML 配置文档（含 `.sources/` 加密订阅 URL 库） | 逐字节兼容（升级后原样可读） |
| ↳ profiles/.sources | `…\profiles\.sources` | `EncryptedProfileSourceStore` | safeStorage(DPAPI) 加密的订阅 URL | 解密实现需等价（Tauri 无 safeStorage；用 Windows DPAPI 或应用级密钥，Phase 3A 决策点） |
| ↳ kernel | `…\profiles\kernel`（`productionKernelRoot = join(profileRoot, 'kernel')`，`profileRoot` = `…\profiles`，故内核工作区在 profiles 目录**内部**） | `MihomoKernelResolver`/`KernelManagerService` | 内核工作区：`runtime/`（运行配置）、`geodata/`（持久内核 home `-d`：geodata 数据库、provider 缓存）、版本工作区 | 路径不变；Go 服务摘要锁定需改绑 Tauri 可执行文件（不变量 3/Phase 3D）。迁移时保持 `join(profileRoot,'kernel')` 解析，不要想当然放到命名空间根 |
| ↳ kernel/runtime | `…\profiles\kernel\runtime` | `MihomoKernelConfigStore` | 活动运行配置（临时+校验+重命名原子写） | 同上 |
| ↳ kernel/geodata | `…\profiles\kernel\geodata` | mihomo 自身（`-d` 指向） | geodata 数据库、provider 内容缓存 | 安装器种子 `resources/geodata` 继续生效 |
| ↳ logs | `…\logs`（= `userData\logs`，`app.setAppLogsPath`） | `FileLogService` | app/core/substore 滚动日志 | 命名与滚动策略一致 |
| ↳ icon-cache | `…\icon-cache`（`userData` 下） | `RemoteIconCache` | 远程策略图标持久缓存（stale-if-error） | 边界：有界、键控、可重建 |
| ↳ proxy-selections | `appDataRoot` 下（`ProxySelectionStore`） | `ProxySelectionService` | 每配置记忆节点选择（重启/切换后重放） | 逐字节兼容 |
| ↳ substore | `…\substore` | `SubStoreService` | Sub-Store 前端资产、worker 数据、验证过的下载 | 资产来源与校验和策略不变 |
| ↳ usage-history | `appDataRoot` 下（`FileSystemUsageHistoryStore`） | `UsageHistoryService` | 用量历史（dev 用内存 store） | 格式兼容 |
| ↳ settings | `appDataRoot` 下（各 `*SettingsService`/`AppSettingsService`） | 各设置服务 | `app-settings.json`、core/dns/sniffer/geodata/tun 配置 JSON（全部原子写） | schema 版本兼容 |
| ↳ system-proxy 备份 | `appDataRoot` 下（`FileSystemProxyBackupStore.forAppDataBase`） | `SystemProxyService` | 带模式版本的已拥有注册表快照（enable 前原子写；uninstall/恢复 CLI 读它） | **关键**：路径与格式逐字节兼容，Tauri 首启的孤儿恢复必须能读 Electron 写的备份 |
| ↳ tun 审计/日志 | TUN 协调器工作区（`TunCoordinator`/`audit-log`） | TUN 栈 | 事务审计日志 | 一致 |
| 系统服务 | Windows 服务（LocalSystem） | Go TUN 服务 | mihomo 唯一特权宿主：命名管道服务端、内核 home ACL、摘要锁定客户端 | 服务的可执行文件仍是 Go 二进制；**客户端摘要需重钉到 Tauri exe**（`tun/service-identity.ts`：管道名派生自 `brand.appId`，客户端 exe 摘要锁定） |
| 安装器资源 | `C:\Program Files\…\resources\`（`process.resourcesPath`） | electron-builder（Tauri: NSIS） | `bin/`（mihomo 归档）、`geodata/`（种子库）、`tray/`（托盘图标）、Go 服务 exe、许可证 | Tauri 打包必须携带等价资源集（Phase 5 清单） |
| 可执行文件 | `%LOCALAPPDATA%\Programs\…`（NSIS perMachine 时 `Program Files`） | electron-builder | 当前 Electron 应用 | Tauri exe 名/path 变化触发服务摘要更新 + 计划任务重写（Phase 3D/4） |
| 计划任务 | Windows Task Scheduler（LogonTrigger） | `ScheduledTaskStartupAdapter` | 开机自启（`--hidden` 参数、延迟、优先级、Run-key 回退） | 行为对等清单见 Phase 0 验收清单 |
| 深链注册 | `HKCU\Software\Classes\murge` | `app.setAsDefaultProtocolClient`（运行时注册，NSIS 不写） | `murge://` 协议 | Tauri 深链插件需保持 HKCU 注册与单实例转发 |

## 关键绝对路径的解析函数（Tauri 对照用）

| 逻辑路径 | Electron 解析 | 说明 |
|---|---|---|
| app-data 根 | `appDataRoot(app.getPath('appData'))` = `join(%APPDATA%, 'io.murge.desktop')` | `storage/app-data.ts` |
| userData（=根） | 生产 `app.setPath('userData', appDataRoot(...))` | `index.ts` 模块级 |
| profile 工作区 | `resolveRuntimeProfileRoot(appData)` → `%APPDATA%\io.murge.desktop\profiles` | dev = `mkdtemp` |
| 内核根 | `join(profileRoot, 'kernel')` = `…\io.murge.desktop\profiles\kernel` | **注意**：内核工作区在 profiles 目录内部（`profileRoot` = `…\profiles` 时 join 得 `…\profiles\kernel`） |
| 日志目录 | `join(userData, 'logs')` | `app.setAppLogsPath` |
| 图标缓存 | `join(userData, 'icon-cache')` | `RemoteIconCache` |
| Sub-Store | `join(appDataRoot, 'substore')` | `SubStoreService` |

## 开发/生产差异

| 项 | 开发 | 生产 |
|---|---|---|
| profile 工作区 | `mkdtemp('proxy-profiles-')` 每次启动新建 | `…\profiles` 持久 |
| 内核解析器 | fixture 进程（`readinessPattern: /fixture-ready/`） | Windows: 特权服务（唯一宿主）；其他平台 fail-closed |
| 控制器 | 进程内 mock（`MURGE_DEV_CONTROLLER`/`MURGE_DEV_SECRET` 可覆盖） | 真实 mihomo（受控端口 + 生成的 32 字节 secret） |
| 订阅抓取 | `fetchFn` 直接抛错（禁止真实抓取） | 真实 fetch + 内核代理回退传输 |
| 用量历史 | 内存 store | 文件 store |
| userData | Electron 默认（品牌名） | 钉到 `io.murge.desktop` |
