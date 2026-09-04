# 架构决策

## ADR-001: Electron + Vue 3

状态: 由项目所有者接受。

UI 必须在面向 Windows 的同时在 macOS 上开发和预览。Electron 提供了一致的 renderer 和原生主进程边界。代价是比 WinUI 更高的内存占用；该框架通过限制遥测历史并保持每个流一个上游 WebSocket 来缓解这一点。

## ADR-002: mihomo 是一个受监督的外部进程

状态: 用于框架设计，已接受。

GUI 不嵌入或 fork 内核。它监督一个单独打包的可执行文件，并通过文档化的控制器 API 通信。这创建了清晰的升级、日志记录和失败边界。

## ADR-003: 品牌配置是数据

状态: 由项目所有者接受。

产品标识从 `brand.config.json` 加载。内部模块使用中性名称。安装器配置读取同一来源，因此重命名不是一次源码树的改写。

## ADR-004: 参考尺寸优先的 UI

状态: 用于开发里程碑，已接受。

已批准的 UI 在 934×672 下评审。响应式扩展稍后进行，未经明确批准不得更改参考尺寸。

## ADR-005: TUN 放开代理内容，但保留服务侧结构校验

状态: 由项目所有者接受（2026-09-02）。

Phase 9B 的 TUN 配置写死 `mode: direct` + `rules: [MATCH,DIRECT]`，因此它建立虚拟网卡、
接管 DNS，然后把全部流量直连出去——按构造无法代理。要让 TUN 真正可用，必须放开这道门禁。

调研发现同类客户端（Clash Party / mihomo-party）**没有特权服务**：其 `mihomo.exe` 直接以提权
身份运行，没有任何组件校验它的配置。因此"照搬它们的做法"等价于删除 Murge 的整个特权边界。

决策：取其**使用体验**（真实代理 + 可与系统代理共存），保留 Murge 的**服务侧结构校验**。
放开的是代理内容（`proxies`、`proxy-groups`、`proxy-providers`、`rules`、`rule-providers`、
完整 `dns`、`mode: rule`）；保留强制的是结构边界（loopback-only 控制器、64-hex secret、
禁止额外入站与未鉴权控制器面、`tun.enable` 必须为真、禁止 YAML 别名/非核心标签/多文档）。
完整清单见 `docs/phase9b-mihomo-owned-tun.md` 的 Configuration boundary 一节。

代价是明确的：主进程若被攻破，可让 SYSTEM 权限的 mihomo 走攻击者选定的节点与规则；但仍无法
绑定公网端口、暴露未鉴权控制器、替换二进制或执行任意命令。这比"无任何服务校验"显著更小的
攻击面，是"要真代理"这一需求下可接受的取舍。

该放开按 `docs/helper-threat-model.md` C7 的要求，作为一次单独、显式、带测试的评审变更记录，
而非静默取消。TS 侧（`mihomoTunConfigErrors` / `proxiedTunConfigErrors`）与 Go 侧
（`validateTunProfile`）两处校验必须保持同义，两侧均有对应测试固化。

## 单 mihomo 内核（本会话单项决策）

与 mihomo-party / clash-verge-rev 对齐，将 Murge 从"双内核"（非特权回环安全内核 +
特权 TUN 子进程）迁移为**单 mihomo 内核**：系统代理与 TUN 由同一个 mihomo 提供服务
（TUN 开启时以管理员/服务权限重启该内核并注入 `tun` 配置），数据面始终读取该单内核
控制器。`-安全直连内核" 概念已被删除。作为配套修复，系统代理 `enable()` 现在会重新
收养跨会话端口重分配后遗留的自有备份（陈旧 target.port），而非误报"外部修改"冲突；
真正的外部修改仍会冲突。

## ADR-006: 节点按配置顺序展示、按 profile 记忆，导入不自动启用

状态: 由项目所有者指示（2026-09-04），已接受。

三项相互关联的策略/配置行为，取代此前的相反约定：

1. **策略组顺序与图标。** 策略页按 mihomo `/proxies` 响应的序列化顺序展示策略组——
   该顺序即原始配置文件中 `proxy-groups` 的书写顺序——绝不按名称二次排序。配置里
   声明的 `icon` 在策略组卡片上展示，加载失败时静默隐藏（不留破图）。
2. **节点选择记忆（sparkle/clash-party 模型）。** mihomo 控制器只在内存中保存
   `Selector` 等组的 `now` 选择，重启即丢失。框架新增按 profile id 键控的持久缓存
   （`proxy-selections.json`，原子写入、串行队列、损坏时 fail-open）：渲染进程每一次
   被控制器接受的选择经 `ProxySelectionGateway` 记录；内核自动启动与每次 profile
   reload 之后由 `ProxySelectionService` 回放该 profile 的记忆选择。已失效的
   组/节点（配置更新后不再存在）被静默跳过，绝不阻断其余恢复；删除 profile 时
   同步清除其缓存。
3. **导入不启用（反转 import-is-apply）。** 此前的"导入即设为当前配置并加载"是
   有意 UX（见提交 `0007996` 的测试锁定），现按所有者要求反转：三条导入路径
   （远程/本地/手动）均传 `activate: false`，配置仅在用户在列表中选中后才启用。
   `ui-navigation-contract.test.ts` 的断言已同步反转，作为新行为的回归锁。
