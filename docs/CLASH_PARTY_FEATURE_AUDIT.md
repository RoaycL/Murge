# Clash Party 页面审计与 Murge 增强积压

状态日期：2026-08-31

本文档对照当前的 Murge 实现，审计所提供的十张 Clash Party 截图。除非 Murge 具备类型化的渲染进程 → IPC → 主进程契约、已确认的运行时状态以及恢复/错误路径，否则一个可见开关不视为已支持。

这些截图是功能参考，而非视觉参考。Murge 保留其已批准的源自 Surge 的信息架构与可配置品牌的产品标识。

## 总结

Murge 已覆盖日常核心路径：来自 URL/文件/手动输入的 profile、内核生命周期与版本选择、策略、规则、provider、实时连接、单连接关闭、进程/设备聚合、日志、DNS 诊断、系统代理所有权、托盘/启动与更新脚手架。

最大的缺失产品能力是确定性的配置增强管线。DNS、sniffer、TUN 与高级内核设置必须实现为该管线的类型化输入，而不是覆盖订阅 YAML 的独立控件。

## 逐页对比

| 截图/页面 | Clash Party 能力 | Murge 状态 | 所需工作 |
| --- | --- | --- | --- |
| 系统代理 | 主机、手动/PAC 模式、UWP 回环助手、默认/自定义绕过列表 | 部分 | Murge 安全地拥有并恢复 Windows 手动代理。可编辑、带读回验证的绕过策略已完成：启用时 `ProxyBypassPolicy` 对写入的 `ProxyOverride` 具有权威性（强制性的本地/私有条目与用户的自定义列表合并），禁用时保留操作系统列表，实时重新应用并带冲突 + 读回验证，并始终原样恢复启用前的值。PAC 与 UWP 仍是独立的、仅 Windows 的功能。绝不周期性覆盖另一个进程所拥有的状态。 |
| 虚拟适配器 | TUN 栈、适配器名称、严格路由、自动路由/接口、MTU、DNS 劫持与排除范围 | 受限的部分 | 服务、协调器、IPC 与 UI 接线已存在，但发布支持被隔离的 Windows 恢复矩阵所阻塞。在签名意图与回滚证据中表示出每个字段之前，不要暴露高级控件。 |
| DNS 设置 | 启用、增强模式、fake-IP 范围/过滤、IPv6、respect-rules 与 nameserver 组 | 部分 | Murge 具备 DNS 查询/缓存动作并保留 profile DNS。请添加声明式 DNS 覆盖编辑器、schema 校验、预览与 last-known-good 回滚。 |
| 域名 sniffer | 启用、目标覆盖、IP 映射选项、HTTP/TLS/QUIC 端口、跳过/强制域名与跳过的 CIDR | 缺失 | 添加类型化的 sniffer 覆盖模型。在物化运行时配置前校验端口、域名与 CIDR。 |
| 连接 | 实时/已关闭标签、总计、过滤、列、逐行关闭/暂停控件 | 强部分 | Murge 已具备共享流式传输、搜索、详情与已确认的单连接关闭。已新增总计、排序与已确认的批量关闭。已关闭历史与列选择器仍未实现。暂停并非当前 mihomo 契约所承诺的。 |
| 外部资源 | GeoIP/GeoSite/MMDB/ASN 来源、数据模式、更新间隔、代理/规则 provider 刷新与详情 | 部分 | Provider 列表/刷新/健康数据已存在。请添加 geodata 来源策略、下载完整性、原子替换、更新计划与 provider 详情。QR 导出必须脱敏凭据并设为主动选择加入。 |
| 覆盖 | URL/本地导入与有序覆盖项 | 缺失 / P0 | 首先添加版本化 YAML 覆盖：全局与 profile 作用域、顺序、启用/禁用、预览/差异、校验、原子写入与回滚。JavaScript 是之后的受信任代码功能，而非安全沙箱。 |
| 内核设置 | 内核选择、mixed/SOCKS/HTTP 端口、监听地址、secret、仪表盘、IPv6、LAN/认证与 1-RTT | 部分 | 稳定/特定内核管理与混合端口已存在。请添加带冲突检查的受控端口/监听/LAN 字段。控制器 secret 保持应用所有，绝不能被揭示或随意编辑。 |
| 网络信息 | 出口 IP provider、国家/城市/ASN、复制/揭示与连接拓扑 | 部分 | Murge 尽力展示出口 IP。请添加隐私明确的 provider 选择与缓存元数据。拓扑是一种派生可视化，必须标注 mihomo 数据的不完整性。 |
| 用量 | 1h/24h/7d/30d 历史；会话/上传/下载/总计；设备/域名/代理/进程排行 | 缺失 | 添加有上限的本地时序持久化、保留策略、聚合与清除数据动作。绝不持久化控制器 secret、完整 URL 或原始 profile 内容。 |
| Sub-Store 入口 | 内嵌/链接的订阅转换器 | 缺失 | 延迟到覆盖管线稳定之后。优先使用显式的外部集成，而非静默托管一个特权远程面板。 |

## 不得重建的现有 Murge 能力

- 类型化的 `ProtocolErrorCode` 分类已横跨渲染进程与主进程；请增强详情传输，而不是引入第二个错误体系。
- `/traffic`、`/connections` 与 `/logs` 已使用共享 WebSocket，具备退避、抖动、稳定窗口重置、监听器清理与渲染进程静默看门狗。
- 生产端口被动态选择。剩余问题是探针到绑定的竞态；启动应在验证到冲突时重试。
- 原始订阅 URL 不被持久化；已存来源元数据被脱敏。
- 深链注册与单实例转发已存在。
- TUN 遵循 Murge 的特权服务所有权与恢复架构。不要用提权的 Electron 渲染进程替换它。

## 配置增强管线

所需的顺序是：

```text
immutable source profile
  -> parse YAML
  -> ordered global YAML overrides
  -> ordered profile YAML overrides
  -> typed DNS/sniffer/core rule operations
  -> Murge safety ownership transform
  -> structural and semantic validation
  -> user-visible diff/preview
  -> atomic last-known-good runtime materialization
```

规则：

1. 订阅刷新绝不编辑或删除用户的覆盖。
2. 每个覆盖都有稳定的 ID、schema 版本、作用域、启用状态与确定性顺序。
3. 无效 YAML、无效字段与语义冲突时安全失败。先前有效的运行时配置保持生效。
4. 数组使用显式的替换/前插/后插/删除操作；通用深度合并绝不能静默替换 `rules`、`proxies` 或 `proxy-groups`。
5. 安全所拥有的控制器地址/secret、公共监听器、系统代理与 TUN 所有权不能被订阅或增强覆盖。
6. 节点 `vm` 不是安全边界。未来的 JavaScript 覆盖被标注为受信任的本地代码，并在一个单独受限的进程中运行，带有超时、内存上限，没有文件/网络/模块访问。

## 交付 TODO

### P0 — 声明式增强基础

- [ ] 定义版本化的覆盖 schema 与共享网关契约。
- [ ] 实现具有稳定排序的原子覆盖仓库。
- [ ] 实现确定性映射合并加上显式序列操作。
- [ ] 在安全转换之前，先应用全局覆盖，再应用 profile 覆盖。
- [ ] 在不应用的情况下生成校验结果与脱敏的前后差异。
- [ ] 保留并恢复 last-known-good 的物化配置。
- [ ] 添加 Vue 管理页面：创建、导入、编辑、重新排序、启用与作用域。
- [ ] 覆盖格式错误的 YAML、重复 ID、序列行为、安全冲突、刷新持久化与崩溃安全写入。

### P1 — 受控的 DNS、sniffer 与内核设置

- [x] DNS 共享 schema 与编辑器：启用、增强模式
      （`fake-ip`/`redir-host`/`normal`）、fake-IP 范围、fake-IP 过滤模式/列表、
      IPv6、respect-rules、hosts/use-hosts、default-nameserver、
      proxy-server-nameserver、direct-nameserver、nameserver、fallback 与
      nameserver-policy。（`src/shared/dns.ts`、`DnsSettingsPanel.vue`、
      `dns-enhancement.json` 服务以及 `dns:` 生成器，发布于 `v0.1.14`。该
      模型在 IPC 处经严格/zod 校验，并且生成的列表键仅在非空时才发出。）
- [x] 校验 DNS 服务器 scheme、IP、域名与 CIDR；渲染脱敏后的
      有效配置预览；在失败时保留 last-known-good 配置。
      （每个服务器 scheme `udp|tcp|tls|https|h3|quic|dhcp`、IP、主机名、域名
      模式与 CIDR 在持久化/物化之前都经过校验；预览被脱敏（userinfo 用
      `***`）；在任何无效/不可解析的输入上，管线安全开启为基准/默认值，
      因此损坏的增强永远不会到达内核——这是一个 fail-open 的
      last-known-good 保证。）
- [ ] Sniffer 共享 schema 与编辑器：启用、override-destination、
      force-dns-mapping、parse-pure-ip、HTTP/TLS/QUIC 端口、skip-domain、
      force-domain、skip-src-address 与 skip-dst-address。
      （发布于 `v0.1.15`：`src/shared/sniffer.ts` 中的 `SnifferEnhancement` 加上
      Config 页面上的 `SnifferSettingsPanel` 编辑器；端口 token、域名
      模式与 CIDR 校验在任何持久化之前于 IPC schema 中完成。）
- [ ] 校验并归一化单个端口/范围、域名模式与 IPv4/IPv6
      CIDR；为生成的 `sniffer:` 块添加解析回显与夹具覆盖。
      （发布于 `v0.1.15`：`isValidPortToken`、`isValidAddressOrCidr` 与
      共享 `net.ts` 校验器支撑严格的 `snifferEnhancementSchema`；IPC
      schema 针对错误的端口/域名/CIDR 进行了单元测试，并且
      `apply-sniffer`/`sniffer-enhancement-service` 测试断言生成的
      `sniffer:` 块通过解析回显往返，包括空列表省略与保留的非自有键。）
- [x] TUN 共享 schema 与编辑器：栈、设备/适配器标识、MTU、
      strict-route、auto-route、auto-detect-interface、DNS 劫持、
      route-address、route-exclude-address 以及明确支持的 mihomo 可选字段。
      （发布于 `v0.1.16`，**仅配置模型**，标记为
      `implementation-complete / runtime-unverified`：
      `src/shared/tun-config.ts` 中的 `TunConfigModel` 加上 IPC 处的严格
      `tunConfigSchema`；Config 页面上的 `TunConfigPanel.vue` 编辑器；
      `tun-config.json` 服务以及通过 `readTunConfig` 折入 mihomo 自有引导的
      `buildTunBlock` 生成器。**TUN 生命周期/错误 UI 是下一项。**）
- [x] TUN 生命周期 UI：unsupported、stopped、starting、active、stopping、
      restoring、restore-failed、conflict 与 failed；添加重试与紧急
      禁用而不依赖响应式渲染进程。
      （发布于 **v0.1.17**，标记为 `implementation-complete /
      runtime-unverified`——固定到 `TunPhase` 枚举，因此 `stopped`/`stopping`
      映射到 `configured`/暂停的协调器；Config 页面上的 `TunLifecyclePanel.vue`
      通过 `TUN_UI_COPY` 渲染该阶段，展现
      `errorMessage`/`conflictDetail`，从纯函数
      `src/renderer/src/lib/tun-lifecycle.ts` 辅助逻辑推导仅从 `configured`/
      `failed` 启用（重试）以及网络所有期间的禁用门控，并且 `tun` Pinia store
      通过 `connect`/`disconnect` 镜像协调器状态，同时通过 `toProtocolError`
      捕获动作错误。渲染进程绝不提权：禁用走协调器的 `emergencyDisable`，
      它在没有渲染进程时仍保持可调用。非 Windows/开发构建渲染 `unsupported`；
      不是发布版 TUN 启用。）
- [ ] 仅通过现有的特权服务/命名管道、
      完整性检查、协调器与变更日志接线 TUN。不要提权
      Electron 渲染进程，也不要让订阅成为第二个
      路由/DNS 所有者。
- [x] 在 Windows 测试活动之前，完成所有 DNS/sniffer/TUN 网关、IPC 校验、Pinia 存储、
      夹具、生成器、预览/差异与网络静默测试。（DNS / Sniffer / TUN 各自交付共享模型 +
      严格 zod schema、IPC 网关 + preload 块 + Pinia store + Config 页面
      面板、一个原子持久化服务以及带解析回显断言的配置生成器；组合的
      `tests/network-silent-config.integration.test.ts` 在内存中演练真实的 profile + DNS + Sniffer + `buildProfileKernelConfig`
      管线，并断言仅回环 / 无公共绑定 /
      剔除 `dns.listen` / 解析回显有效的输出。非 Windows/开发构建
      保持 TUN `unsupported`；不是发布版 TUN 启用。）
- [ ] 带预绑定校验的受控端口/监听/LAN/认证编辑器。
- [ ] 可编辑的系统代理绕过策略，带精确恢复与冲突测试。
- [ ] 在 Electron IPC 间保留类型化的错误 `details` 与 `operation`。

### P2 — 资源与可观测性

- [ ] 具有 HTTPS 白名单、哈希、原子替换、
      手动刷新与有界调度的 geodata 来源注册表。
      （受控的 geodata *策略*——geodata-mode / geoip-mode / geo-auto-update /
      geo-update-interval / 可选的 geo-x-url——在 v0.1.20 中已作为类型化的、
      持久化模型实现，启用时具有权威性（读回）并覆盖
      profile（冲突处理）。注册表本身——HTTPS
      白名单、下载完整性/哈希、原子替换、手动刷新、
      有界调度——仍在。）
- [ ] Provider 详情视图与批量结果报告。
- [ ] 连接已关闭历史模型与可配置的可见列。
- [ ] 有上限的用量数据库、1h/24h/7d/30d 桶与四个排行视图。
- [ ] 网络元数据 provider 选择、缓存、隐私复制与失败状态。
- [ ] 由当前连接/规则/代理链派生的只读拓扑。

### P3 — 可选集成

- [ ] 本地备份/导出与事务性恢复，带清单/校验和。
- [ ] 加密的 WebDAV 备份，带冲突、轮换与凭据存储。
- [ ] 全局快捷键与特定 shell 的代理环境导出。
- [ ] 流量悬浮窗口与更丰富的托盘状态。
- [ ] 在威胁与隐私审查后增强 Sub-Store/深链。
- [ ] 仅在与进程隔离审查后实现受信任代码的 JavaScript 覆盖。

### 仅 Windows 的发布门禁

- [ ] 在隔离的、可快照的
      Windows VM 上安装一个实现完整的构建，附带带外恢复控制台。
- [ ] 验证 TUN 启用/禁用、适配器标识/重用、IPv4、IPv6、DNS 劫持、
      DNS 泄漏行为、严格路由、排除项与 LAN 可达性。
- [ ] 验证睡眠/唤醒、Wi-Fi/以太网切换、DHCP/网络 profile 切换与
      临时控制器/网络丢失。
- [ ] 在每个变更日志边界独立地强制终止 GUI、mihomo 与特权服务；
      验证重启后是有界恢复。
- [ ] 验证正常禁用、失败启用、强制终止、重启与
      卸载会恢复精确的先前路由、DNS、代理与服务状态。
- [ ] 在恢复失败后验证重试与紧急禁用，而不生成
      第二个内核、适配器或所有权会话。
- [ ] 针对不可变构建/标签，记录脱敏的前后证据、进程/服务状态、适配器
      标识、路由表与 DNS 状态。
- [ ] 保持 TUN 标记为 `runtime-unverified`，直到每个必需行均通过；
      实现与 mock 测试本身不能将其提升为受支持。
- [ ] 在干净且受支持的 Windows 版本上验证 PAC/UWP 行为。
- [ ] 证明安装、升级、卸载与紧急恢复会留下精确的先前
      代理/路由/DNS 状态。

## 参考实现策略

- Clash Party 的 Node 主进程组织方式可为契约与数据
  流提供参考，但 React UI 代码会转换为 Murge 的 Vue/Pinia 架构。
- Clash Verge Rev 的 Rust 代码仅是行为参考；不要翻译
  不安全的假设，也不要机械地照搬 Rust 实现。
- 在代码实际改编时保留上游 GPL 声明。在合并复制或
  衍生实现之前，在 `THIRD_PARTY_NOTICES.md` 中记录来源、
  提交与涉及的文件。
- 截图与第三方名称不是 Murge 资产。不复制任何 Clash Party 的 logo、
  渐变、图标或品牌。
