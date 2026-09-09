# Murge Electron to Tauri Migration Plan

## Objective

Migrate the Windows desktop shell from Electron 44 to Tauri 2 without changing Murge's user-visible behavior, network semantics, persistent data, or security boundaries.

The target architecture is:

- Vue 3, Pinia, Vue Router, existing views and visual design remain the frontend.
- Tauri's Rust process replaces the Electron main process and preload.
- The existing LocalSystem Go TUN service remains the only privileged mihomo owner.
- Rust communicates with the Go service over the existing authenticated named-pipe protocol.
- The final product does not ship a Node sidecar.
- Electron remains buildable until the Tauri package passes the complete parity gate.

This branch starts from `v0.9.6` (`c0b0b5e`). Do not merge it into `main` until the definition of done at the end of this document is satisfied.

## Non-negotiable invariants

1. Murge continues to run exactly one mihomo process for system-proxy and TUN modes.
2. Switching system proxy and TUN remains an in-place hot transition; it must not create a second core or leave a dead proxy port.
3. The Go service keeps its LocalSystem identity, directory ACL and reparse-point protections, client executable digest pin, rolling-core trust catalog, job-object ownership, and fail-closed protocol validation.
4. The webview never receives unrestricted filesystem, shell, registry, process, or named-pipe access.
5. Every frontend argument is validated again by Rust. TypeScript types are not a security boundary.
6. Existing app data, profiles, DNS/sniffer/core/TUN settings, usage history, icon cache, log files, selected policies, Sub-Store data, and proxy backup remain readable after upgrade.
7. An upgrade, uninstall, crash, logoff, or failed migration must not leave Windows pointing at a dead system-proxy port.
8. Stable and specific mihomo versions remain immutable; preview and Smart remain digest-keyed rolling channels with current/previous fallback.
9. Product identity continues to come from `brand.config.json`; do not duplicate Murge names or identifiers in Rust.
10. Do not remove Electron code, Electron CI, or the Electron release path before installed Tauri parity is proven.

## Migration strategy

Use a strangler migration, not a rewrite in one commit. Keep the renderer-facing `window.desktop` contract stable and provide two implementations:

- Electron: the existing preload implementation.
- Tauri: a compatibility bridge backed by `invoke` and Tauri events.

Views and stores should not know which shell is running. New shell-specific code belongs behind adapters.

Each phase must leave the repository buildable and tested. Prefer small commits that complete one vertical slice. Record completed work and unresolved differences in the progress table below.

## Phase 0: Freeze the baseline

Deliverables:

- Record installer size, installed size, idle memory, cold start to visible window, cold start to tray, and time to a ready mixed port on x64 and arm64.
- Export an inventory mapping every `window.desktop` method/event and every IPC channel to its owning service and tests.
- Record the current app-data, executable, logs, working, kernel, Sub-Store, and service directories.
- Add a parity checklist for all tray commands, settings pages, headless commands, deep links, updater states, and shutdown paths.
- Preserve a passing baseline for TypeScript tests, Go tests, Windows packaging, real mihomo, system-proxy restore, TUN service install/uninstall, and interactive GUI smoke.

Exit gate:

- The inventory contains every current IPC method and event.
- Baseline measurements and CI run links are committed.
- No product behavior has changed.

## Phase 1: Establish migration boundaries

Split `src/main/index.ts` only as far as needed to expose shell boundaries. Do not redesign every domain service.

Suggested modules:

- `src/main/electron/bootstrap.ts`
- `src/main/electron/window-adapter.ts`
- `src/main/electron/lifecycle-adapter.ts`
- `src/main/electron/tray-adapter.ts`
- `src/main/electron/update-adapter.ts`
- `src/main/application/composition-root.ts`
- `src/renderer/src/platform/desktop-contract.ts`

Deliverables:

- One composition root owns service construction and startup order.
- Electron-specific APIs are isolated behind explicit adapters.
- Existing `window.desktop` signatures remain unchanged.
- Characterization tests lock down startup ordering, mode transitions, quit restoration, event delivery, and error mapping.

Exit gate:

- Electron passes all existing gates with no acceptance change.
- `src/main/index.ts` is a thin Electron entry point rather than the application implementation.

## Phase 2: Add a side-by-side Tauri shell

Create `src-tauri` and a second development/build entry without deleting Electron.

Deliverables:

- Tauri 2 Rust workspace and configuration.
- Windows x64 and arm64 build targets.
- Tauri window loads the existing Vite/Vue renderer.
- A startup bridge installs `window.desktop` before Vue mounts.
- Brand, window size, theme, single-instance behavior, deep link, show/hide/close-to-tray, and application paths match Electron.
- Capability files grant only the commands required by the main window. Do not expose broad shell or filesystem plugin permissions to the renderer.

Exit gate:

- Both `npm run dev` and the Tauri development command work.
- Basic navigation renders identically in light and dark themes.
- Tauri can return app information through the compatibility bridge.

## Phase 3: Port backend services in vertical slices

Port in the following order. Each slice includes Rust commands, Tauri event delivery, bridge wiring, unit tests, and a Windows smoke test.

### 3A. Safe local state

- Brand and app information
- App settings and atomic JSON persistence
- Profiles and source metadata
- Overrides, DNS, sniffer, core, geodata, and TUN setting persistence
- Usage history and file logging
- Dialog, clipboard, opening directories, and safe storage equivalents

Keep pure parsing and UI formatting in TypeScript where useful. Filesystem ownership, credentials, processes, registry access, and network authority belong in Rust.

### 3B. mihomo controller and streams

- HTTP controller requests
- WebSocket traffic, memory, connections, providers, rules, and logs
- Main-process log ring buffer and persistent logs
- Reconnect/backoff and snapshot/event sequence semantics
- Policy selection, delay tests, provider refresh, connection close, and diagnostics

Do not tie stream collection to whether a Vue page is mounted.

### 3C. Downloads and external resources

- Subscription fetch and redirect policy
- Proxy-first/direct fallback behavior
- Remote icon cache and process icon extraction
- Geodata and provider content access
- Sub-Store lifecycle, verified downloads, and proxy environment
- Bounded concurrency, timeouts, response-size limits, and stale-cache behavior

### 3D. Privileged core and network modes

- Rust named-pipe client for the existing Go protocol
- Client identity and service-config changes required by the new Tauri executable name/path/digest
- Kernel status, validation, install, start, stop, inspect, and rolling-channel operations
- System proxy backup/enable/guard/restore
- TUN enable/disable and in-place system-proxy-to-TUN transitions
- Network-change recovery and startup intent reconciliation

The renderer must never call the Go service directly.

Exit gate for Phase 3:

- Every existing `window.desktop` command and event has a Tauri implementation or an explicitly approved removal.
- Contract tests run against Electron and Tauri adapters.
- System proxy and TUN real-Windows gates pass with one service-owned core.

## Phase 4: Native desktop integration

Deliverables:

- Dynamic tray icon state: idle/system-proxy/TUN and theme-aware variants.
- Full native tray menu, policy icons, policy switching, process list, configuration switching, directory shortcuts, restart, and quit.
- Scheduled-task startup behavior equivalent to the current LogonTrigger, delay, priority, least-privilege, migration, and Run-key fallback behavior.
- Notifications, native theme changes, power/session events, second-instance routing, and headless restore commands.
- File/process icon cache with bounded eviction and stale-request generation guards.

Exit gate:

- Tray acceptance checklist passes on an interactive Windows desktop.
- Login startup, silent startup, close-to-tray, restart, logoff, and shutdown are observed rather than inferred from unit tests.

## Phase 5: Updater, installer, and upgrade path

Tauri updater signatures are mandatory for update integrity and are separate from Windows Authenticode signing. Define secure CI secret ownership and key rotation before enabling updates.

Deliverables:

- Tauri NSIS per-machine x64 and arm64 packages with no combined installer.
- Equivalent extra resources: Go service, per-architecture mihomo archive, geodata, defaults, licenses, notices, tray assets, and resolved manifests.
- NSIS pre-uninstall hook restores only Murge-owned proxy state and uninstalls the Go service.
- First Tauri installer upgrades an existing Electron installation without duplicate uninstall entries, orphaned scheduled tasks, lost app data, or two installed executables.
- A final Electron release provides an explicit migration path to the first Tauri release; do not assume Electron `latest.yml` and Tauri updater metadata are interchangeable.
- Tauri update check/download/install/restart supports the configured local proxy, bounded timeouts, release notes, rollback-safe failure behavior, and architecture matching.

Exit gate:

- Installed Electron-to-Tauri upgrade passes on clean and configured Windows accounts.
- Exact registry snapshots prove system-proxy restoration across upgrade and uninstall.
- Installed files, service state, scheduled task, app data, and uninstall entries match the expected postconditions.

## Phase 6: CI and acceptance parity

Add Tauri jobs alongside, not instead of, Electron jobs:

- Rust format, clippy, tests, dependency audit, and release build
- Vue typecheck and unit tests
- Go TUN service tests and x64/arm64 builds
- Tauri x64/arm64 NSIS packaging and artifact inspection
- Real mihomo startup and controller readiness
- Real system-proxy enable/guard/restore
- Real TUN install/start/hot-switch/stop/uninstall
- Rolling preview/Smart A-to-B update and offline-current/previous fallback
- Upgrade from the latest Electron installer
- Interactive Windows GUI and tray smoke

Retain Electron CI until Tauri passes the full matrix repeatedly and the user approves the cutover.

## Phase 7: Cutover and cleanup

Only after every exit gate passes:

- Make Tauri the default development, build, package, and release path.
- Archive the final Electron compatibility release and migration notes.
- Remove Electron, electron-vite, electron-builder, electron-updater, preload, and Electron-only adapters.
- Remove Electron CI after at least one successful production Tauri upgrade cycle.
- Update architecture, release, signing, security, and contributor documentation.

## Required test scenarios

At minimum, preserve or add automated coverage for:

1. App starts with no profile, with an active profile, and with remembered system-proxy or TUN intent.
2. System proxy enables only after the mixed port is reachable.
3. System proxy to TUN and TUN to system proxy do not interrupt traffic longer than the existing baseline.
4. DNS and sniffer hot reload do not restart an unrelated core.
5. Crash, forced kill, updater exit, logoff, shutdown, and uninstall restore owned proxy state.
6. Logs and traffic history collect while their pages are closed.
7. Tray menu policy selection and icons remain current while the window is hidden.
8. Stable/specific core trust remains immutable; preview/Smart roll by digest and retain one verified fallback.
9. Corrupt settings, profiles, trust catalogs, provider caches, and update metadata fail safely without deleting the last recoverable copy.
10. Existing Electron app data opens unchanged under Tauri.
11. The installed Go service accepts only the installed Tauri executable and is removed on uninstall.
12. x64 and arm64 packages contain only their matching native assets.

## Definition of done

The migration is complete only when:

- Tauri implements the complete approved desktop contract.
- All hosted and interactive Windows gates pass on x64; compile/package and available runtime gates pass on arm64.
- Electron-to-Tauri installed upgrade is proven with user data and proxy state preserved.
- Installer, installed footprint, idle memory, and startup measurements are documented against the Phase 0 baseline.
- No Node runtime or Node sidecar ships in the Tauri installer.
- No duplicate mihomo owner, proxy writer, updater, startup registrar, or logging collector exists.
- Security review confirms least-privilege Tauri capabilities and preserves the Go service threat model.
- The user explicitly approves the release-path cutover.

## Progress tracking

Update this table in every migration pull request.

| Phase | Status | Evidence | Blockers |
|---|---|---|---|
| 0. Baseline | In progress | `docs/tauri/phase0/`：`IPC_INVENTORY.md`（121/121 `window.desktop` 方法+事件与通道、实现、测试映射；111 invoke 全注册、10 事件全有发送方的脚本核对）；`DIRECTORIES.md`（app-data/logs/kernel/Sub-Store/service 等目录基线）；`PARITY_CHECKLIST.md`（托盘 17 项、设置页 22 项、headless 10 项、深链 5 项、更新器 10 项、关停 12 项）；`BASELINE.md`（TS 1883 通过/7 跳过、Go `go test ./...` 通过，Linux ARM64 真实执行） | Windows 运行时基线（安装包/内存/冷启动/真实 mihomo/系统代理/TUN/交互 smoke 的数值与 CI 链接）需 Windows CI 或真机，见 `BASELINE.md` §1 占位表 |
| 1. Boundaries | Complete | `docs/tauri/phase1/README.md`：`src/main/index.ts` 拆为薄入口 + `src/main/electron/{boot-flags,runtime-state,bootstrap,when-ready,window-adapter,deep-link,lifecycle-adapter,tray-adapter,update-adapter,ci-probes-adapter}.ts`；组合根由 bootstrap（构建）+ when-ready（顺序）共同承担（计划中 `application/composition-root.ts` 的建议以此形式落地）；`window.desktop`/preload/IPC 通道零改动；新增 `tests/phase1-startup-order.test.ts`（启动顺序静态锁 + 薄入口保证）与 `tests/phase1-shell-boundary.test.ts`（boot 标志/深链队列/窗口几何单测）；9 个源码契约测试重指向新模块（断言语义不变）。TS 1899 通过/7 跳过、typecheck 绿、Go 测试通过（Linux ARM64 实测） | — |
| 2. Tauri shell | Complete | `docs/tauri/phase2/README.md`：`src-tauri/`（crate `murge`、tauri.conf 与 brand/窗口几何/背景色逐项对齐、`capabilities/main-window.json` 仅 core:default 最小权限）；兼容桥：`scripts/generate-tauri-bridge.mjs` 从 preload+ipc.ts 生成全 121 通道类型化桥接（111 invoke + 10 event，单命令 `desktop_ipc` 分发，协议错误同 `PROTOCOL_ERROR:` wire 格式，事件解包 Event<T> 且同步退订语义一致）；`main.ts` 在 Vue 挂载前装桥；未移植通道 fail-closed（UNSUPPORTED）。Rust `cargo test` 17 通过、`cargo build` 链接成功、typecheck 绿、TS 1905 通过/7 跳过（Linux ARM64 实测） | `tauri dev` 的交互式 GUI 验证（亮/暗主题导航一致）需显示环境或 Windows CI，见 README「Verification」 |
| 3B. Controller + streams | In progress | 已落地切片⑦⑧（`docs/tauri/phase3/README.md`）：⑦ kernel 监督器状态机 + 内核版本管理器 + runtime 汇总（10 通道）；⑧ mihomo 外部控制器 REST 客户端（reqwest+rustls，与 clash-verge-rev 同选型）：TS 客户端全部端点与逐字错误映射（UNREACHABLE/TIMEOUT/UNAUTHORIZED/503/504/HTTP_ERROR/INVALID_UPSTREAM）、encodeURIComponent 中文段、渲染端参数校验层（strict delay options 拒绝渲染端探针 URL、config patch 白名单排除 tun、DNS 主机名+7 类型）、payload 解析器（passthrough/null-connections 归一）、MihomoLogBuffer（单调 seq/FIFO 2000/高水位 clear）、ProxySelectionStore + 选择网关（归因-PUT-落盘、共享互斥、restore 重放）、组内成员测速全链路（NOT_FOUND 逐字文案、global/档案 url/owner testUrl 链、provider 404 fall-through）。控制器端点暂读 core-settings 模型（3D 内核片重绑）；internet-latency 与 3 个流事件通道 staged。30 通道 live（累计 80/121）。㉑ 内核工件管线（`mihomo_artifact.rs`）：钉定 v1.19.30 清单嵌入 + 下载/哈希/字节上限/120s 预算 + 解压防逃逸/防符号链接 + `.mihomo-verified` 出处标记与逐次复检 + 特定版本 release 构图；supervisor 保持 DisabledKernelResolver 闸门直至 spawn+controller-ready 组合切片。㉒ 内核进程监督器（`kernel_process.rs`）：supervisor.ts 全生命周期逐字移植（注入 KernelBinaryResolver/KernelConfigStore/KernelProcessAdapter/Watchdog 接缝 + Fake 测试台 28 例）：生命周期串行队列（启动中提交 stop 排队）、幂等双启动、KERNEL_RUNNING 拒绝、stale-pid 清理、SIGTERM→SIGKILL 阶梯与幸存进程追踪（pid/handle/config 保留供 stop 重试）、no-PID spawn 失败、stdout 就绪标记（start 超时逐字文案、中止路径保留原始错误码 KERNEL_CRASHED/START_TIMEOUT/UNSUPPORTED）、exitWork 有序（清理→解除 stop 等待→状态+崩溃重启）、error 事件存活 pid 追踪、指数退避重启（250ms→5s 封顶、maxRestarts 预算、stop/start 代纪失效、60s 持续运行预算重置）、日志双上限（256KiB/4000 条）、崩溃看门狗接缝；TempKernelConfigStore（kernel-workspace- 隔离临时目录）与 StrictMihomoConfigStore（mihomo-workspace- 每次运行子目录 + 持久内核 home 不清理 + `-f/-d` 参数 + 64-hex secret 门）、strict loopback YAML 生成与 CSPRNG secret；真实 Unix 进程适配器（tokio process + libc 信号，/bin/sh 实测）；MihomoKernelBinaryResolver 经 ㉑ resolve_mihomo 解析钉定工件（allow_real 显式闸门 + 「内核已停用」文案）。KernelServices 默认 DisabledKernelResolver（fail-closed 不变）；kernel:start/stop 转异步。ControllerReadyKernelGateway（认证 /version 轮询 10s/100ms、超时逐字文案、半就绪 stop 透传）同切片落地，待安装包组合启用。㉓ 内核配置校验（`kernel_config_validation.rs`）：`mihomoConfigErrors` 严格 YAML 白名单逐字移植（yaml-rust2 事件流建树，保留重复键/别名/显式标签/缺失值；unknown key/duplicate/alias/tag/复合键/逐键端口-布尔-mode-日志级-ipv6-controller-secret-ui 检查与嵌套 tun/dns/rules 门全部一致，`Unsafe mihomo config: …` 抛出）、`profileKernelConfigErrors` 中文文案（配置文档为空/YAML 解析错误/缺内容段）、`generateMihomoConfig` 修正为 TS 契约（1024–65535 逐字文案、必填端口、mode 闸门、warn 级）、`sanitizeMihomoConfig`、`seedGeodataFiles`（fail-open + mtime 刷新 + MIHOMO_GEODATA_SEEDED）；StrictMihomoConfigStore 重排为 TS 顺序（secret→文档→schema 全部先于目录创建、owned-dir 精确清理、profile 分支经 `配置文件构建失败：…` 闸门）。退出生命周期：RunEvent::Exit 同步终止 Sub-Store worker（start_kill，不依赖可被丢弃的异步任务），有序退出网关（先还原代理后停内核）已由 kernel:stop 前置与崩溃钩子承担；TUN handleHostExit 随 Phase 4 lifecycle-adapter 切片落位。㉔ 实时运行时配置（`live_config.rs`，`live-config-reloader.ts` 逐字移植）：`reloadIfRunning` 重建完整启动文档（active profile→覆写→DNS→嗅探合成；无 profile 走 strict 直连配置）经 PUT /configs（不带 force=true，保持已绑定监听器）、内核未运行时返回 false 延迟生效；`patchSections`（dns|sniffer|geodata）经 PATCH 部分端点：geodata 逐键回退 buildGeodataBlock（顶层）、dns/sniffer 缺失时退化为 {"enable":false}、TUN dns-hijack 仅在内核运行 TUN 且列表实际变化时重发（未变化的块会重建 Windows 适配器）、DNS patch 后尽力清空双缓存（tokio::join! ≙ Promise.allSettled）；mode 为运行时意图折叠进同一次原子 reload（仅 document 分支、仅 direct/global）；dns/sniffer/geodata :set 臂接入 EnhancementApplyCoordinator 语义（持久化→live 应用→失败回滚模型+尽力重放还原值+rethrow），core-settings 维持纯持久化（TS 亦不 live 包装）；`runtime:get-external-ip` 真实链路（phase 严格 running、端口取自控制器 /configs 的 mixed-port??port、经 mixed-port 绝对式 GET 仅 http 目标、全部失败降级 null、extract_ip 保持 TS 首行精确点分四段否则全文扫描、无八位组范围检查）；profiles 变更臂（import/import-from-url(activate)/activate/删除活动 profile/edit-document 自动激活/replace-document/活动 profile update-from-source）先热 reload 再落有序重启回退（先还原系统代理后 stop、仅在重启前拥有代理才重新启用、先还原文档后还原指针 restoreEdit 次序、删除活动 profile 无回滚、成功后尽力重放选中节点 restore_selections）；RUNTIME_UPDATE 进程级互斥队列：内核 start/stop 与一切运行时配置更新互斥（ModeTransitionController 串行化，dispatcher 级暂置，Phase 4 lifecycle adapter 迁入网关）。㉕ TUN 配置生成器（`tun_profile.rs`，`mihomo-tun-config.ts` 750 行逐字移植）：引导 profile（generate_mihomo_tun_config + 严格 mihomo_tun_config_errors，Phase-9B 唯一白名单文档：mode: direct、MATCH,DIRECT、受控 fake-ip DNS 块（JSON 引号过滤项防 alias 令牌）、TUN 模型 device/stack/mtu/hijack/route 折叠（库存 Mihomo 设备名视作未自定义、品牌 `<shortName> TUN` 意图获胜）、返回前自校验）；代理 profile（generate_proxied_tun_config + proxied_tun_config_errors）承载真实订阅内容：逐字复用 build_profile_kernel_config（主内核同款净化）、禁止能力 STRIP 而非拒绝（与服务端 forbiddenTopKeys 名单同步）、不安全 provider path 重写为确定性受控位置 ./<section>/<safe-name>.<ext>（不拒整份订阅）、字面量代理端点 IP 追加 route-exclude-address（隧道不能承载自身 socket）、tun 在移除它的变换之上重新加回、DNS 接管遵循 clash-party controlDns=false 默认（绝不强制启用、无活 DNS 模块时清空 port-53 劫持、仅填补 profile 缺省的 fake-ip 默认值）、验证仅持特权服务独立复检的不可协商项（无公网绑定/无未认证控制器面/无 alias-tag 技巧/TUN 必开/auto-route 黑洞规则）与 2MiB 服务上限（中文文案逐字）；build_payload 的 staged TUN 拒绝移除：live reloader 现按 TS 完整组合两个 TUN 分支（tunEnabled 取自控制器上报状态、有 profile 走 proxied、无则 bootstrap）；㉖ TUN 热切换适配器（`tun_hot_switch.rs`，`hot-switch-adapter.ts` + `data-plane-readiness.ts` + `documentDnsEnabled` 逐字移植）：在已运行的内核上经环回控制器切换 TUN（不停止进程、不重绑监听器、系统代理目标不变）；enable = 旧 tun 块 ∪ build_tun_block 重建（库存 Mihomo 设备名让位 intent 设备）+ enable: true；clash-party DNS 接管对齐——最终活动文档（内核同一增强管线）DNS 模块关闭时清空 dns-hijack（权威标志来自 resolve_enhanced_document，控制器快照不含 dns 块）；patch 后 GET 确认（未生效 → TUN_HOT_SWITCH_ENABLE_NOT_APPLIED）；patch 失败回滚旧块、回滚也失败为 TUN_HOT_SWITCH_ROLLBACK_UNCONFIRMED 机器码；restore 重发 enable: false 并报告 TUN_HOT_SWITCH_DISABLE_NOT_APPLIED；数据面就绪探测（msftconnecttest+hicloud 并行任一成功、150ms 重试、20s 窗口、KERNEL_START_TIMEOUT 逐字文案）在本地确认后的后台运行（仅诊断，绝不阻塞 UI 或误回滚）；document_dns_enabled 带应用路径 fail-safe（不可解析→关闭）；组合根按 TS 选择（tunSupported ? hotSwitch : Gated）——㉗ 真实内核组合根（`when-ready.ts` 三分支移植 + `ControllerReadyKernelGateway`）：dev 解析无害 fixture（node kernel-fixture.mjs、Temp 配置存储、fixture-ready stdout 就绪标记、无就绪门）；打包 Windows 解析经校验的真实 mihomo 工件（allow_real、workspace=profileRoot/kernel、严格配置存储 = runtime 独占子目录 + 持久 geodata home、活动文档/内核设置/geodata 闭包经托管状态在 start 时实时读取）；其余生产环境保持 fail-closed。控制器密钥新装一次性播种（when-ready 对齐）、严格存储在任何目录创建前校验。生产 start 额外等待环回控制器的认证 /version（10s/100ms，超时停掉半就绪进程并抛 KERNEL_START_TIMEOUT 逐字文案）；kernel:start、system-proxy:enable 自启动、档案重载重启回退全部走该门，stop 直通；dev 保留裸 supervisor。捆绑归档 + 版本选择解析器钩子随传输缝落位（缺安装器归档 → 逐字 ARTIFACT_DOWNLOAD_FAILED 文案，归档仍逐字节流式校验）；version_selection/ensure_specific_binary 为惰性缝直至版本安装切片翻转 specific_versions_supported。supervisor 现按 TS 契约在优雅停止与进程退出时 release（并丢弃）崩溃看门狗。㉘ 版本安装切片（`kernel-manager-service.ts` 安装面移植，解除工件管线 staged）：GitHub release 元数据客户端（githubRequest 移植、30s 上限、超时/失败/状态码逐字文案）落位，specificVersionsSupported 翻转为 true（Tauri 无 Windows 特权服务，TS 服务模式门不触发），staged 守卫文案移除。listVersions/install/setChannel/setEnabled 转异步并移植完整状态机：installing/versionsLoading 瞬态标志 + await 前 emit、标签校验先于任何网络请求（无效的版本号）、获取版本列表失败回退文案、versions/<v> 每版本工作区 + .mihomo-asset.json sidecar 缓存（后续启动离线复用同一已校验摘要）、未找到 {platform}/{arch} 的 mihomo {version} 资产 ARTIFACT_DOWNLOAD_FAILED 文案、仅安装成功后才持久化频道。applyInstalledKernelVersionFinal 移植为组合根注入的 apply 处理器：活动内核经档案重载协调器重启（先恢复系统代理、新增 rollbackActive 选项在重启不可用时恢复频道/版本持久对），随后校验实际版本——不匹配则回滚、按旧选择重启并抛 内核版本未生效：请求 {v}，实际 {actual}（ARTIFACT_HASH_MISMATCH）；apply 在共享 RUNTIME_UPDATE 门内运行（TS modeController 串行点，现上移 kernel.rs）。内核解析器现把 specific+版本/preview/smart 路由到 ensureVersionBinary——与稳定版同等的逐字节校验，绝不信任磁盘文件。㉙ 有界文件日志切片（`file-log-service.ts` 面：应用/内核/Sub-Store 每日日志）：`shared/log-redaction.ts` 逐字移植为 `redact_log_text`（五个有序 passes：Bearer/Basic、SENSITIVE_KEY 敏感 query key、密钥 key:value、内联 userinfo、定宽 64-hex 控制器密钥，全部 /gi 大小写不敏感）。`src/file_log.rs` 移植 FileLogService：每类每日一个本地日期文件、入队时渲染+64KiB 截断+脱敏（保持调用顺序）、单消费者顺序写盘、10MiB 上限保留最新 50% 加逐字截断标记、7 天保留期只清 `^(app|core|substore)-YYYY-MM-DD\.log$`、失败 mkdir 一次性记忆。对齐关键细节：tokio 的 fs::File 在内部缓冲已完成的 write_all，消费者在推进 flush 水位线之前先 shutdown 句柄——seq 水位线 flush 在字节真正落盘时才 resolve，等价 TS `await appendFile(...)`；300 轮 burst 测试锁定该契约。接线镜像 bootstrap.ts/when-ready.ts：启动行（module startup）、内核 /logs 捕获（logSink→writeCore，与订阅者无关）、Sub-Store worker stdout/stderr 管道→writeSubStore（取代 staged Stdio::null()，on_log 可注入测试）。426 测试 / 0 警告，修复后 20x 全套件扫描零 flake。⑳ 事件通道核对 + `profiles:get-provider-content` 闸门对齐（校验顺序与文案与 Electron 处理器逐字一致）。⑲ 应用更新（`updates.rs`）：UpdateService 状态机逐字移植（in-flight 合并、downloadedBeforeCheck 还原、轮询代际闸门）；生产 driver 为 fail-closed GatedUpdaterDriver（本构建无更新源，文案字节原样「当前构建不支持自动更新（仅安装版可用）」）；4 通道 un-stage（111/121 live）。⑱ TUN（`tun.rs`）：状态机纯转换表 + 协调器（串行化/就绪代际围栏/审计日志上限）逐字移植；特权变更仍走 GatedTunMutationAdapter（与本 Electron 构建同一边界）；kernel:stop 前置系统代理还原（有序网关语义）；3 通道 un-stage（107/121 live）。⑰ 系统代理（`system_proxy.rs`）：所有权感知状态机逐字移植（严格策略/冲突 fail-closed/确认回滚/守卫修复/网络断连闩锁/备份严格校验）；Windows 适配器 reg.exe argv + PowerShell 脚本逐字（runner 注入可在 Linux 测试）；活探针 HTTP+SOCKS 并行套接探测；6 通道 un-stage（104/121 live）。⑯ Sub-Store（`substore.rs` + `substore_zip.rs`）：生命周期状态机逐字移植（单飞 ensure/分代取消/暂存提交回滚/SHA-256 摘要锚定/健康轮询/合并模式单端口）；窄 ZIP 读取器（EOCD+中央目录+deflate+CRC32+路径越界拒绝）；worker env 全构造不继承；5 通道 un-stage（98/121 live）。⑮ 开机自启（`startup.rs`）：计划任务（schtasks 逐字 XML：PT3S 延迟/Priority 3/LeastPrivilege/PT0S 限制）+ HKCU Run 回退梯队逐字移植；串行读后写服务、`系统未确认开机启动设置` 分歧文案、off-Windows unsupported fail-closed；refreshRegistration 启动一次性维护 + silentLaunch 变更钩子；un-stage startup:get-status/set-enabled（93/121 live）。⑭ 解锁测试（`unlock.rs`）：十个服务判定逐字移植（参考 clash-verge-rev 解锁测试语义）+ mixed-port 会话级 cookie jar/UA/8s/1MiB 传输 + 内核未运行 fail-closed typed error；un-stage network:unlock-test-all/one（91/121 live）。⑬ 出口元数据（`network_metadata.rs`）：三个隐私明确数据源（ipwhois/ipapi/ipinfo）逐字移植 + 绝对式 GET 经内核 mixed-port 代理取 JSON + 有界内存缓存/单飞/全量并发隔离 + 内核未运行 fail-closed（中文文案逐字）；un-stage 5 个 network-metadata 通道（89/121 live）。⑫ INTERNET 延迟采样（`route_latency.rs` + `internet_latency.rs`）：只读默认网关探测（/proc/net/route 小端解码、route print、route get）+ 网关 53/80 TCP 握手 RTT；内核 /dns/query NS 计时 + 系统 UDP 回退；代理槽按活动 profile 声明的 proxy-groups 顺序取首个可选组（跳过 GLOBAL/DIRECT/REJECT）；各槽独立降级 null；un-stage mihomo:internet-latency（85/121 live）。⑪ 图标+网络接口（`src-tauri/src/icons.rs`）：RemoteIconCache 逐字（SHA-256 键 stale-if-error、HTTPS-only SSRF 逐跳、fake-ip 例外、≤5 重定向、12s、512KiB、七类 mime 白名单、LRU 256 文件/96MiB、in-flight 去重）；get-process-icon Windows SHGetFileInfoW→PNG（cfg(windows) 门控，非 win32 与全部失败返回 null 与 TS 契约一致）；list-network-interfaces 净化+排序；un-stage 3 通道（84/121 live）。⑩ 订阅抓取管道（`src-tauri/src/subscription.rs`）：SSRF 允许列表逐字（字面量+DNS 同一谓词、fake-ip HTTPS 例外）、逐跳重定向校验（预算 5）、2MiB 流式上限、30s 整体超时、UA `ClashforWindows/0.20.39`、凭据仅存 OS 凭据库、显示名 优先级、代理优先+仅传输层失败回退直连、importFromUrl/updateFromSource 逐字组合（含回滚与两条中文错误文案）；un-stage profiles:import-from-url|update-from-source（81/121 live）。⑨ 事件 emit 管道（`src-tauri/src/events.rs`）：三条 WebSocket 推流（tokio-tungstenite）带 TS 逐字重连语义（forever-while-listeners、250ms 指数退避+抖动 5s 封顶、10s stable 窗口重置计数）、traffic 时间戳/日志 tap log buffer（seq 一致）/connections null 归一、MihomoStreamError 形状逐字、Tauri 广播 emit 转发 4 mihomo + kernel:status + kernel-manager:state 事件（supervisor setStatus 与 manager commit 挂 EventHub）。navigate/system-proxy/tun/updates 事件随各自切片。 | system-proxy + TUN 生命周期（3D）；Phase 4 logSink |
| 3A. Local state | In progress | 已落地六片（`docs/tauri/phase3/README.md`）：① brand + app-info + app-settings；② profiles 全链路；③ overrides 全链路（`js` 覆写待 JS 沙箱切片）；④ 五个类型化单模型存储（46 通道）；⑤ usage history（4 通道，录制面待 3B/3D）；⑥ `profiles:inspect-active-config` 有效文档合成（overrides→DNS 增强→嗅探增强→`buildProfileKernelConfig` 运行时变换移植 + 各节摘要/托管键/中文文案/诊断；`documentDnsEnabled` 与 TUN 分支随 3D；yaml-rust2 不解析锚点/合并键已文档化）。`desktop_ipc` 分发表覆盖 **51 通道**（profiles 14/17 完整）。Rust `cargo test` **150 通过 0 警告**、typecheck 绿、TS 1905 通过/7 跳过（Linux ARM64 实测） | 3A 已无遗留 IPC 面；dialog/clipboard/safeStorage 无独立通道（tray 属 4D、keyring 等价已实现、open-external 随 3C Sub-Store）；FileLogService 无 IPC 面随 3B 落地。下一片：3B 控制器+流（traffic/connections/logs 事件、runtime 汇总）或 3C 订阅抓取 |
| 3B. Controller/streams | Not started | — | — |
| 3C. Downloads/resources | Not started | — | — |
| 3D. Privileged/network | Not started | — | — |
| 4. Desktop integration | Not started | — | — |
| 5. Updater/installer | Not started | — | — |
| 6. CI/parity | Not started | — | — |
| 7. Cutover | Not started | — | — |

## Instructions for implementation agents

- Read this document and `docs/ARCHITECTURE.md` before changing code.
- Work on one phase or vertical slice at a time; do not start later phases to hide an earlier failing gate.
- Do not silently change current behavior. If parity is impossible, document the exact difference and request a product decision.
- Preserve unrelated user files and never add the untracked icon concept PNGs unless explicitly requested.
- Use the existing gateways, schemas, fixtures, and tests as behavioral specifications, but verify security-sensitive behavior from the implementation rather than static string assertions alone.
- Never expose generic shell execution, arbitrary filesystem paths, registry access, or the privileged named pipe directly to the webview.
- Do not claim Windows runtime success from cross-compilation alone.
- Do not delete Electron code until Phase 7.
- Every handoff must state changed files, tests actually executed, tests skipped, current phase status, and the next concrete task.
