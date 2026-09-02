# 分阶段开发待办

本路线图是人类与 AI 贡献者的执行顺序。每次只完成一个阶段。不要开启其进入门槛未满足的阶段。

延期处理的视觉问题记录在 `docs/UI_DEBT.md` 中，且**不会**在功能阶段修复（仅在与统一视觉验收相关的处理中解决）。

`DEVELOPMENT_SAFETY.md` 中的安全规则适用于每个阶段。在当前这台 Mac 上，不要启动真实的 mihomo，也不要修改系统代理、TUN、DNS、路由、防火墙或网络接口。

## 状态图例

- `[ ]` 未开始
- `[~]` 进行中
- `[x]` 已完成并验证
- `[!]` 受阻或需要所有者决定

## Phase 0 — 框架基线

环境：当前 Mac，安全。

状态：已完成。

- [x] 搭建 Electron + Vue 3 + TypeScript。
- [x] 分离 main、preload、renderer 与共享契约。
- [x] 添加可配置的品牌化与重命名检查。
- [x] 添加规范的 934×672 UI 参考。
- [x] 创建 Activity 与 Overview 视觉外壳。
- [x] 创建 Processes、Devices、Policies、Rules、Capture、Decrypt、Rewrite 与 Settings 视觉外壳。
- [x] 记录 mihomo 控制器端点。
- [x] 添加开发机网络安全规则。
- [x] 验证类型检查、生产构建与开发启动。

退出证据：

- 存在提交 `67dc816` 或其后版本。
- `npm run brand:check`、`npm run typecheck`、`npm run build` 与 `npm test` 通过。

## Phase 1 — 契约加固与测试基础设施

环境：当前 Mac，安全。仅使用模拟对象。

进入门槛：Phase 0 完成。

- [x] 添加运行时 schema 校验库。
- [x] 在启动时与构建时校验 `brand.config.json`。
- [x] 校验每个 renderer 到 main 的 IPC 参数。
- [x] 校验并规范化 mihomo REST/WebSocket 负载。
- [x] 添加跨进程边界共享的类型化错误码。
- [x] 为有效、缺失与向前兼容的 API 字段添加单元测试夹具。
- [x] 为主进程测试添加伪服务容器。
- [x] 为安装、品牌检查、类型检查、单元测试与生产构建添加 CI。
- [x] 添加要求范围、证据与 UI 截图的拉取请求模板。

退出标准：

- 无效的 IPC 输入无法到达服务方法。
- 未知的上游响应字段不会破坏解析。
- 必需的缺失字段会产生类型化协议错误。
- CI 在干净检出中通过。

建议的 AI 任务：

> 仅从 `docs/ROADMAP.md` 完成 Phase 1。遵循 `DEVELOPMENT_SAFETY.md`。使用模拟对象与单元测试；不要启动真实 mihomo 或修改网络。提交一个附带测试证据的聚焦提交。

## Phase 2 — 使用无害夹具进程的内核生命周期

环境：当前 Mac，仅在使用非网络夹具进程时安全。

进入门槛：Phase 1 完成。

状态：已完成。

- [x] 定义 `KernelBinaryResolver`、`KernelConfigStore` 与 `KernelProcessAdapter` 接口。
- [x] 实现生命周期状态迁移与并发锁定。
- [x] 添加一个不打开任何网络监听的无害夹具进程。
- [x] 针对夹具实现启动、优雅停止、超时与强制停止行为。
- [x] 实现 stdout/stderr 捕获与有界日志轮转。
- [x] 实现崩溃检测与封顶的重启退避。
- [x] 向 preload 与 renderer 发送类型化状态事件。
- [x] 为重复启动、启动期间停止、崩溃、派生失败与陈旧 PID 添加测试。
- [x] 在开发构建中保持真实二进制解析禁用。

退出标准：

- 使用夹具进程证明了 PID 与生命周期迁移。
- 没有默认命令打开代理/控制器监听。
- 不会下载或执行真实 mihomo 二进制。

## Phase 3 — 模拟 mihomo 传输与 Activity 集成

环境：当前 Mac，安全。仅使用进程内模拟服务器。

进入门槛：Phase 1–2 完成。

状态：已完成，但有两个范围受限的豁免记录在 `docs/UI_DEBT.md`
（UI-DEBT-004）。P0 数据流已完全集成；Activity 延迟卡片和
每小时流量柱状图仍是静态占位符，因为其数据源（路由/DNS
延迟探测与持久化采样的流量历史）不属于 Phase 3 数据流范围。

- [x] 实现 REST 超时、取消与类型化 HTTP 错误。
- [x] 为每个数据流实现一个共享 WebSocket 传输。
- [x] 实现重连退避、抖动与监听器清理。
- [x] 提供模拟 `/version`、`/configs`、`/traffic`、`/connections` 与 `/logs` 端点。
- [x] 添加 `kernelStore`、`runtimeStore`、`trafficStore` 与 `connectionsStore`。
- [x] 将 Activity 夹具值替换为模拟 IPC 数据。*(速度卡片、活跃
      连接、进程/域名排名与总计分解是实时的。延迟
      卡片、每小时柱状图与 DHCP 数字仍为硬编码 — UI-DEBT-004。)*
- [x] 添加有界流量历史与连接聚合。
- [x] 在不改变几何布局的前提下添加加载、断连、空数据与畸形数据状态。
      *(流量与连接会呈现加载/断连/错误；上面两张
      占位卡片尚无可反映的实时状态 — UI-DEBT-004。)*
- [x] 将 934×672 截图与规范 HTML 参考对比。

退出标准：

- Activity 每秒从模拟服务器更新一次。
- 重连不会重复事件或泄漏监听器。
- 截图差异已记录并获得所有者批准。

## Phase 4 — 使用模拟对象的策略、规则与提供者 UI

环境：当前 Mac，安全。仅使用模拟对象。

进入门槛：Phase 3 完成。

- [x] 实现策略组与代理节点存储。
- [x] 实现带乐观状态与回滚的选择流程。
- [x] 实现单个与组延迟测试状态。
- [x] 实现代理提供者列表、刷新与健康检查 UI。
- [x] 实现规则表、搜索、排序与计数器。
- [x] 实现规则提供者列表与刷新 UI。
- [x] 对动态 API 路径段进行百分号编码。
- [x] 添加空、不支持与部分能力状态。
- [x] 为 Policies 与 Rules 添加 934×672 参考截图。

退出标准：

- [x] 模拟选择通过后续的模拟读取得到确认。
  - 由 `tests/policies-selection.integration.test.ts` 验证：真实的
    `MihomoClient` 针对模拟控制器，因此快速的 B→C 选择会被
    从控制器（`group.now`）读回，并与存储对照确认。
  - 也在存储层由 `tests/policies-store.test.ts` 覆盖
    （confirm-controller、serialize-rapid、supersede 与 recoverable-mismatch）。
- [x] 超时、不可用节点与提供者刷新失败可见且可恢复。
  - 由 `tests/policies-store.test.ts`（在控制器不匹配时可恢复的
    `panelError`）与 `tests/providers-store.test.ts`（失败的重新加载
    会在保留上次良好数据的同时为每一行显示错误；记录的
    `delay === 0` 会被渲染为不可用，绝不会显示 0ms）验证。
- [ ] 几何布局与规范参考一致。
  - 待处理；在 `docs/UI_DEBT.md` 中作为 UI 像素差债务跟踪，直到最终的
    统一对齐处理。

## Phase 5 — 配置文件与订阅

环境：当前 Mac，安全。仅使用文件系统夹具与模拟校验。

进入门槛：Phase 1 完成；可在契约稳定后与 Phase 4 并行运行。

- [x] 定义配置文件元数据、活动配置文件与订阅模型。
- [x] 实现导入到隔离的测试数据目录。
- [x] 在可行时保留不支持的 YAML 键与注释。
- [x] 使用临时文件加重命名实现原子写入。
- [x] 实现带凭据脱敏的订阅拉取抽象。
- [x] 在这台 Mac 上使用伪校验器实现校验适配器。
- [x] 实现激活事务与回滚。
- [x] 用已批准的视觉语言构建配置与提供者设置页面。
- [x] 为拉取失败、无效 YAML、重复名称与激活失败添加测试。

退出标准：

- 校验失败会保持活动配置文件不变。
- 日志永不包含订阅凭据。
- 未知配置字段在受支持的编辑后仍能存活。

## Phase 6 — Windows 打包基础

环境：一次性 Windows VM 或 CI 运行器。不需要网络变更。

进入门槛：Phase 1–2 完成。

- [x] 验证 x64 构建与 NSIS 安装器。（`package-win` Windows CI 任务安装 NSIS 安装器，启动 `--packaging-smoke` 生产探测，断言退出码 0 且无真实内核/控制器监听，然后卸载并确认用户配置存活。已在真实 Windows 运行器上观察到绿灯 — CI 运行 [33047258615](https://github.com/RoaycL/Murge/actions/runs/33047258615)，Windows 任务 `98434183222` — 生成 `Murge-Setup-0.1.0-x64.exe` 与 `Murge-Setup-0.1.0-arm64.exe`；arm64 仅打包，运行时验证明确推迟到 Windows VM。该次运行还交付了基于事务、基于标记的旧数据迁移。）
- [x] 验证 arm64 构建或明确推迟它。（打包策略 A：恰好两个按架构的安装器，x64 + arm64，绝不使用组合的多架构产物。arm64 运行时验证推迟到 Windows VM。）
- [x] 添加最终应用图标与 Windows 元数据。
- [x] 验证品牌配置的产品名、可执行文件与协议方案。（通过 `brand.*` 接线，并由一个构建器配置测试覆盖；运行时深链注册在 Phase 7。）
- [x] 定义稳定的应用数据与迁移命名空间。（命名空间派生自 `appId`，绝不用装饰性产品名，旧数据通过事务性暂存 + `migration-state.json` 标记流程导入：将完整副本 Staged 到兄弟目录，以明确的不覆盖冲突策略提交，并在部分失败后于下次启动时可恢复。）
- [x] 无文件名白名单地迁移旧数据。（某命名空间是否仍需导入由迁移标记与版本决定，而非判断目标已持有哪些文件，因此 Chromium 运行时文件 — `Preferences`、`Local State`、`Local Storage` — 绝不会抑制导入；标记被原子写入，且现有更新的配置文件绝不会被覆盖。）
- [x] 添加默认保留用户配置的卸载行为。
- [x] 在不提交机密的前提下记录代码签名输入。
- [x] 生成第三方声明与 mihomo GPL 合规材料。（占位符已移除；每个捆绑依赖的许可证文本保留在 `licenses/` 下，并与 `THIRD_PARTY_NOTICES.md` 一起捆绑进产物，由 `package-win` 产物检查与 `third-party-notices` 单元测试断言。）
- [x] 所有者在发布公共二进制之前为应用选择 GPL-3.0-only；
  完整许可证保留在仓库与已安装产物中，
  并对 SPDX 标识符与许可证文本进行失效关闭的发布检查。

退出标准：

- 干净的 Windows VM 可以安装、启动 UI 外壳并卸载它。
- 不会自动启动真实内核。
- 安装器产物包含所需声明。

## Phase 7 — 在隔离 Windows 上集成真实 mihomo

环境：带有独立恢复路径的一次性 Windows VM。

进入门槛：Phase 1–6 完成，且获得本阶段的显式所有者授权。

状态：已完成。真实生命周期仍是显式启用：安装器携带
架构匹配的官方归档，而验证、解压与派生
完全在响应 renderer 的 `kernel:start` 操作时才开始。因此
首次启动不依赖 GitHub 可用性。

第 B 步（Win x64 真实 mihomo，在一次性的 Windows CI 任务上）现已执行
多次 — 最近两次绿灯运行（故障注入步骤已验证）：
- <https://github.com/RoaycL/Murge/actions/runs/33058910851/job/98472683074>（HEAD `7bc55fe`）
- <https://github.com/RoaycL/Murge/actions/runs/33056173514/job/98463535723>

- [x] 为 win32/x64、win32/arm64 与 linux/arm64 解析固定的官方 mihomo 发行版（v1.19.30）。（步骤 A：`src/main/kernel/mihomo-artifact.ts`；目录只保存经摘要验证的平台，其他解析为 `UNSUPPORTED`。平台分诊：**Win x64** = 在一次性的 Windows CI 任务中运行时验证；**Win arm64** = 官方资产 + 摘要验证已实现，运行时验证明确推迟（目前仅打包，绝不改用 linux/arm64 构建替代）；**Linux arm64** = 仅服务器/开发支持，不是 Windows-arm64 交付物。）
- [x] 在执行前验证发行版校验和。（步骤 A：对固定摘要与固定字节大小流式计算 SHA-256；不匹配/截断被拒绝为 `ARTIFACT_HASH_MISMATCH` 且不保留文件。溯源记录在结构化的 `MihomoVerifiedMarker` 中，持有版本、归档 SHA-256、二进制 SHA-256、平台、架构；每次复用前都会对二进制重新哈希，被篡改、截断、伪造或失配的二进制会被隔离并重新下载 + 从新的已验证归档重新解压。）
- [x] 生成随机控制器密钥与仅本地的控制器地址。（步骤 A：`randomSecret(32)` → 64 位十六进制；密钥必须匹配 `/^[0-9a-f]{64}$/`，并由 `sanitizeMihomoConfig` 脱敏，因此绝不会泄漏到日志/证据中。）
- [x] 用 `MATCH,DIRECT` 生成安全的测试配置。（步骤 A：`mihomo-config-store` 使用真实 YAML 解析器针对精确的顶层白名单 `{mixed-port, allow-lan, mode, log-level, ipv6, external-controller, secret, tun, dns, rules}` 校验；`tun`/`dns` 只能为 `enable:false`，`rules` 必须恰好是 `MATCH,DIRECT`，端口限制在 1024–65535，且拒绝重复键、别名、标签、复合键与复杂对象。）
- [x] 使用监听器检查加 `/version` 实现控制器就绪。（步骤 A：有界监督者 + `MihomoClient.getVersion()`；真实测试轮询 `/version` 并断言控制器与混合端口各至少有一个回环监听器，在工具不可用时失效关闭。）
- [x] 集成真实 REST 与 WebSocket 传输。（生产使用随机的认证回环控制器；推送流绝不绝不绑定或改动宿主网络。）
- [x] 验证优雅停止、崩溃处理与重启行为。（组件/CI 级，通过一个门控真实测试停止/重启并产生新 PID，外加一个专门的 Windows 故障注入步骤来孤立被看门狗重启的内核，并证明共享的 `scripts/kernel-watchdog-cleanup.mjs` 能回收它；生产生命周期接线推迟。）
- [x] 仅使用测试配置文件验证配置校验与激活。（生产生命周期从单独验证过的安全目录配置启动；对运行内核应用任意所有者配置仍在本隔离阶段之外。）
- [x] 记录二进制路径、版本、PID、监听器与端点证据。（真实集成测试现在将解析出的二进制路径、mihomo 版本、PID、两个监听器 host:port、`/version` 结果与网络差异 PASS 写入证据产物 — 绝不含控制器密钥。已对照运行 `33058910851` 的 `kernel-real-evidence` 产物验证。）
- [x] 在 Windows 任务中添加宿主机前后网络完整性快照与 `finally` 清理/看门狗。（真实测试在前后对宿主网络快照做差异，且 `if: always()` finally 步骤现在调用共享的 `scripts/kernel-watchdog-cleanup.mjs`。）
- [x] 故障注入看门狗重启并证明外部清理。（Windows 任务添加一个专门的崩溃孤立步骤：它启动真实 mihomo，触发看门狗重启，记录恢复后的 PID，然后在不调用 `supervisor.stop()` 的情况下对自身 worker SIGKILL。因为 Windows 子进程只在分离时才在父进程后存活，测试使用仅测试的 `DetachedKernelProcessAdapter`，使重启后的内核真正被孤立；然后它运行与 `scripts/kernel-watchdog-cleanup.mjs` 完全相同的脚本，并断言该脚本回收了一个已记录的存活 PID（`stopping recorded PID X`）、释放了两个端口并移除了遗留工作区。这关闭了因测试进程已退出而让绿灯运行的 `finally` 从未执行查找并杀死分支的验收缺口。）
- [x] 强化共享看门狗清理以失效关闭。（`scripts/kernel-watchdog-cleanup.mjs` 现在在 `--require-evidence` 下针对缺失、损坏或字段不完整的证据文件注入真实/故障注入运行检错（`if: always()` finally 步骤与故障注入步骤都使用），同时仍会清扫并证明释放一次性运行器上的任何残留 mihomo；`tasklist`/`ps`/`netstat`/`ss` 探测失败或空白/不可解析输出会 THROW，而不是报告“无残留”/“已释放”；且只有在 OS 确认其身份仍是 `mihomo`/`mihomo.exe` 时才会杀死已记录存活的 PID（绝不是一个被回收/无关的 PID）。真实集成测试最终的增强证据写入现已被等待（无被吞掉的错误），并以逐字段断言重新读取。）
- [x] 严格校验证据，绝不让构造的路径扩大 `rm` 范围。（`scripts/kernel-watchdog-cleanup.mjs` 添加 `validateEvidenceSchema`，在 `--require-evidence` 模式下于任何目录移除之前检查：`pid` 必须是正整数，两个端口必须是 1024–65535 中的不同整数，`workspace`/`configDir` 必须是绝对非根路径且其 basename 为 `mihomo-real-*`/`mihomo-cleanup-fault-*`，且 `configDir` 位于 `workspace` 内，而 `--allowed-workspace-roots`（由 CI 作为运行器的临时目录即 `$env:TEMP`/`$env:TMP` 传入）要求工作区解析到允许的根内 — 因此 `/`、磁盘根、父/相对路径或逃逸的 `configDir` 都会被拒绝，且目录绝不会被移除。在路径问题上，该脚本仍按精确名称枚举并回收残留 mihomo，但执行任何删除，且 `--require-evidence` 使运行失败。恶意/出根路径测试证明哨兵工作区存活。）
- [x] 仅按精确名称匹配 mihomo 进程。（`scripts/kernel-watchdog-cleanup.mjs` 中的残留进程清扫现在在 Windows `tasklist` 与 Unix `ps` 两个分支中都使用严格的 `isMihomoName`（`mihomo`/`mihomo.exe`，不区分大小写），而非 `/^mihomo/i` 前缀，因此类似 `mihomo-helper.exe`、`mihomo-ui.exe`、`mihomo.old` 或 `not-mihomo` 的近似名称绝不会被枚举或发信号。且当记录的 `binaryPath` basename 与观测到的进程名失配时，记录的 PID 被视为陈旧/复用 — 它不会被按记录 PID 杀死（精确名称清扫仍可清理真实残留），取代旧的“先告警再杀死”。）
- [x] 阻止符号链接/联结/重解析点从 `rm` 范围逃逸。（词法 `resolve`/`relative` 无法证明 ACTUAL 文件系统目标保持在允许的根内，因此 `scripts/kernel-watchdog-cleanup.mjs` 添加 `validateEvidencePaths`：它对 `workspace`/`configDir` 执行 `lstat`，从而让符号链接 / 联结 / 重解析点被拒绝而非被下钻，并对它们及每个 `--allowed-workspace-roots` 条目执行 `realpath`，以证明解析后的目标保持在允许的根内（即使 `lstat` 未标记该链接，也作为纵深防御）。每个 `mihomo-workspace-*` 子项在删除前被 `lstat`，且当它是链接时只 `unlink` 该链接本身 — 绝不递归进入。不存在的路径（ENOENT）不是问题（无物可删故无逃逸），这是正常情况，因为真实内核测试自身的 afterEach 会在 CI `finally` 清理运行前移除其工作区。在任何真实路径问题上，该脚本仍按精确名称清扫残留 mihomo，但不执行目录移除，且 `--require-evidence` 失败。真实文件系统测试创建一个位于允许根之外的联结目标，并证明对于符号链接的 `workspace`、符号链接的 `configDir` 与符号链接的 `mihomo-workspace-*` 子项，外部哨兵都存活，而正常的真实工作区仍能端到端清理。这些在 ubuntu `verify` 任务上经 vitest 运行，且 `kernel-real-windows` 任务经独立 `node scripts/kernel-watchdog-symlink-escape.check.mjs` 重跑相同断言 — Node 原生 ESM 加载器在 Windows 上导入共享 `.mjs`，而 vitest 的 Windows 格式化转换无法做到 — 因此在真实 Windows 文件系统上实际练习联结/重解析点行为。）
- [x] 将生产内核生命周期接接到显式用户触发的操作。（Overview 调用 `kernel:start`；打包的 Windows 仅从该 IPC 操作解析并派生，等待认证 `/version`，并在超时时停止半就绪进程。）

> 真实 mihomo 执行证据仍限于一次性 Windows CI/VM。
> 生产组合现已完成，但这台 Mac 在开发或验证期间
> 仍绝不启动该二进制。

退出标准：

- 真实内核生命周期在隔离 Windows 上得到证明（步骤 B）。
- 宿主的正常网络路径保持不变。
- 不使用任何所有者订阅或凭据。

## Phase 8 — Windows 系统代理

环境：带快照与回滚的一次性 Windows VM。

进入门槛：Phase 7 完成，且另经显式所有者授权。

状态：**已完成并验证**，在提交 `2409cff` 处，范围限制在按用户的 HKCU Internet
Settings 键。在所有其他 OS 上（以及任何非 win32 的生产构建上），该
功能失效关闭：适配器报告 `unsupported`，主进程暴露
禁用状态，Overview 开关被禁用。在 win32 上主进程是
单一事实来源（`SystemProxyService`），因此没有乐观 — 
只有在内核探测确认回环混合端口可达后才写入注册表，
且在写入任何内容前备份精确的先前值，从而让
孤立的启用可恢复。

真实启用/恢复路径仅在一次性 Windows GitHub Actions
运行器上运行，在测试内由 `MURGE_RUN_REAL_SYSTEM_PROXY=1` + `win32` 门控（该
测试在正常的 `npm test` 中跳过）。它写入三个 HKCU 值，通过
宿主 `NetworkSnapshot` 证明只有 HKCU Internet Settings 代理字段变更
（WinHTTP、默认路由、DNS、适配器与防火墙配置保持逐字节一致），
然后在 `finally` 块中恢复精确的原始值 — 因此失败的
断言绝不会让宿主代理处于已变更状态。最终验收运行是
[GitHub Actions 33244865437](https://github.com/RoaycL/Murge/actions/runs/33244865437)：
所有四个任务通过，包括打包的 Windows 安装器生命周期、真实
mihomo 生命周期、真实 HKCU 启用/恢复以及外部 `if: always()` 恢复
检查。已安装产物冒烟测试也会启动捆绑内核，读取实时的
混合端口，并在启用代理前通过回环验证其 HTTP CONNECT 与 SOCKS5 表面。
不使用任何所有者流量或凭据。

- [x] 定义自有状态标记与精确先前状态备份。（`src/main/system-proxy/{policy,backup-store}.ts`：`buildWrittenState`/`isOwned`/`matchesPrevious` 定义所有权为三个键完全匹配写入目标；备份在任何注册表变更前原子写入（临时+重命名），按 schema 版本键控，因此 `enable()` 后立刻崩溃可从已提交的备份恢复。）
- [x] 实现启用、验证、恢复与崩溃恢复。（`src/main/system-proxy/service.ts`：串行化的启用/禁用/恢复、`init()` 孤立恢复、`restoreBeforeKernelUnavailable()`；有序的内核网关在内核停止前恢复，因此当内核不可用时代理状态绝不会悬空。）
- [x] 显式处理 PAC/手动代理冲突。（对自有值的外部修改或冲突的现有代理会暴露 `SYSTEM_PROXY_STATE_CONFLICT` 与结构化的 `conflictDetail`；在冲突时不执行任何变更。）
- [x] 仅在 OS 验证后更新 Overview 开关。（UI 读取主进程 `status`，绝不乐观翻转：开关由已验证的 `phase` 驱动，在主进程执行期间处于忙状态。）
- [x] 添加独立于 GUI 的紧急恢复命令。（`SystemProxyOrderedKernelGateway.stop()` 与主进程 `before-quit` 都在主进程中调用 `restoreBeforeKernelUnavailable()`，因此即使 renderer 无响应，代理状态也会被还原。专门的独立 CLI 不在范围内；Phase 11 恢复矩阵练习主进程路径。）
- [x] 测试安装、启用、崩溃、重新启动、恢复与卸载序列。（`tests/system-proxy-*.test.ts` 中的单元/组件覆盖；门控真实测试 `tests/system-proxy-real.integration.test.ts` 覆盖真实 HKCU 键上的启用/验证/恢复；安装/启动/卸载由现有 Windows 安装器冒烟测试任务覆盖。）
- [x] 记录前后注册表/设置证据。（`tests/system-proxy-real.integration.test.ts` 差异化注册表值加上前后宿主 `NetworkSnapshot`。经由实际代理感知请求的有效请求路由证据本阶段不在范围内。）

退出标准：

- 先前代理状态被精确恢复。（由真实测试证明：注册表值与完整宿主网络快照上的 `after === before`。）
- 当 Electron UI 不可用时紧急恢复可用。（主进程 `before-quit` 加有序内核网关恢复路径；独立于 renderer。）
- 在接管前对实时混合端口进行协议探测。（由
  打包的 Windows 验收路径满足，其使用仅回环的 HTTP CONNECT 与 SOCKS5
  探测。端到端目标路由有意推迟到后续
  网络恢复/发布矩阵，且不是 Phase 8 完成阻塞项。）

## Phase 9 — Windows TUN 与特权辅助程序

> **Phase 9B 决定（2026-08-30）：** 实现方向现在为
> `docs/phase9b-mihomo-owned-tun.md`。Mihomo 是 Wintun、
> 路由与 DNS 的唯一所有者；特权服务仅在需要时验证、启动、停止并
> 监督固定的打包 mihomo。下方辅助程序创建适配器/G1 复用
> 设计被保留为历史审计线索，不再是
> 实现门槛或生产路径。
>
> Phase 9B 的非网络实现现在包括精确的 TUN 配置
> 生成器/验证器、renderer 安全的 v2 意图、摘要绑定的特权服务
> 协议、单一自有会话客户端、就绪/回滚生命周期适配器
> 与单元测试。Electron 桥与原生 Windows 服务仍被门控，
> 直到该服务编译完成且其 ACL/安装器生命周期已审查。
> 运行时完成仍需 Phase 9B 决定中的隔离 Windows 证据矩阵；
> macOS/Linux 上的测试无法标记 TUN 运行时完成。
>
> **实现更新：** Go Windows 服务、所有者 SID 命名管道、
> 归档/核心完整性检查、PID 对账、失效关闭的安装器
> 生命周期、Electron IPC/preload/store/UI 接线以及 x64/arm64 CI 构建现已
> 实现。GitHub 托管的打包只验证空闲服务生命周期；
> 它有意不启用 TUN。隔离的 Windows 运行时证据
> 门槛仍开放。

环境：带快照与带外恢复的一次性 Windows VM。

进入门槛：Phase 8 完成，设计评审已批准，另经所有者授权。

状态：进行中 — 设计评审包按 **round-3** 到 **round-8** 评审项修订为 **rev.8**。保留 round-3 项 1–4：(1) Wintun ABI 按官方 `wintun.h`（固定 **0.14.1**、按架构 DLL、`WINAPI`、记录的导出/头文件来源）逐字校正 — `WintunCreateAdapter(Name, TunnelType, RequestedGUID) -> handle`，以应用提供的 `RequestedGUID` 作为稳定身份，`WintunGetAdapterLUID(h,&luid)`，`WintunStartSession(h,capacity)` 创建会话；(2) 提权重写为官方 **COM Elevation Moniker**；(3) 客户端 PID 固定为 `RPC_CALL_ATTRIBUTES_V2.ClientPID` + 仅 `ncalrpc`；(4) 一个**真正的预写日志**（PREPARED→mutate→APPLIED，通过 `WintunOpenAdapter(Name)` + 身份对 PREPARED-but-unknown 对账；此前“枚举产品适配器”的措辞在 round-4 校正）。**本次修订校正的 round-4 项：** (5) **移除不存在的 `WintunDeleteAdapter` / `RebootRequired`→`delete-pending` / 显式适配器删除语义**；官方 **0.14.1 `wintun.h` 是唯一 ABI 来源**，唯一的移除操作是 **`WintunCloseAdapter(creatorHandle)`**（对 create 创建的适配器而言会“移除适配器”）；`WintunDeleteDriver` 已导出，但生产策略**禁止**调用它；**没有 `WintunFreeSendPacket`**；(6) **辅助程序生命周期统一为每次启用的常驻模型**（round-5）：辅助程序是一个**每次启用、单客户端的常驻服务器**，其进程生命周期**绑定到启用的 TUN 窗口**（它持有创建者句柄并运行**常驻活动**），由启用与禁用共用的**同一实例**服务 — **不是**短命事务服务器；**G1 生命周期探测**（a 创建+持有创建者句柄 → b mihomo `WintunOpenAdapter`+`StartSession` → c 辅助程序关闭创建者句柄/退出 → d 观察会话+适配器是否持久）现记录了一个**观测 A/B**，它**不会**改变这个固定基线；(7) COM 提权 **`Elevation\Enabled` = REG_DWORD `1`**（非字符串 `'Enabled'`），**移除 `ThreadingModel`**，**位数/WOW64 注册位置**通过 **`KEY_WOW64_64KEY`/`KEY_WOW64_32KEY` 标志**（amd64/arm64-only ⇒ **不注册 32 位 COM 辅助程序**）；**状态机 + 测试**随 **常驻活动**状态以及**应用/mihomo/辅助程序崩溃**、**同 PID 禁用**与**无旧创建者句柄**用例而扩展（round-5）；(8) **导出表 = 逐字 0.14.1 `Wintun_*_FUNC` 集合**，含 `WintunOpenAdapter`、`WintunGetRunningDriverVersion`、`WintunSetLogger`，以及已导出但被禁止的 `WintunDeleteDriver`；**添加构建时 dumpbin/GetProcAddress ABI 检查**；(9) **G1 仍是强制的预实现门槛**，现在作为 **G1 生命周期探测**，仅通过单独授权的 G1 工作流，在可快照的自托管 Windows 实验室（可快照、带外可恢复的 Windows VM）上运行，并需单独的所有者授权 — **绝不在本开发机上**。**已应用 round-6 安全阻塞项（rev.6）。** (a) COM ACL/SDDL 为**纯白名单**，带**显式 COM 权限掩码** — `LaunchPermission` `D:P(A;;0xB;;;SY)(A;;0xB;;;BA)(A;;0xB;;;<ownerSid>)`（`0xB` = EXECUTE|EXECUTE_LOCAL|ACTIVATE_LOCAL），`AccessPermission` `D:P(A;;0x3;;;SY)(A;;0x3;;;<ownerSid>)`（`0x3` = EXECUTE|EXECUTE_LOCAL）；**无** `DENY Everyone`/`DENY built-in Users`，**无** `Everyone`/`Users`/`Authenticated Users`，且**完全没有 `DENY`**（完整白名单按缺失进行拒绝）；一个**按 ACE 的表**（对象 SID / 允许-拒绝 / COM 权限掩码）与**`AccessCheck` + 描述符构建验证**（设计文档 §5.1，测试 `T24`、`T32`–`T40`）。 (b) **可信恢复状态**位于 `%ProgramData%\<brand-independent-id>\tun-state\<ownerSid>\`（设计文档 §8.0）：由**提权辅助程序**创建，所有者 = SYSTEM，**可解析的纯白名单 SDDL** `O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)` + `S:(ML;OICI;NW;;;HI)`（**无所有者 SID 文件 ACE** — Medium 表面无原始读取；辅助程序经 `BA` 到达它，因为它作为管理员提权运行，且 Medium 令牌具有 `BA` deny-only 与无所有者 ACE），**`High` 强制完整性标签**（`NO_WRITE_UP`，`HI` = `S-1-16-12288`）— 真正的同用户边界，因为辅助程序与 Medium UI 共享一个 SID，而 DACL + 缺失的所有者 ACE 将二者分开；所有者 UI 仅通过辅助程序 COM 读取**脱敏**状态（绝不读取原始基线/日志）；每个文件以 `FILE_FLAG_OPEN_REPARSE_POINT` + 拒绝重解析点 + 持有句柄 `FileIdInfo` 重新验证 + 临时/`FlushFileBuffers`/`ReplaceFile` 原子重命名打开；**绝不**跟随用户可控路径；升级/卸载保留该目录直到安全恢复完成。 (c) **完整性是确定性的**（C12）：边界是 **DACL + 完整性标签**（Medium 无法写入存储），而非同用户攻击者可重写的摘要；记录仍携带 `schemaVersion` + SHA-256 以检测**损坏**；先前的**“HMAC/摘要或至少摘要”声明已移除**（无虚假保证）。 (d) **WAL 抵御目录替换**（设计文档 §8.0/§8.3）：启动时校验目录所有者/DACL/重解析；在每次 `PREPARED`/`APPLIED`/`RECONCILED` 追加前重新验证已打开句柄的文件 ID（无字符串路径重新打开）；任何异常 ⇒ **零网络变更** + `restore-failed`（测试 `T25`–`T30`，安装文档 round-6 测试）。**已应用 round-8 描述符 API/持久化与受限令牌修正（rev.8）— 请求重新评审。** **实现门槛仍未满足**（仍需设计评审签核 + 单独所有者授权，外加 G1（未证明；探测将记录 Observed A/B）与证书提供者决定）。

- [~] 编写并批准辅助程序/特权威胁模型。（草稿 → `docs/helper-threat-model.md`；按 **round-3** + **round-4** 评审项修订：设备模型 = 驱动在 `WintunCreateAdapter(Name, TunnelType, RequestedGUID)` 内安装/加载，无单独加载步骤；C3 重写为 **COM 提权 moniker** 引导，带 `CoGetObject("Elevation:Administrator!new:{CLSID}")` + `Elevation\Enabled = REG_DWORD 1`（无 `ThreadingModel`），`RunAs = "Interactive User"`，`ClientPID` + `RPC_QUERY_CLIENT_PID` + 仅 `ncalrpc`，以及**每次启用、单客户端的常驻服务器**（进程生命周期绑定到启用的 TUN 窗口，在整窗口持有创建者句柄；round-5）；C4 更新为**预写**日志（CREATE_ADAPTER/PREPARED 在创建前 fsync，通过 `WintunOpenAdapter(Name)` + 身份对 PREPARED-but-unknown 对账）；C5 更新为真实 0.14.1 生命周期 — 适配器**仅**由 `WintunCloseAdapter(creatorHandle)` 移除，无 `WintunDeleteAdapter`/`RebootRequired`/`delete-pending`，`WintunDeleteDriver` 绝不调用；单一 OS 配置所有者 D6（选项 A）；G1 概述为未证明的 **G1 生命周期探测**（Observed A/B；常驻基线已固定））；**round-6**：C12 重写为**确定性完整性契约**（存储 DACL + `High` 强制标签是边界 — 同用户 Medium 攻击者无法写入存储，只有 High 辅助程序可；`schemaVersion`+SHA-256 仅检测损坏；先前的**“HMAC/摘要或至少摘要”声明已移除**；篡改/损坏 ⇒ 失效关闭），且 C2/C3 协调为**纯白名单** DACL 与**显式 COM 权限掩码** `D:P(A;;0xB;;;SY)(A;;0xB;;;BA)`（启动）/ `D:P(A;;0x3;;;SY)(A;;0x3;;;<ownerSid>)`（访问），**无** `DENY Everyone`/`DENY Users`，无 Everyone/Users/AuthUsers，且**完全无 `DENY`**（按缺失拒绝），`AccessCheck` 验证；待批准）
- [~] 定义安装、升级、回滚与卸载行为。（草稿 → `docs/helper-install-upgrade-rollback.md`；按 **round-3** + **round-4** 评审项修订：适配器/驱动在首次启用时经校正的 `WintunCreateAdapter(...RequestedGUID)` ABI 创建，无 `load_driver` 操作；**预写**启用顺序（PREPARED→APPLIED）；**禁用经 `WintunCloseAdapter` 关闭创建者句柄**（唯一移除路径）— 无 `DELETE_ADAPTER`/`WintunDeleteAdapter`/`RebootRequired`/`delete-pending`；mihomo 不添加路由/DNS；卸载绝不移除已发布/已有驱动**或已有适配器**；扩展测试图（**G1 生命周期探测**、第二个 Murge 实例竞争、WAL 崩溃边界、创建者句柄关闭移除））；**round-6**：**可信状态存储**（`%ProgramData%\<id>\tun-state\<ownerSid>\`）由提权辅助程序在首次启用时创建/校验，且存储**在升级/卸载期间保留**，直到安全恢复完成；**描述符构建**测试（`ConvertStringSecurityDescriptorToSecurityDescriptor` 已返回 `SE_SELF_RELATIVE`；仅 COM 的 `REG_BINARY` 字节往返；状态目录经文件系统安全 API 应用/读回；`AccessCheck` 启动与访问所有者=allow / 第二用户=deny / SYSTEM=allow；COM 掩码相等 `0xB`/`0x3` + `0x1`；状态目录 `High` `NO_WRITE_UP` 标签；Medium 写失败/High 受限辅助程序配合启用非仅拒绝的 `BA` 成功）以及 COM `AccessCheck`、状态存储所有者/DACL/重解析、WAL 句柄文件 ID 重新验证、日志 schema/摘要异常、Medium-vs-High MIC 阻塞与卸载保留存储测试均已添加；待批准）
- [~] 设计评审包。（草稿 → `docs/helper-design.md`：共享 TUN 契约、§3.0 **固定 Wintun 0.14.1 ABI** = 逐字 `Wintun_*_FUNC` 集合含 `WintunOpenAdapter`/`WintunCloseAdapter`/`WintunDeleteDriver`(禁止)/`WintunGetRunningDriverVersion`/`WintunSetLogger`，+ **构建时 dumpbin/GetProcAddress ABI 检查**；**无 `WintunDeleteAdapter`/`WintunFreeSendPacket`**）、§3.2 以 `RequestedGUID` 身份创建、§3.3 **创建者句柄生命周期 + G1 生命周期探测**（Observed A/B；固定基线 = 辅助程序在全启用窗口持有创建者句柄）+ 新 §3.4 **常驻活动生命周期 / 紧急恢复 / 辅助程序崩溃恢复**、§5.1 提权 moniker 注册（`Elevation\Enabled=REG_DWORD 1`，无 `ThreadingModel`，经 `KEY_WOW64_*KEY` 标志实现 WOW64（amd64/arm64-only ⇒ **无 32 位 COM 辅助程序**））、§5.5 **每次启用、单客户端的常驻服务器**（详尽 5 退出条件列表，无空闲退出；round-5）、**预写日志** + 通过 `WintunOpenAdapter(Name)` + 身份对 PREPARED-but-unknown 对账（§8.3–§8.5）、单一 OS 配置所有者 `DesiredNetworkState`、固定类型、统一 TUN 状态机、配置门控设计、renderer 仅意图契约、模块布局、扩展测试/证据矩阵（**G1 生命周期探测**、第二实例竞争、WAL 边界、`CLOSE_CREATOR_HANDLE` 移除）；D4 已解决不自动启动；D5 已解决绝不移除已有/共享；G1 + 证书提供者仍开放 — **实现门槛未满足**）；**round-6**：§5.1 重写为**纯白名单** COM ACL/SDDL 与**显式 COM 权限掩码**（`LaunchPermission` `D:P(A;;0xB;;;SY)(A;;0xB;;;BA)(A;;0xB;;;<ownerSid>)`，`AccessPermission` `D:P(A;;0x3;;;SY)(A;;0x3;;;<ownerSid>)`，**无** `DENY`）+ **按 ACE 的表**，带**`AccessCheck` + 描述符构建**验证（测试 `T24`、`T32`–`T40`）；新 §8.0 **可信状态存储、完整性与 WAL 目录防御** — `%ProgramData%\<id>\tun-state\<ownerSid>\` 存储（所有者 SYSTEM、纯白名单 DACL、**`High` 强制标签** = 真正的同用户边界、仅脱敏辅助程序 COM 读取、`FILE_FLAG_OPEN_REPARSE_POINT` + 拒绝重解析点 + 持有句柄 `FileIdInfo` 重新验证 + 临时/`FlushFileBuffers`/`ReplaceFile` 原子重命名、绝不跟随用户路径、升级/卸载保留）以及**确定性完整性契约**（DACL/完整性标签为主；`schemaVersion`+SHA-256 仅用于损坏；**HMAC 语言已移除**；失效关闭 `restore-failed`）；§8.3 WAL 现**抵御目录替换**；§13 以 round-6 测试 **T24–T31** 与 round-8 校正测试 **T32–T40** 扩展（`ConvertString…` 返回形式校验；仅 COM 的 `REG_BINARY` 往返；文件系统安全状态目录读回；AccessCheck 矩阵含 SYSTEM on Access；COM 掩码；`High` 标签；Medium 拒绝/High 受限辅助程序配合启用非仅拒绝的 `BA` 允许）。**实现门槛仍未满足**（需设计评审签核 + 单独所有者授权；G1（Observed A/B 待定）与证书提供者仍开放）。）
- [x] 仅实现**非网络的 Phase 9 基础契约**：共享 `TunPhase`/`TunStatus`/`DesiredNetworkState` + 运行时 schema；纯函数化评审的迁移函数；精确的 SDDL 源契约构建器；有界的仅机器码内存审计日志；保留的类型化 IPC 名称 + 类型化 TUN 协议错误；单元/静态测试证明这些模块不含进程派生、Wintun、COM 提权、网络或 OS 变更调用。这**不**满足或绕过实现门槛；保留的 IPC 名称有意不注册进 Electron handlers/preload。
- [x] 实现**非传输的辅助程序封套安全层**：固定操作白名单、精确封套字段、4 KiB 规范排序键 JSON 负载、带 8 字节大端 uint64 请求 ID 的长度前缀 HMAC-SHA256、严格单调重放拒绝、HKDF 角色分离与启动/会话密钥清零。每个操作都有严格负载 schema：五个读取/恢复意图仅接受 `null`，适配器创建/关闭仅接受规范身份字段，而 `apply_network_state` 复用严格的 `DesiredNetworkState` schema；任意路径、命令与未知键在重放状态前进前被拒绝。它仅是内存中的协议原语：无 COM 传输、辅助程序命令实现、renderer 桥或 OS 变更。
- [x] 强化纯 `DesiredNetworkState` 所有权不变量：拒绝适配器身份中的控制字符、精确重复路由、重复 DNS/度量 LUID 目标、重复 DNS 服务器，以及单个意图针对多个适配器 LUID。这在特权适配器存在前防止模糊的应用/回滚所有权；不涉及任何 OS API。
- [x] 固定并审计官方 **Wintun 0.14.1 SDK 而不创建适配器**：记录官方归档/头文件/amd64/arm64 DLL SHA-256 值；Windows 托管的只读任务下载并验证该发行版，直接针对已验证的官方 `wintun.h` 编译 `native/wintun-abi-audit/abi-audit.cpp`，检查原生布局/调用约定类型，并解析每个预期导出而不调用任何 Wintun 函数。这取代了把清单称为未填充的较早脚手架措辞；它不提供 G1 绑定，也不满足执行门槛。
- [x] 解决 **D4/D5** 并搭建**不可执行的 G1 门槛**：辅助程序不自动启动；绝不删除已有/共享的 Wintun 驱动或适配器；手动工作流需要精确确认、授权/资产/快照/恢复标识符、受保护的 `phase9-tun-lab` 批准以及 `murge-tun-lab` 自托管 Windows 运行器。已检入的门槛支持 `--validate-only`，发出 `probeExecuted:false`，并拒绝每个执行模式；它不执行任何 Wintun/网络操作。
- [x] 实现 **G1 探测执行体 + 测试框架**（脚手架**已完成，未执行**）。纯步骤 a–j 编排器（`src/main/tun/g1-probe.ts`）驱动一个**注入的驱动器**；**真实驱动器**（`src/main/tun/g1-driver.ts`）失效关闭为 `unsupported` — 固定的 Wintun 清单摘要有意**未填充**且**无捆绑原生绑定**，因此绝不加载 Wintun DLL，绝不派生 mihomo；一个独立的门控 `--execute-g1-probe` 入口（`src/main/tun/g1-probe-runner.ts`）加一个拒绝执行的**仅验证**工作流；以及针对**伪驱动器**的纯单元测试，覆盖每个硬门槛拒绝、a–j 生命周期、**严格的 Name+GUID+LUID 身份匹配清理规则**，以及每个 a–j 故障边界（每个均触发 finally 清理）。**G1 仍未执行且未证明**，且**实现门槛未满足**：探测从未在真实 Windows 实验室运行，固定摘要未填充，且无原生集成。真实探测**未接入**应用外壳、preload 或 IPC 层，且默认 `npm test`/`npm run build` 绝不加载 DLL、派生 mihomo 或触碰路由/DNS/系统代理/防火墙。**实现重新评审 round-1（进行中）：** G1 执行骨架按 round-1 评审者的 6 个 P1 项 + 一组额外修复重做 — 校正观测顺序（Observed B 仅在创建者句柄关闭且 mihomo 会话仍活动时才有效）；精确创建者句柄生命周期（句柄是不透明原生指针；`WintunCloseAdapter` 始终传入 `WintunCreateAdapter` 返回的*精确*句柄，至多关闭一次，成功关闭后立即清除）；移除错误的 **“TS 类型 = 逐字 ABI”** 契约（官方 `wintun.h` 已固定；`HANDLE`/`NET_LUID`/`GUID`/`WINAPI` 仅在 C/C++/Rust 原生边界处理；TS 暴露高层不透明接口；原生编译期签名/导出符号检查；在真实绑定落地前保留 `unsupported`）；mihomo 探测配置（官方 `auto-route:false`/`auto-detect-interface:false`/`strict-route:false`/`device:<probe adapter>`/`dns.enable:false`/`allow-lan:false`，无无效顶层 `inbound`；配置在 mihomo 启动前经仓库 mihomo 配置验证器 + 严格 G1 验证器 + 解析回字段断言生成 → 验证；`device` 仅命名 NIC，**不**证明复用辅助程序 Wintun 实例，因此 **G1 仍未证明**）；`finally` 必须独立停止 mihomo（有界优雅停止，然后终止精确记录的 PID / ChildProcess，等待 + 验证退出，然后读取创建者句柄的实时身份并仅在严格匹配时关闭精确句柄）；创建前的**冲突预检**（只读枚举同名适配器、相同 RequestedGUID、探测名前缀、上一轮遗留探测资源；任何命中则以零变更退出并记录冲突）；编排器控制的每步超时；证据仅写入经验证的专用证据目录并独占创建，拒绝重解析/符号链接、绝对路径逃逸与覆盖；异常证据保留已验证的 DLL 摘要；准确错误码映射（`unsupported`/`timeout`/`identity-conflict`）；对读取/差异/清理网络步骤的故障注入；以及独立运行器仅暴露导出函数，无真实 CLI 引导。**未运行任何真实 Wintun/mihomo TUN/路由/DNS** — 在此重做中 G1 仍为未执行/未证明，**实现门槛未满足**。
  - Round-3 本地加固：副作用操作绝不在任意取消宽限期后就被弃置；迟到的原生句柄/进程必须在探测返回前稳定并被回收。Mihomo 停止拥有完整优雅 → 强制 → 存活验证预算，在未确认退出时保留其精确进程引用，且可由 `finally` 重试。证据限定为专用目录的直接子项，以模式 `0600` 独占打开，且仅在重新验证已打开文件的父目录身份后写入。这仍仅为脚手架，不改变未执行/未证明门槛。

**实现重新评审 round-2（进行中）：** 按 round-2 评审者的 5 P1 + 2 P2 项 — `runStep` 超时现取消底层操作并回收迟到的资源（无残留适配器/mihomo，添加迟成功测试）；来自*本次*调用的 OWNED `WintunCreateAdapter` 创建者句柄在 `finally` 中无条件（一次）关闭，严格的身份匹配 `cleanupAllowed` 规则仅应用于回收/枚举/伙伴资源，另加 `readAdapterIdentity` 抛出/超时无残留测试；尊重 `stopMihomoProbe` 的结果（仅在确认退出时为 true：SIGTERM→SIGKILL→有界等待→验证，错误≠停止，定时器/监听器清除，编排器绝不在 false 上标记已停止）并带 SIGTERM 无效/ SIGKILL 无效/错误但存活测试；在整个真值组合表上将非法观测组合记录为 `observed=null`/`g1-failed`；`resolveSafeEvidencePath` 不再使用 `baseReal!==base` 字符串相等作为重解析标准（它仅为包含关系规范化真实基址 — 在 macOS 临时目录与 Windows 大小写/短路径/规范化差异上假阳性），保留独占创建并在写入前立即重新验证父真实路径（validate-vs-write TOCTOU）；mihomo 配置门控将 `FakeConfigValidator` 仅视为廉价结构性预检 — 在任何真实执行（P2-7）前需要对同一二进制 + 字节一致启动文件的真实 `mihomo -t`。**任何轮次都未运行真实 Wintun/mihomo TUN/路由/DNS — G1 仍为未执行/未证明，实现门槛未满足。**
- [~] 实现显式提权流程。（注入的、串行的 `TunElevationFlow` 现在强制先完整性再提示、显式连接意图、一个自有的活动会话、UAC 拒绝状态、独立于 renderer 的拆除、存活确认以及在辅助程序仍存活时的重试。生产 `GatedTunElevationActivator` 不执行任何 COM 调用；原生 `CoGetObject`/注册/握手仍被门控，等待 G1 与设计批准。）
- [~] 验证驱动/辅助程序签名与二进制完整性。（只读的、注入的 `TunBinaryIntegrityVerifier` 现先在检查前验证完整的双条目清单，为辅助程序/Wintun 固定规范路径 + SHA-256，要求辅助程序的真实 Authenticode + 已配置发布者指纹，并保持生产检查器失效关闭。真实的 `WinVerifyTrust` 检查器、发行辅助程序摘要与发布者指纹仍被门控/由所有者提供；不加载任何 DLL。）
- [~] 实现 TUN 已配置/启动中/活动/失败状态与恢复状态（正在恢复 / 恢复失败 / 冲突 / 不支持）。（串行的、独立于 renderer 的 `TunCoordinator` 与伪驱动状态/恢复测试已完成。特权适配器仍失效关闭且未接线，等待 G1。）
- [~] 添加独立于 GUI 的紧急禁用与清理路径。（`TunCoordinator.emergencyDisable()` 是幂等的、串行的且在 `restore-failed` 后可重试；真实辅助程序/OS 清理适配器与恢复 CLI 仍被门控，等待 G1。）
- [ ] 测试 DNS、IPv4、IPv6、睡眠/唤醒、网络变更与崩溃恢复。
- [ ] 记录服务、路由、DNS 与非代理感知请求证据。

退出标准：

- 透明捕获在不失去 VM 连接的情况下得到证明。
- 禁用/卸载将路由与 DNS 恢复为精确的先前状态。
- 在强制进程终止后恢复可用。

## Phase 10 — 桌面产品特性

环境：Mac 用于模拟 UI；Windows VM 用于 OS 行为。

进入门槛：相关的前置服务阶段完成。

- [~] 系统托盘菜单与状态同步。（主进程 `TrayController` 已实现并接线：显示/聚焦、验证内核阶段、串行启动/停止、退出、关闭到托盘与幂等拆除。它消费有序内核网关，因此托盘停止保持 Phase 8 代理先于内核的安全排序且绝不乐观切换。Electron 适配器与打包图标已包含；控制器行为经单元测试。打包的 `--hidden`/原生 `Tray` 探测现位于手动 `windows-gui-smoke` 工作流，需交互式自托管 Windows 运行器；它尚未仅由托管打包任务证明。最终通知区域渲染与 Explorer 重启恢复在 Windows VM/物理机上仍待定。）
- [~] 显式用户选择时开机自启。（一个串行 `StartupService`、严格布尔 IPC、preload API 与 Settings → 通用开关已实现。默认路径只读，绝不写入；只有显式用户切换才调用 OS 适配器，随后读后写确认并显示分歧/错误，无乐观 UI。Windows 登录以 `--hidden` 启动，仅创建托盘/UI 进程 — 绝不创建内核、代理或 TUN；已安装产物的 `--hidden-smoke` 路径保留在手动交互式 `windows-gui-smoke` 工作流中，不改变登录注册。非 Windows 失效关闭为不支持。单元覆盖证明默认关闭/不写、显式启用、分歧与不支持行为；最终真实工作流加登出/登入 Task Manager 生命周期证据仍待定。）
- [x] 连接详情与关闭操作。（Activity 的实时连接卡片打开一个专门的、可搜索的主/详视图，由现有共享 `/connections` 传输支撑。关闭请求在飞行中先于完成去重，且绝不乐观处理：存储重新读取 `/connections`，仅当目标 ID 不存在时报告成功；控制器分歧与类型化失败保持可见且可重试。存储测试覆盖过滤/选择、确认关闭、分歧与并发重复意图。）
- [x] 进程/设备详情面板。（先前的固定示例现聚合并共享实时 `/connections` 快照。进程身份使用名称 + 路径；设备身份如实使用报告的源 IP，不虚构 DHCP 主机名。两页均提供稳定流量/名称排序、选择、上/下传总量、活动连接数、目标/进程详情与显式空/加载状态；纯测试覆盖聚合与排名。）
- [x] 日志查看器、过滤、导出与脱敏。（一个受限的 2,000 条 Pinia 存储消费现有共享 `/logs` 数据流，暴露连接/错误状态与级别/文本过滤，且仅 renderer 的导出路径在文件边界重新应用凭据脱敏。此页经 Settings → Logs 到达，因此固定高度的 934×672 侧栏几何不变。单元测试覆盖 bearer/basic 凭据、URL user-info、敏感查询/赋值值、规范化与导出时纵深防御。）
- [x] DNS 诊断与缓存操作。（严格的 hostname/query-type IPC 验证驱动文档化的 `/dns/query` 端点；上游响应经运行时验证。DNS 与 Fake-IP 刷新使用其专用 204 端点，无乐观状态地暴露确认成功/失败，并由客户端/IPC/模拟测试覆盖。）
- [x] 主题、减少动画、键盘导航与高对比度。（Settings → 外观提供系统/浅色/深色选择、显式高对比度与减少动画偏好，并做严格版本化本地解析。系统主题变更保持实时；显式选择稳定。全局 `:focus-visible` 样式覆盖原生控件、链接与交互卡片，Space/Enter 激活 Activity 连接卡片，且显式偏好与 OS `prefers-reduced-motion` 均禁用非必要动画。契约测试覆盖畸形持久化值与主题解析。）
- [x] 针对冻结 RC 表面的可访问性契约审查。（支持的表单字段有独立于占位符的可访问名称；动态错误/状态使用 alert/live 语义；进程/设备选择暴露按下状态；静态分段控件暴露其选中状态；禁用的占位控件有标签。这些仅语义的变更保留已批准几何。最终屏幕阅读器与 Windows 高对比度人工验证仍是 RC 验收的一部分。）
- [x] 关于、诊断包与支持链接。（品牌配置的 HTTPS 仓库/支持链接、打包应用/平台元数据与显式白名单诊断序列化器已实现。该包有意排除控制器 URL、配置、路径、日志、原始错误与网络地址；测试注入代表性密钥并证明它们不存在。）
- [x] 带签名与回滚的应用更新设计。（`docs/application-update-design.md`：签名的按机器 NSIS、元数据 SHA-512 + Authenticode 发布者验证、显式/手动生命周期、网络拆除门槛、向前版本回滚发行版与 Windows 证据矩阵。运行时更新器被禁用，等待所有者渠道/签名决定。）
- [x] 带固定渠道、校验和与回滚的内核更新设计。（`docs/kernel-update-design.md`：无 `/upgrade`；签名的规范清单、白名单起始源、SHA-256、服务端重新验证、不可变的当前/上一槽、仅回环验证与失效关闭回滚。运行时更新器被禁用，等待所有者渠道/签名密钥决定。）

退出标准：

- 每个切换都反映验证过的运行时状态。
- 可访问性评审通过。
- 诊断包不含机密。

## Phase 11 — 发布候选

环境：仅干净的 Windows VM 与指定的物理测试机。

进入门槛：所有者选择发布范围与许可证；所有包含的阶段完成。

- [x] 冻结支持的特性列表并显式隐藏不支持的类 Surge 页面。（`docs/RELEASE_SCOPE.md` 冻结 x64 RC 范围；`src/shared/release-scope.ts` 是可执行白名单。TUN、捕获、HTTPS 解密、改写、Panel、LAN 接管与自动更新不在导航/直接路由中；静态测试防止其意外回归。）
- [~] 运行干净安装、升级与卸载矩阵。（托管 CI 练习干净 x64 安装、静态 ASAR/资源验证、服务生命周期与卸载，不改变系统代理基线。打包的 Electron/preload/tray/可见窗口执行分离到手动 `windows-gui-smoke` 工作流，等待交互式自托管 Windows 运行。`.github/workflows/rc-upgrade-matrix.yml` 加门控的、有界的 `scripts/rc-upgrade-matrix.ps1` 实现 N-1 → 所有者批准的未签名 RC → 卸载，并带校验和、配置保留与无 mihomo 断言；它仍需要两个不可变发布标签与干净的 Windows 运行。）
- [~] 运行系统代理与可选 TUN 恢复矩阵。（真实 Windows 系统代理启用/精确恢复、自有代理卸载恢复与强制所有者崩溃恢复在 CI 中运行。TUN 从本 RC 中明确排除；最终证据必须针对不可变 RC 标签捕获。）
- [~] 验证无配置与无效配置的首次启动行为。（仓库/服务测试证明空目录是有效的零配置状态、不可读元数据/陈旧激活被忽略，且无效 YAML 导入/激活不创建或替换活动配置文件。打包的普通启动可见性与空闲行为移至手动交互式 `windows-gui-smoke` 工作流，等待合格的 Windows 运行。）
- [x] 完成第三方声明与源代码提供义务。（`LICENSE.txt`、`THIRD_PARTY_NOTICES.md`、每个保留的运行时/Go 许可证与 `SOURCE_CODE.md` 是安装器资源；测试固定精确的 Murge 仓库与捆绑 mihomo v1.19.30 源链接。）
- [x] 决定并执行发布签名策略。（所有者明确选择不购买证书。标签构建禁用证书发现，要求每个发布所有的安装器/应用/服务可执行文件报告 Authenticode `NotSigned`，并在不可变发布证据与说明中记录 `not-signed-owner-approved` 及预期的 Unknown 发布者警告。）
- [x] 发布校验和与可复现发布说明。（`release-notes:generate` 确定性渲染已提交模板；标签工作流发出 SHA256SUMS 加不可变标签/SHA/范围/签名证据 JSON，并附加到草稿。）
- [x] 准备回滚发布与紧急网络恢复指示。（`docs/application-update-design.md` 使用向前版本回滚发布；`docs/NETWORK_RECOVERY.md` 记录独立于 renderer 的自有代理恢复命令、冲突行为与重装以恢复路径。TUN 指示有意缺失，因为 TUN 被排除。）
- [ ] 所有者批准最终 934×672 截图。

退出标准：

- 没有关键恢复、凭据、签名或许可证问题残留。
- 发布证据附加到版本标签。
- 发布获得所有者的最终显式确认。

## Phase 12 — 配置增强与 Clash 特性对等

环境：Mac/CI 用于纯配置与模拟 UI；隔离 Windows 仅供
系统代理、PAC、UWP、TUN、路由或 DNS 变更证据。

参考审计：`docs/CLASH_PARTY_FEATURE_AUDIT.md`。

进入门槛：Phase 11 发布范围保持稳定。新控件不得使
已排除或未证明的特性在现有发布中看似受支持。

- [x] 实现带全局/配置范围的版本化声明式 YAML 覆盖，
      确定性排序、显式序列操作与原子存储。
      （在 `v0.1.13` 交付：`OverrideService` 经临时文件+重命名原子写入与串行队列持久化到 `overrides.json`；
      全局 + 每配置范围由 `effectiveOverrides(profileId)` 选择；排序遵循
      存储列表；`+key`（前插）/ `key+`（追加）序列操作由
      `apply-overrides.ts` 解析。JS `main(config)` 覆盖也在密封的 `node:vm`
      沙箱中以 2 秒超时受支持，按项失效打开。覆盖管道在生产
      `resolveActiveDocument` 内运行，且总是跟随后续现有安全通过，
      因此覆盖无法绕过仅回环不变量。）
- [x] 添加脱敏预览/差异、结构与语义验证、安全字段
      所有权与上次良好回滚。（在 `v0.1.25` 交付：
      `OverrideService` 获得 `preview()`（脱敏基础 + 应用文本）、
      `validate()`（按项 YAML/JS 结构检查加一个检查链中
      覆盖未破坏先前有效基址的全链检查），与
      `lastKnownGood()` / `resetToLastGood()` 回滚的快照，
      在有效集产生结构上有效的运行时配置时捕获。行级 `diffLines()`
      与 `redactOverrideContent()` 位于 `@shared/overrides`，经 IPC 暴露，
      由 `OverridesPanel.vue`（校验/预演/回滚到最后可用）驱动。安全字段所有权由
      `tests/override-preview.test.ts` 重新证明：注入
      `tun`/`listeners`/`redir-port`/`tproxy-port`/`dns.listen` 与公共
      `external-controller`/`mixed-port`/`allow-lan`/`bind-address`/`secret` 的恶意覆盖
      被 `buildProfileKernelConfig` 中和。）
- [x] 在主进程契约与仓库测试通过后添加 Vue/Pinia 覆盖管理器。
      （`src/renderer/src/stores/overrides.ts` +
      嵌入 Config 页的 `OverridesPanel.vue`；按项启用、重排、
      编辑、删除与全局/当前订阅范围选择器。契约由
      `tests/apply-overrides.test.ts`、`tests/override-service.test.ts`
      与 `tests/handlers.test.ts` 中的覆盖 IPC 用例覆盖。）
- [x] 通过覆盖管道实现完整的类型化 DNS 增强模型：
      启用、增强模式（`fake-ip`/`redir-host`/`normal`）、fake-IP
      范围/过滤/过滤模式、IPv6、respect-rules、hosts/use-hosts、
      默认/代理/直接 nameserver、nameserver/fallback 与
      nameserver-policy。验证每个服务器 URI、域名、IP 与 CIDR；提供
      预览与上次良好回滚。不改变源配置。
      （在 `v0.1.14` 交付：`src/shared/dns.ts` 中的 `DnsEnhancement` 是严格的、
      zod 验证模型；每个服务器方案、IP、主机名、域名模式与 CIDR 在持久化或
      物化前验证。`DnsEnhancementService` 原子持久化到应用数据根中的
      `dns-enhancement.json`，且 `applyDnsEnhancementToDocument` 在生产
      `resolveActiveDocument` 管道中立即于有序覆盖之后、安全通过之前运行，
      因此生成的 `dns:` 块被合并覆盖到配置上，绝不改变订阅源。模型不拥有的
      列表键（如 `fallback-filter`）被保留。renderer 在 Config 页将其作为带脱敏 YAML
      预览的 `DnsSettingsPanel` 暴露；`src/main/index.ts` 将具体服务接线
      为 IPC 网关并接入管道。）
- [ ] 通过同一管道实现完整的类型化嗅探器增强模型：
      启用、override-destination、force-dns-mapping、parse-pure-ip、
      HTTP/TLS/QUIC 端口范围、skip-domain、force-domain、skip-src-address 与
      skip-dst-address。在物化前验证端口、域名与 CIDR。
      （在 `v0.1.15` 交付：`src/shared/sniffer.ts` 中的 `SnifferEnhancement` 是严格的、
      zod 验证模型；每个端口令牌（单个/范围/`*`）、域名模式与 IPv4/IPv6 CIDR 在持久化或
      物化前验证，复用提取到 `src/shared/net.ts` 的共享网络验证器。
      `SnifferEnhancementService` 原子持久化到应用数据根中的
      `sniffer-enhancement.json`，且 `applySnifferEnhancementToDocument` 在生产
      `resolveActiveDocument` 管道中立即于有序覆盖与 DNS 增强之后、安全通过之前运行，
      因此生成的 `sniffer:` 块被合并覆盖到配置上，绝不改变订阅源。
      `sniffer` 不在安全通过删除列表中，因此该块能存活
      `buildProfileKernelConfig`。模型不拥有的列表键（如 `port-black-list`）被保留。
      renderer 在 Config 页将其作为带 YAML 预览的 `SnifferSettingsPanel` 暴露；
      `src/main/index.ts` 将具体服务接线为 IPC 网关并接入管道。）
- [x] 实现完整的 TUN 配置模型与 Vue 状态/设置 UI：
      stack、device/adapter 身份、MTU、strict-route、auto-route、
      auto-detect-interface、DNS hijack、route-address、
      route-exclude-address 与其他受显式支持的 mihomo 字段。
      通过现有 Windows 服务、命名管道契约、协调器与回滚状态路由每个特权操作；
      绝不提权 Electron renderer 或让订阅 YAML 取得所有权。
      （在 `v0.1.16` 交付，**仅配置模型 + 配置设置 UI**，
      标记 `implementation-complete / runtime-unverified`：`src/shared/tun-config.ts` 中的 `TunConfigModel`
      是严格的、zod 验证模型；stack 枚举、设备身份、MTU 范围、每个 dns-hijack host:port
      条目与 IPv4/IPv6 路由 CIDR 在持久化或引导物化前验证。
      `TunConfigService` 原子持久化到应用数据根中的 `tun-config.json`，
      并在 `src/main/index.ts` 中接线为 IPC 网关与 mihomo 自有适配器的
      `readTunConfig` 源，因此该模型仅在自有引导中并入 `generateMihomoTunConfig` —
      `buildProfileKernelConfig` 仍丢弃 `tun`，故模型绝不改变订阅配置。
      renderer 在 Config 页将其作为带 YAML 预览的 `TunConfigPanel` 暴露。
      **TUN 生命周期/状态 UI 是下一个条目。** 因为 TUN 直到精确恢复
      与恢复证据通过前不受发布支持，这**不是**发布 TUN 启用。）
- [x] 为报告的阶段集完成 TUN 生命周期/错误 UI（已配置/
      不支持/不支持不支持、启动中/活动、恢复中、失败、
      恢复失败与冲突），含重试与独立于 renderer 的紧急禁用。
      （Config 页上的 `TunLifecyclePanel` 通过 `TUN_UI_COPY` 渲染阶段，
      暴露 `errorMessage`/`conflictDetail`，并从纯 `tun-lifecycle` 辅助函数派生启用/禁用门控 — 仅从
      `已配置`/`失败`（重试）启用，在 TUN 拥有网络或处于回滚中时
      禁用/恢复，且在 `unsupported` 或操作在飞行中时两者都保留。
      `tun` Pinia 存储经 `tun:status-event` 与 `connect`/`disconnect` 镜像协调器，
      并经 `toProtocolError` 捕获操作错误；renderer 绝不提权（禁用路由到协调器的
      `emergencyDisable`，其仍可不带 renderer 调用）。因为 IPC 处理器只暴露存在于
      `TunPhase` 枚举中的阶段，路线图先前的 `stopped`/`stopping` 措辞
      映射到 `configured`/暂停的协调器。**implementation-complete /
      runtime-unverified** — UI 在非 Windows/开发构建上渲染 `unsupported`，
      且不是发布 TUN 启用。）
- [x] 在真实机器验证前完成所有 DNS/sniffer/TUN schema、IPC/preload 网关、Pinia 存储、
      夹具、配置生成、解析回断言、单元测试与网络静默集成测试。
      （DNS / Sniffer / TUN 每个现都有 `@shared/schemas/ipc` 处的共享类型化模型 + 严格 zod schema、
      循环 IPC 门 + preload 块 + Pinia 存储 + Config 页面板、原子持久化服务、配置生成器
      （`buildDnsBlock`/`buildSnifferBlock`/`generateMihomoTunConfig`），与
      经 mihomo 验证器的解析回断言。先前**缺失的部分 — 网络静默集成测试** —
      作为 `tests/network-silent-config.integration.test.ts` 添加：它纯在内存中组合真实
      管道（活动配置 + 类型化 DNS 增强 + 类型化 Sniffer 增强 + `buildProfileKernelConfig` 安全边界）
      （绝不派生 mihomo / 绑定 / 变更路由/DNS/系统代理），且
      断言运行时配置仅回环（`allow-lan:false`、`bind-address:127.0.0.1`、回环控制器、
      无 `tun`/`listeners`/`redir-port`/`tproxy-port`，`dns.listen` 已剥离，无处绑定 `0.0.0.0`），
      并在经 `profileKernelConfigErrors` 时干净往返，同时保留模型的 DNS/Sniffer 值与仅配置键。）
- [x] 完成受控核心设置、geo 数据资源与代理绕过策略，带读回
      与冲突处理。
      （子功能 1/3 — 受控核心设置 — 已实现并测试：
      `CoreSettings` 模型在 `enabled` 时具权威性，白名单化的
      核心键覆盖配置所设置的（冲突处理），且运行时配置反映模型
      （读回），仅在配置支撑路径上，而禁用保留配置。在 v0.1.19 发布。）
      （子功能 2/3 — 受控 geo 数据设置 — 已实现并测试：
      `GeodataSettings` 模型在 `enabled` 时具权威性，白名单化键
      （`geodata-mode`/`geoip-mode`/`geo-auto-update`/`geo-update-interval`/可选 `geo-x-url`）
      覆盖配置的 geo 数据键（冲突处理），且运行时配置反映模型
      （读回）；空源 URL 保留配置的 geo 数据源，而非清空它。
      禁用保留配置。在 v0.1.20 发布。geo 数据*源注册表*（HTTPS 白名单、哈希、原子
      替换、手动刷新、有界调度）是单独的 P2 资源考量，且
      **不是**此受控设置模型的一部分。）
      （子功能 3/3 — 受控代理绕过策略 — 已实现并测试：
      `ProxyBypassPolicy` 模型在 `enabled` 时对写入的
      `ProxyOverride` 具权威性（强制本地/私网绕过条目
      与用户的 `customEntries` 合并，冲突处理），而禁用的策略保留 OS 现有绕过列表，
      绝不丢弃用户的条目（经 `proxyOverride` 状态字段读回）。
      在启用时编辑策略会以冲突 + 读回验证实时重新应用它，
      且启用前的 `ProxyOverride` 一直被逐字恢复（精确恢复），无论列表
      被编辑多少次。策略在生产中跨重启持久化。在 v0.1.21 发布。）
- [x] 增强实时连接的总量、确定性排序与确认批量关闭。
      （在 renderer 存储/页面实现，并经存储测试覆盖；批量操作复用按 ID 的控制器读回确认。）
- [x] 添加有界用量历史、网络元数据与只读拓扑，不持久化
      凭据或原始配置。
      （子功能 1/3 — 有界用量历史 — 已实现并测试：主进程
      将 `/traffic` 数据流记录进按小时字节桶数据库，
      上限 720 桶（≈30 天）并原子持久化；renderer
      读取 1h/24h/7d/30d 窗口化聚合与四个排名视图（下载 /
      上传 / 总量 / 计数）和有界容量页脚，且可显式
      清空数据库。仅存储聚合字节总量与采样计数 —
      无凭据、主机或原始配置。在 v0.1.22 发布。）
      （子功能 2/3 — 网络元数据 — 已实现并测试：主进程
      经内核的混合端口代理解析代理节点的公共出口地址，
      并从用户选择的隐私显式提供者（ipwho.is / ip-api.com /
      ipinfo.io）派生地理元数据（国家 / 城市 / ASN），
      仅保留以提供者为键且带新鲜度 TTL 的有界内存缓存。
      renderer 暴露显式状态（空闲 / 获取中 / 就绪 / 错误）、提供者选择器、
      隐私为前掩码 IP 揭示、复制操作与刷新操作；活动头读取此单一
      源。仅保留公共出口聚合元数据 — 无凭据、主机或原始配置。
      在 v0.1.23 发布。）
      （子功能 3/3 — 只读拓扑 — 完成；派生，标记不完整的 mihomo 数据。）
- [ ] 在 IPC 上保留结构化错误详情/操作。
- [ ] 将 DNS/sniffer/TUN 保持标记 `implementation-complete / runtime-unverified`，
      直到 Windows 证据矩阵通过；绝不将一个未执行的测试标记为
      通过，或静默回退到第二个所有权模型。
- [ ] 在启用受支持版本中的 PAC、UWP 或 TUN 控件前完成仅 Windows 的验收行。

退出标准：

- 订阅刷新与增强失败不能破坏用户覆盖或替换有效的运行配置。
- 每个可编辑字段都有类型化契约、验证、确认状态与恢复行为。
- 默认测试保持网络静默；Windows 变更测试保持单独授权与隔离。
- DNS、嗅探器与 TUN 可以在 Windows 测试前代码完成，但 TUN 在精确
  恢复与恢复证据通过前不受发布支持。

## 并行化规则

- 一个 AI 一次只负责一个阶段或一个明确有界的条目。
- 仅当 Phase 1 契约稳定后，Phase 4 与 Phase 5 才可并行。
- Phase 6 打包可与模拟 UI 工作并行，但绝不可发布产物。
- Phase 7–9 是顺序的，且绝不在当前 Mac 上运行。
- UI 贡献者可以使用夹具提前工作，但在其服务阶段通过前不能声明特性完成。

## 所有者决定积压

- [x] 选择应用开源许可证：GPL-3.0-only。
- [ ] 决定 Windows arm64 是否为首次发布所需。
- [ ] 决定 HTTPS 解密与改写页面是保持可见、实验性还是移除。
- [ ] 决定 TUN 是 v1 的一部分还是后续发布。
- [ ] 选择应用与内核更新渠道。
- [ ] 提供最终图标与品牌资产。
