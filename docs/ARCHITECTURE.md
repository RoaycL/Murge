# 架构

> 强制安全边界：在实现或测试进程与网络服务前，先阅读 `DEVELOPMENT_SAFETY.md`。在当前的 Mac 上禁止启动真实内核和修改网络。

## 目标

- 面向 Windows 优先的桌面用户体验，且 renderer 可在 macOS 上开发。
- 可替换的产品品牌，业务逻辑不耦合到当前名称。
- 最小权限（least-privilege）的 renderer。机密、子进程和操作系统设置保持在 Vue 之外。
- 围绕 mihomo 控制器 API 的可测试边界。
- 配置持久化与实时运行时状态之间的明确分离。

## 进程模型

```text
Vue renderer
  │ typed window.desktop API
  ▼
preload allowlist
  │ validated Electron IPC
  ▼
Electron main
  ├── KernelSupervisor ── child mihomo process
  ├── MihomoClient ───── REST / WebSocket controller
  ├── ProfileService ─── YAML profiles and subscriptions
  ├── SystemProxy ────── Windows Internet Settings
  ├── TunService ─────── privileged helper boundary
  └── UpdateService ──── application and kernel channels
```

renderer 绝不能接收控制器机密、用户可见配置引用之外的文件系统路径、进程句柄或特权辅助程序凭据。

## 必需文件夹

- `src/main`: 受信任的 Electron 代码和操作系统集成。
- `src/preload`: 唯一的 renderer 桥接层；暴露单个操作，绝不暴露原始 `ipcRenderer`。
- `src/renderer`: Vue 页面、组件、store 和视觉令牌。
- `src/shared`: 进程间共享的可序列化类型和通道名称。
- `resources/bin`: 存放特定平台内核二进制文件的忽略位置。
- `resources/defaults`: 首次运行时复制到应用数据目录的模板。
- `docs`: 实现契约和验收标准。

## 待实现的服务

### KernelSupervisor

职责：

1. 为 `win32-x64` 和 `win32-arm64` 解析打包或开发环境下的二进制文件。
2. 对照由项目控制的发布元数据验证二进制文件校验和。
3. 创建应用数据目录并物化一个活动配置。
4. 首次启动时生成加密随机控制器机密。
5. 在无 shell 的情况下派生 mihomo，并捕获 stdout/stderr。
6. 同时等待控制器监听就绪和 `GET /version` 成功。
7. 先优雅停止，再使用有界的强制终止回退方案。
8. 发出状态转换，并防止并发启动/停止竞态。
9. 应用崩溃循环退避，并写入聚焦的滚动日志。

### MihomoClient

- 拥有 REST 和 WebSocket 连接。
- 始终发送 `Authorization: Bearer <secret>`。
- 对每个动态路径分段进行百分号编码。
- 使用请求超时和类型化错误层次结构。
- 以带上限的指数退避和抖动重连流。
- 内核被有意停止时停止重连。

### ProfileService

- 为不支持的设置保留原始 YAML 文档。
- 仅针对 GUI 中呈现的字段维护规范化视图模型。
- 原子化写入：临时文件、校验、重命名。
- 在激活前运行 mihomo 配置校验。
- 在简单的配置切换中绝不静默丢弃未知键或注释。

### SystemProxyService

- 基于 Windows 的实现，置于一个接口之后。（`WindowsSystemProxyAdapter` 通过 `reg.exe` 拥有三个 HKCU Internet Settings 值，然后告诉 WinINet 重新读取它们；`FakeSystemProxyAdapter` 支撑开发/测试路径；`DisabledSystemProxyAdapter` 使每个非 win32 生产构建 fail-closed。）
- 在启用前存储先前精确的代理状态。（`FileSystemProxyBackupStore` 在【任何】注册表变更【之前】，以原子方式（临时文件+重命名）写入带模式版本化的快照，按键控实例，因此 `enable()` 之后立刻崩溃也可从已提交的备份恢复。）
- 只恢复本应用拥有的值。（`isOwned`/`matchesPrevious` 仅当三个键全部精确匹配所写入的目标时才将代理视为已拥有；冲突（外部修改或已有冲突代理）会以结构化的 `conflictDetail` 暴露 `SYSTEM_PROXY_STATE_CONFLICT`，且不执行任何变更。）
- 崩溃后恢复过期的已拥有状态。（`SystemProxyService.init()` 在启动时运行；有序内核网关在内核停止前恢复，因此当内核不可用时代理状态绝不会悬空；主进程的 `before-quit` 也会恢复。）
- 不得从 renderer 修改系统代理设置。（UI 读取主进程的 `status`，绝不会乐观地切换；`enable`/`disable` 在主进程内通过 promise-queue 互斥锁串行化。）

分层：`service.ts`（状态机 + 串行化操作 + 内核探测 + 备份）→ `policy.ts`（纯拥有的/合并/格式化辅助函数）→ `adapters/{windows,disabled,fake}-adapter.ts`（平台 I/O）并带 `adapters/windows-helpers.ts` 提供 `reg` argv 构建器、`reg query` 解析器和 WinINet 刷新脚本。该阶段刻意限定在每用户的 HKCU Internet Settings 键——不做 TUN、DNS、路由、LAN 代理或防火墙变更。

### TunService

- 将 TUN 视为一个特权、可单独测试的特性。
- 记录并验证驱动/辅助程序的安装路径。
- 提权需要明确的用户操作。
- 分别报告已配置（configured）、启动中（starting）、生效（active）和失败（failed）状态。

## 状态模型

- `kernelStore`: 生命周期、PID、控制器健康、版本和最后错误。
- `runtimeStore`: 模式、活动配置、代理/TUN 状态、网络和外部 IP。
- `trafficStore`: 有界的时间序列缓冲区；renderer 最多保留可见的历史窗口。
- `connectionsStore`: 按连接 ID 索引的最新快照。
- `profilesStore`: 仅元数据；机密保留在主进程存储中。

不要为所有控制器数据使用一个全局 store。

## 安全规则

- 保持 `sandbox`、`contextIsolation` 启用，并禁用 `nodeIntegration`。
- 在主进程校验每个 IPC 参数；TypeScript 类型不是运行时校验。
- 默认将 `external-controller` 绑定到 `127.0.0.1`，绝不绑定到 `0.0.0.0`。
- 即使是 localhost 也生成控制器机密。
- 不记录含凭据的订阅 URL 或控制器机密。
- 未经协议（scheme）allowlist，不得打开从 renderer 接收到的任意 URL。
- 不得通过拼接的字符串调用 PowerShell。
