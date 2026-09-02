# Phase 9 — Windows TUN 特权 helper：威胁模型

> 状态：**供设计评审的草稿。** 本文档仅用于设计/分析，不授权任何网络变更。它是
> Phase 9 路线图第一条（"编写并批准 helper/权限威胁模型"）的交付物，也是先于所有
> Windows 实现与测试的设计评审关卡（gate）的输入。此处的任何内容都不能在本开发机上执行；
> 所有真实行为仅在一次性（disposable）的 `windows-latest` CI 环境中验证，并且必须始终
> 保持由显式的 owner 授权把关（见 `DEVELOPMENT_SAFETY.md`）。

---

## 1. 目的与范围

本威胁模型定义了 **TUN 启用模式（TUN enabled mode）** 在 Windows 上保护什么、敌对方
（hostile actors）是谁，以及特权 helper 必须实现哪些控制（controls），以使透明捕获
永远不会断开机器，并且总能被撤销。

范围内（In scope）：

- 特权 helper 二进制、其安装服务（如有），以及它使用的 TUN 设备（wintun / 等价物）。
- 非特权 Electron 主进程与特权 helper 之间的进程间通道。
- helper 执行的配置、DNS、IPv4/IPv6 路由与接口变更、它们的撤销，以及崩溃后的恢复。
- Windows 驱动/签名与完整性校验路径。

范围外（Out of scope）：

- mihomo 内核进程生命周期、controller 密钥，以及 REST/WebSocket 安全（由 Phase 7 和
  `ARCHITECTURE.md` 覆盖）。
- macOS 网络行为（本里程碑明确不支持）。
- 反向代理、TLS 解密与改写行为（Phase 10 UI 与一个 owner 决策；见 ROADMAP owner backlog）。
- 应用更新通道设计（Phase 10/11）。

基础参考（Grounding references）：`docs/ARCHITECTURE.md`（进程模型、`TunService`）、
`docs/CODE_SIGNING.md`、`src/main/kernel/mihomo-config.ts` 和
`src/main/kernel/mihomo-artifact.ts`（现有 SHA-256 完整性与 `tun.enable:false` 把关）、
`src/main/system-proxy/*`（已确立的 interface/adapter/backup-store 与 fail-closed 模式，
helper 必须效仿这些模式）。

---

## 2. 资产（Assets）

| 资产 | 敏感度 | 为何重要 |
|---|---|---|
| 机器网络路径 / 连通性 | 高 | 所有权者可能远程依赖这台机器。失去它会锁死所有所有者，因此 helper 必须可撤销并可在带外（out-of-band）恢复。 |
| TUN 设备 + 其数据包 | 高 | 对所有非代理感知流量的透明捕获；拥有该设备的敌对方可以读取/篡改流量或将其外泄。 |
| DNS 配置与解析 | 高 | 劫持 DNS 既是捕获原语，也是投毒/重定向的攻击面。 |
| IPv4/IPv6 路由表、接口指标、防火墙规则 | 高 | 恶意或有 bug 的 helper 可能使流量黑洞化、重定向或分片。 |
| Helper 二进制、其服务，以及任何 helper 密钥 | 高 | helper 以提升权限运行；其被攻破即整台主机被攻破。 |
| 已存储的基线状态（TUN 前的路由/DNS/接口快照） | 高 | 回滚的真相来源（source of truth）。能伪造或损坏它的攻击者会阻止干净禁用，并可能让系统长期处于损坏状态。 |
| Kerberos/admin 凭据与完整性级别 | 高 | 提升权限绝不能把 admin 暴露给更低信任的面。 |
| 应用与 helper 之间的 IPC 通道 | 高 | 此处伪造/篡改会击败 fail-closed，并允许未授权变更。 |
| 路由/DNS/服务变更的事件/日志证据 | 中 | 恢复、诊断与 Phase 9 证据记录所必需。 |
| renderer 及其存储 | 低/中 | 绝不能看到 helper 凭据、设备句柄或特权路径。 |

---

## 3. 信任边界与组件

```text
                       ┌─────────────────────────────┐
Low IL                │ Vue renderer                 │
 (unprivileged)       │  window.desktop API          │
                       └───────────┬─────────────────┘
                                   │ validated Electron IPC (contextIsolation, sandbox)
                                   ▼
Medium IL             ┌─────────────────────────────┐
 (installer / app)    │ Electron MAIN               │
                       │  ┌───────────────┐          │
                       │  │ TunService    │──────────┼──┐ 1. IPC (COM elevation moniker, LRPC)
                       │  │ (config, ops) │          │  │    policy, schema, per-op auth
                       │  └───────────────┘          │  │
                       └───────────┬─────────────────┘  │
                                   │ 2. elevation        │
                                   │    (UAC consent,    │
                                   │     least privilege)│
                                   ▼  (High IL)          ▼
                 ┌─────────────────────────────┐    ┌─────────────────────┐
High IL          │ PRIVILEGED HELPER            │    │ 3. Driver/file     │
 (elevated)      │  - owns wintun device        │    │    integrity +      │
                 │  - routes/DNS/interface      │    │    Authenticode     │
                 │  - baseline snapshot + undo  │    │    verification      │
                 └───────────┬─────────────────┘    └──────────┬──────────┘
                             │ 4. wintun API / ioctl          │
                             ▼                                 ▼
                    ┌──────────────────────────────────────────────┐
                    │ WINTUN driver (signed) + Windows firewall/routes│
                    └──────────────────────────────────────────────┘
```

完整性级别（Windows IL）：renderer 与应用运行在 **Medium IL**；helper 运行在 **High IL**
（或作为提升的服务）下的一个狭窄而专用的进程中。它绝不能是 shell 或一个通用管理界面。

**清晰信任边界**的定义：提升的 helper 是**唯一**可以 (a) 调用 `WintunCreateAdapter`
（按需安装/加载 Wintun 驱动并创建适配器）、(b) 添加/移除路由，或 (c) 更改 DNS 或接口
指标的组件——它是**唯一**的 OS 网络配置所有者。它**不**为数据包 I/O 创建/持有 Wintun
适配器——那完全由 mihomo 独占（唯一的 TUN 数据平面所有者，见 §5 A8；mihomo 能否复用
helper 创建的适配器是 G1）。应用只能以类型化、已验证、按操作（per-operation）的命令来
*请求* helper 的特权工作，并且绝不在边界上携带原始 PowerShell/`reg.exe`/`ip` 命令字符串
（效仿现有的"不拼接命令"规则）。

---

## 4. 参与者 / 攻击者模型

| 参与者 | 信任 | 动机 / 访问 |
|---|---|---|
| 本地用户（所有者） | 合法 | 想要透明捕获；唯一被允许发起提升的当事方。 |
| 以同一用户身份运行的非特权本地进程 | 不可信 | Medium-IL 恶意软件、已下载的内容、被攻破的 renderer。可能试图与 helper 通信、篡改 helper/驱动文件，或伪造应用→helper 请求。 |
| 更高权限进程（已提升的恶意软件） | 不可信 | 已经掌控了这台机器；不可能完全防御，但绝不能"更容易"（不能被一个盲目接受命令的网络变更 helper 变得更糟）。 |
| 送达给用户的恶意网页/邮件内容 | 不可信 | 驱动上述本地非特权参与者（例如，通过一个随后运行的特制下载）。 |
| 远程网络参与者 | 不可信 | 可能抢占（race）helper 的路由/DNS 变更，或利用一个过开放的 TUN。 |
| 特权 helper 被攻破（helper 本身） | 一旦被攻破则不可信 | 边界必须很小，以便 helper 的 bug 或劫持拥有一个有限的爆炸半径且可被检测。 |

---

## 5. 设计假设（必须经设计评审确认）

这些是威胁模型所假设的决策；每一项在 §10 中都有一个 owner 决策标记。

- **A1. 设备模型。** TUN 使用官方的 **wintun** 发行版（WireGuard 的模型）：我们分发
  官方按架构区分的 **`wintun.dll`**；签名的 Wintun 内核驱动由 DLL 在
  `WintunCreateAdapter` 内部**按需安装/加载**，因此**没有单独的驱动加载步骤**，单独调用
  `LoadLibraryEx(wintun.dll)` 本身**不**会安装/加载驱动。我们绝不分发一个名字类似驱动的
  裸驱动文件，也**不**自签驱动或驱动证书。**TUN 数据平面只由 mihomo 拥有**；helper 用
  `WintunCreateAdapter` **创建适配器**（它的提升行为），并以**唯一**网络配置所有者的身份
  应用 OS 级路由/DNS。
- **A2. Helper 形态。** 一个微小、专用构建的特权 **helper 可执行文件**（或 Windows 服务），
  而不是提升整个 Electron 应用。应用保持 Medium IL。
- **A3. 提升触发。** 提升始终是**显式的用户操作**（UAC 同意 / 一个按钮），绝不属于隐含、
  自动提升或在应用启动时执行。
- **A4. 路由/DNS/接口所有权（单一所有者，选项 A）。** **helper 是唯一的**路由/DNS/接口
  修改者，由主进程生成的精确类型化 **`DesiredNetworkState`** 驱动（设计文档 §8.2）。
  mihomo 的合成运行时配置有 `auto-route:false`、`auto-detect-interface:false`、
  `dns-hijack:false`，因此 mihomo **绝不**修改路由/DNS。helper 在**第一次**变更之前保存一个
  带 schema 版本的 **BaselineSnapshot**（每个接口完整的 IPv4/IPv6 路由，含前缀/下一跳/
  指标/协议/存储，带 DHCP/静态来源的有序 DNS，接口指标/状态），外加一个 **WrittenState**
  和一个有序的 **MutationJournal**。恢复是**按项且仅限自有**，并按**逆 journal 顺序**。
- **A5. mihomo 配置把关。** 如今 `mihomo.config.ts` 对每个文档都强制 `tun.enable:false`
  （以及 `dns.enable:false`）。Phase 9 必须**仅**在 Windows 上、仅当 helper 存在且被授权时、
  仅针对运行时激活放宽此限制——绝不更改对开发安全的默认值。放宽必须是审慎的、经过评审的、
  带测试的变更。
- **A6. Fail-closed。** 如果 helper 无法证明它是预期二进制（签名/校验和已验证），或 IPC
  无法被认证，激活必须失败并执行**零**变更。
- **A7. 最小权限 IPC。** helper 暴露一个最小的命令集。每个命令在 helper 内由策略授权；
  应用不携带权限。renderer 受限更严：它只发出类型化、无参数的意图，并且绝不持有 helper
  句柄（C6）。
- **A8. 单一 TUN 数据平面所有者。** 恰好一个进程拥有 Wintun 适配器会话用于数据包 I/O：
  **mihomo**。helper 绝不读/写数据包，也绝不持有会话句柄。helper 的特权角色是调用
  `WintunCreateAdapter(Name, TunnelType, RequestedGUID)`（按需安装/加载驱动并创建适配器，
  其中应用提供的 `RequestedGUID` 给出一个**稳定、可恢复的身份**；见设计文档 §3.0/§3.2），
  持有**创建者句柄**（适配器的生命期锚点），并执行**唯一**的 OS 级路由/DNS/接口变更 +
  验证/恢复。在禁用时，适配器**仅**由 `WintunCloseAdapter(creatorHandle)` 移除——**没有**
  `WintunDeleteAdapter`，也**没有** `RebootRequired`/`delete-pending`。**mihomo 能否打开并
  复用 helper 创建的适配器，以及适配器在 helper 关闭创建者句柄后是否仍存活，是 **G1 — 一个
  未经证明的假设**，必须由 **G1 生命周期探针**（G1 lifecycle probe）证明（创建 + 持有创建者
  句柄 → mihomo 按 Name 打开 + 启动会话 → helper 关闭创建者句柄/退出 → 验证会话 + 适配器
  持续存在；设计文档 §3.3/§12），**之后才允许任何 Phase 9 helper 实现开始。** 除了 mihomo，
  任何组件都不得启用 `tun` 数据平面。

---

## 6. STRIDE 威胁枚举

图例（Legend）——控制指 **C1 .. C13**，在 §7 中定义。"Owner" = 设计评审 / owner 决策项。

| ID | STRIDE | 资产 | 威胁 / 场景 | 影响 | 主要控制 |
|---|---|---|---|---|---|
| T01 | Spoofing | IPC | 一个 Medium-IL 进程（或一个同用户的冒名者）冒充应用，向 helper 发送 `apply_network_state` / `create_adapter` / `restore`。 | 未授权网络改写 | C3, C4, C6 |
| T02 | Spoofing | Helper/DLL | 攻击者在可写路径旁投下一个恶意 DLL/exe 以替代 helper 或官方 `wintun.dll`。 | 提升 / 网络改写 | C1, C2, C3 |
| T03 | Spoofing | Route/DNS | 远程或本地参与者在激活后宣告一个冲突的路由/DNS。 | 流量重定向 / 黑洞 | C7, C8, C11, C13 |
| T04 | Tampering | 基线快照 | 攻击者编辑已存储的 TUN 前快照，使禁用恢复出*错误的*状态。 | 永久误配置 / 锁死 | C4, C8, C9, C10, C12 |
| T05 | Tampering | Helper/服务配置 | 注册表/服务键或 helper 配置被较低信任参与者修改。 | 持久化 / 削弱 helper | C2, C3, C6, C13 |
| T06 | Tampering | TUN 数据包 | 某组件或网络参与者在策略之外读/写设备上的数据包。 | 流量的机密性 / 完整性 | C6, C11, C13 |
| T07 | Repudiation | 证据 | helper 执行了一次网络变更，但操作者/所有者无法归因或撤销它。 | 无法恢复的损坏状态 | C9, C12, C13 |
| T08 | Info disclosure | helper 凭据 / 设备句柄 | 低权限进程读取 helper IPC 或内存，提取设备句柄或任何 helper 密钥。 | 捕获/变更原语 | C3, C6, C12 |
| T09 | Info disclosure | 数据包 / DNS | DNS 劫持泄露被请求的域名，或配置错误的 TUN 把流量暴露给错误的接口。 | 机密性 | C1, C6, C11 |
| T10 | DoS | 机器网络路径 | 有 bug / 已提升的 helper 或一个恶意请求留下错误的路由/DNS 并断开机器。 | 所有者锁死 | C7, C8, C9, C10, C12 |
| T11 | DoS | Helper 服务 | 过于热切或过于宽泛的 helper 任务被反复启动，或一直持有 TUN 设备，阻塞其他用途。 | 资源耗尽 | C5, C7 |
| T12 | Elevation of privilege | Helper | helper 中的漏洞（解析、IPC、驱动 ABI）让 Medium-IL 调用者获得 admin。 | 完全主机攻破 | C3, C4, C6, C7, C13 |
| T13 | Elevation of privilege | 驱动 | 一个特权驱动从被篡改/签名不良的来源加载。 | 内核攻破 | C1, C2, C3 |
| T14 | Elevation of privilege | 提升流程 | 应用自动提升，或 UAC "同意"被绕过，使低信任参与者触发 admin 工作。 | 未授权 admin | C5, C6, C13 |
| T15 | Tampering | 配置把关 | 一个 profile 驱动的 `tun`/`dns` 块绕过合并校验器，并在一个未授权（或 dev）构建中激活 TUN。 | 在安全环境中进行网络变更 | C7, C13, Owner |

---

## 7. 控制要求

各组（Groups）与（并复用）现有项目模式集成。

### C1 — 已验证的供应链 / 签名的产物（owner 驱动）

- helper 及 helper 的依赖都经过 **Authenticode 签名**，使用的证书是应用通过钉定的指纹
  （pinned thumbprint）来信任的，而不是只信任 OS 信任存储（见 `CODE_SIGNING.md` 输入；
  证书提供商是 owner 决策）。
- 官方的按架构 **`wintun.dll`** 通过发布清单中的**钉定 SHA-256 摘要**验证（效仿
  `mihomo-artifact.ts` 的 `sha256File`/`binarySha256`），其**许可证/来源**记录在
  `THIRD_PARTY_NOTICES.md` 中。Wintun **内核驱动**通过 DLL 加载；Windows 只加载签名驱动，
  因此驱动必须携带 **Microsoft/attestation 签名**——我们**不**自签驱动，也**不**分发自签的
  驱动证书。
- 在**任何**变更之前，激活会验证：
  - helper 的 SHA-256 匹配钉定的发布清单，**且**
  - helper 的 `Get-AuthenticodeSignature` 报告预期的发布者，
  - wintun 的 DLL 摘要匹配清单。
- 自签证书仅适用于 CI "smoke"（冒烟）路径，绝不可用于发布产物；它不能被生产激活路径信任。

### C2 — 防篡改放置

- 在 `Program Files`（或仅当 helper 不需要 Medium-信任保护的放置时的每用户等价物）下安装
  helper 和按架构的 `wintun.dll`。绝不在临时目录或每用户可写处放置特权二进制。DLL 绝不
  从较低信任进程能影响的搜索路径解析。
- 目录 ACL 保护文件免受 Medium-IL 写入；服务/注册表键以**纯允许列表 DACL**创建，专为提升的
  对象设计（设计文档 §5.1——**无** `DENY Everyone`/`DENY Users` 遮蔽所有者的 `ALLOW`）。
  恢复状态存储进一步受**`High` 强制完整性标签**保护，因此即使该同用户 **Medium-IL** 所有者
  与其共享 SID，也不能对它写入/删除/更改 ACL（设计文档 §8.0）。
- 绝不把位于、或从攻击者可写目录（例如 `%TEMP%`、同一用户可写的 app-data 子文件夹）解析的
  路径，提升为提升命令。可信恢复状态**绝不**写入此类路径；它位于 High-IL-only 的
  `%ProgramData%\<brand-independent-id>\tun-state\<ownerSid>\`（设计文档 §8.0）。

### C3 — 认证、授权、防重放的 IPC（COM 提升 moniker 引导）

简单的同用户 SID + 随机名 + nonce 模型**不足够**，因为另一个以*同一用户*身份运行的进程可以
冒充应用，并且 `runas`/`ShellExecuteEx` **无法**跨提升传播可继承句柄列表。因此引导使用
**Microsoft 认可的 COM 提升 moniker（Elevation Moniker）** 流程：应用用
`CoGetObject(L"Elevation:Administrator!new:{CLSID}", BIND_OPTS3, ...)` 激活一个提升的、
进程外 COM 服务器（helper），其中提升代理（elevation broker）认证并中介这次会合，并且
**每次启用都会创建一个按启用的单客户端常驻服务器**（设计文档 §5.5）；其进程生命期绑定到
已启用的 TUN 窗口，并在整个窗口内持有**创建者句柄**（设计文档 §3.3、§3.4）。该契约要求
以下全部条件；任一项失败 ⇒ 关闭并 fail closed：

- **提升 moniker 注册（机器级 HKLM）。** `CLSID` default + `LocalizedString=@...helper.exe,-101`
  + `Elevation\Enabled` = **REG_DWORD `1`** + `LocalServer32`（default = **绝对 helper 路径**，
  外加 `ServerExecutable` = 绝对路径、`AppID`）+ `AppID`（default + `RunAs = "Interactive User"`，
  **纯允许列表**的 `LaunchPermission`/`AccessPermission` DACL，仅向**授权的交互式用户主体** +
  `SYSTEM`（外加在 `LaunchPermission` 中的 `Administrators` 用于安装/修复）授予本地
  启动/激活/访问，使用**显式 COM 权限掩码** `D:P(A;;0xB;;;SY)(A;;0xB;;;BA)`（launch）和
  `D:P(A;;0x3;;;SY)(A;;0x3;;;<ownerSid>)`（access）——**无** `DENY Everyone`/`DENY Users`，
  **无** `Everyone`/`Users`/`Authenticated Users` ACE，并且**根本没有 `DENY`**（一个完整的允许
  列表靠缺席来拒绝；`ANONYMOUS LOGON`/`NETWORK` 由此被拒绝）；由描述符构建的 `AccessCheck`
  测试验证，设计文档 §5.1/§13）。在 `LocalServer32` 下**没有** `ThreadingModel`，也**没有**
  `Elevation` 字符串值。注册位于**与 helper 位宽匹配的注册表视图**中，用
  **`KEY_WOW64_64KEY`/`KEY_WOW64_32KEY`** 标志显式选择（没有字面的 `WOW6432Node` 路径）。
  产品只分发 **amd64/arm64 helpers**，因此我们**只注册 64 位 COM 视图（`KEY_WOW64_64KEY`）**，
  并且**不注册 32 位 COM helper**。注册由安装程序完成，**并由应用的探针重新验证**，绝不通过
  非特权路径。
- **传输是经过认证、加密的 COM 通道，带双向认证 + 数据包隐私。** 应用调用
  `CoInitializeSecurity(..., RPC_C_AUTHN_LEVEL_PKT_PRIVACY, RPC_C_IMP_LEVEL_IMPERSONATE, NULL,
  EOAC_SECURE_REFS|EOAC_STATIC_CLOAKING, NULL)`，并执行 `CoSetProxyBlanket(proxy,
  RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, NULL, RPC_C_AUTHN_LEVEL_PKT_PRIVACY,
  RPC_C_IMP_LEVEL_IMPERSONATE, NULL, EOAC_NONE)`。经过 schema 验证的 `HelperCommand` 信封是
  接口参数（大小受限，无原始命令字符串）。**无应用创建的命名管道；无继承句柄；无用户可读介质
  中的端点名称；不是普通 `CoCreateInstance` + `requireAdministrator`。**
- **客户端（应用）身份在服务端验证。** 每次特权调用，helper 都执行 `CoImpersonateClient()`，
  然后：
  - **PID** —— `RpcServerInqCallAttributes(..., RPC_CALL_ATTRIBUTES_V2, ...)` 用
    `Flags = RPC_QUERY_CLIENT_PID` 读取 **`ClientPID`**（不是 `ClientProcessId`），
  - **传输** —— 断言调用经由本地 **`ncalrpc`**（LPC）到达；拒绝任何 `ncacn_ip_tcp`/远程调用，
  - **令牌/会话** —— `GetTokenInformation(TokenUser / TokenStatistics / TokenIntegrityLevel)`
    显示相同的**登录会话**、相同的**用户 SID**、预期的 **Medium IL**、**令牌类型**，
  - **规范路径 + 签名 + 哈希** —— `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, pid)` +
    `QueryFullProcessImageName` → 规范化后的规范路径，其 SHA-256 摘要和 Authenticode 发布者
    匹配钉定的应用身份，
  然后 `CoRevertToSelf()`。**PID 只是一个用于打开并验证进程对象的句柄——本身永远不是身份**
  （身份 = 登录会话 + 用户 SID + 完整性 + 路径/摘要/发布者 + 会话密钥；被复用的 PID 由路径/
  摘要不匹配捕捉）。即使共享 SID，同用户冒名者（错误的 PID、令牌、路径、摘要、签名者，或
  缺失会话密钥）也会被拒绝。
- **应用认证 helper。** 第一次（`bootstrap`）调用返回 **helper PID**；应用打开它
  （`PROCESS_QUERY_LIMITED_INFORMATION`）并验证其规范路径 + SHA-256 + Authenticode 发布者
  匹配钉定的 helper。一个试图转移 CLSID 的每用户注册会在此检查失败并被拒绝。
- **按启用、单客户端常驻服务器（设计文档 §5.5）。** 每次启用都用 `Elevation:Administrator!new`
  使一个**全新的按启用服务器**被创建。它**绑定到第一个已验证的客户端**，并**拒绝其他所有
  客户端**——包括一个二进制完全相同的第二个 Murge 进程（相同路径、相同 Authenticode、相同
  SHA-256），因为第一个客户端已被绑定。其**进程生命期绑定到已启用的 TUN 窗口**（它在整个窗口
  内持有创建者句柄；设计文档 §3.3/§3.4），并且**只**在以下情况退出：正常禁用完成、启用失败
  恢复完成、紧急恢复后已绑定客户端/内核死亡、握手阶段超时，或显式的全局最大恢复超时。在常驻
  激活期间它**不会空闲退出**。不会复用任何已在运行的 helper。
- **一次性 `launchSecret` 在认证通道内交换**——绝不在命令行、环境变量、普通文件或用户可读的
  注册表值上（这些都能被同用户进程读取）。它用于派生 `sessionKey`，并在握手完成后立即用
  `RtlSecureZeroMemory` 清零。然后 `CoRevertToSelf()`。
- **防重放/反射。** `sessionKey` 用 HKDF 派生（launchSecret、每会话盐 + 对端角色）；每条消息
  都以规范编码（设计文档 §4.3）MAC，带一个**单调 uint64 `requestId`**，一个有界的重放缓存
  拒绝重复或乱序的 id。
- **超时/清理。** 一个**引导握手超时**（例如 5 s），之后 helper 退出，一个**每命令超时**，
  空闲通道关闭，并且在通道关闭、任务结束和 helper 退出时对 `launchSecret` + `sessionKey`
  **清零**（绝不记录日志）。
- **类型化、schema 验证的消息，带固定允许列表。** 操作标识符来自一个**固定允许列表**
  （`probe_integrity`、`create_adapter`、`apply_network_state`、`snapshot`、`restore`、
  `get_status`、`health`、`close_creator_handle`）；每操作的单调 `requestId`（幂等/防重放护栏）；
  helper 内做 JSON-schema 验证（效仿"验证每个 IPC 参数"规则；TS 类型不是运行时验证）；严格的
  大小上限。模型中与允许列表中**都没有** `delete_adapter`/`WintunDeleteAdapter`。
- helper 按策略授权**每个**操作；它不把应用当作整个 admin 来信任。`apply_network_state` 携带
  类型化、已验证的 `DesiredNetworkState`（绝不携带原始命令文本）。

### C4 — 首次变更前的基线 + 已写 + 日志（fail-closed）

- 在一次激活的首次路由/DNS/接口变更之前，helper 写入一个带 schema 版本的 **BaselineSnapshot**，
  按接口以 **LUID/index** 为键，保存**完整**的 IPv4/IPv6 路由行（前缀、前缀长度、下一跳/on-link、
  指标、协议、路由存储）、**有序的每接口 DNS**（每条带 **DHCP/静态来源**），以及接口指标/状态 +
  防火墙配置。它**原子**写入（写临时 → 验证 → 重命名），效仿 `FileSystemProxyBackupStore`。
- helper 的确切写入集合记录为 **WrittenState**，并且每次变更都追加到一个有序的 **write-ahead
  MutationJournal**（设计文档 §8.3–§8.4）：每个操作是一个 **`PREPARED`** 记录（带 before/after 值 +
  基线指纹，**在触碰 OS 之前 fsync**）→ 执行变更 → **`APPLIED`** 记录。这包括在
  `WintunCreateAdapter` 之前写入并 fsync 的 **`CREATE_ADAPTER/PREPARED`**（携带
  `name`/`TunnelType`/`RequestedGUID` 以获得可恢复身份），因此两个记录之间的崩溃会留下一个
  持久的意图，恢复时通过 **`WintunOpenAdapter(Name)` + 身份验证**（`WintunGetAdapterLUID` +
  `ConvertInterfaceLuidToGuid`/SetupAPI）**调和（reconcile）**——**绝不靠假设**。快照或 journal
  写入/验证失败会以零变更**中止**。快照/journal 位于 **High-IL-only 的可信存储**
  （`%ProgramData%\<brand-independent-id>\tun-state\<ownerSid>`，设计文档 §8.0），helper 在**启动时
  验证**它（owner/DACL/reparse），并且其 journal 的**句柄 file-ID 在每次 `PREPARED`/`APPLIED`/
  `RECONCILED` 追加前都会重新验证**（不按字符串路径重新打开）——存储/ACL/reparse/完整性异常
  **会 fail closed**。
- 恢复是**按项且仅限自有**：每一项目与 `WrittenState` 比较，仅当当前值仍等于应用写入的值时才
  回退到其基线。一个被外部修改的项目被报告为**按项冲突**（`conflictDetail`：LUID/index、family、
  field、expected vs current）并保持不动；它**不会**阻止恢复其他自有项目，也**不会**触发覆盖
  其他被外部修改的项目（绝非全有或全无）。

### C5 — 显式提升，最小权限

- 无自动提升。激活只由显式用户操作触发。
- 应用通过用户看到的显式同意打开 helper（由 COM 提升代理显示的一个 UAC 提示）；每次启用创建一个
  **按启用的单客户端常驻服务器**，其**进程生命期绑定到已启用的 TUN 窗口**（它在整个窗口内持有
  创建者句柄；设计文档 §3.3/§3.4/§5.5）。helper 运行在 **High IL** 但带一个**受限令牌**，其启用
  特权恰好是所需那些。该限制**保留 `Administrators`（`BA`）组 SID 为启用状态且不是 deny-only**，
  因为可信状态 DACL 通过那个 ACE 授权 helper；helper 在启动时验证这一令牌属性，若缺失则在网络
  变更前 fail closed。所需特权包括用于 `WintunCreateAdapter(Name, TunnelType, RequestedGUID)`
  调用的 `SeLoadDriverPrivilege`；路由添加/删除通过 DNS/路由 API 授予，而不是宽泛 admin。
- 适配器生命期是**显式**的（设计文档 §3.3）：禁用时 mihomo 结束其会话并关闭其打开的句柄，然后
  helper 验证所有权（`Name`/`RequestedGUID`/LUID）并调用**`WintunCloseAdapter(creatorHandle)`**——
  这是移除 create 创建的适配器的**唯一**操作。**没有** `WintunDeleteAdapter`，**没有**
  `ERROR_REBOOT_REQUIRED` 适配器删除返回，也**没有** `delete-pending` 状态。它**只**移除一个它能
  证明由自己创建的适配器（自己的 `Name`/`RequestedGUID`），绝不会是预先存在/共享的适配器或驱动
  （C9）；**`WintunDeleteDriver` 绝不会被调用**。
- helper 是一个无控制台、无自有网络监听器（除其 IPC 外）、无意外 admin shell 的专用进程。它绝不
  创建/持有 Wintun 数据包会话——mihomo 拥有数据平面（A8），而 mihomo 能否复用 helper 创建的适配器
  是 G1 关卡。

### C6 — renderer/密钥隔离与最小面

- helper/设备句柄和任何 helper 密钥**绝不**跨入 preload/renderer。
- helper 不暴露通用命令、不暴露任意路径参数，也不暴露原始 PowerShell/命令字符串（由 schema +
  允许列表强制执行，§C3）。
- renderer 只**读取**来自 `get_status`/状态事件的 `TunStatus`。它可发出**类型化、无参数的意图**
  （`requestEnable`/`requestDisable`），由主进程的 `TunService` 验证并执行；它绝不触碰 helper、不传递
  任意参数，也不自行变更状态（效仿现有的代理规则——renderer 不能乐观地翻转状态）。不存在
  renderer→helper 路径。

### C7 — 配置把关权限

- 在 `mihomo-config.ts` 中对 `tun.enable:false`/`dns.enable:false` 的放宽是一个**单一、经评审的**
  带测试变更，它 (a) 保持对开发安全的默认值，且 (b) 仅当 Windows helper 存在且被授权时才允许激活。
  一个 profile 试图在该路径之外启用 TUN/DNS 会继续 fail closed。
- 一个非 Windows 构建必须返回一个显式的**不支持/被阻止**结果（按 `DEVELOPMENT_SAFETY.md`），绝不
  静默启用 TUN。

### C8 — 按项仅自有恢复（绝不覆盖，绝非全有或全无）

- 禁用/回滚只恢复 helper 记录的那些基线值，并且仅当当前值仍然**匹配** helper 先前写入的值
  （owned-state 语义，效仿代理适配器中的 `isOwned`/`matchesPrevious`），**按项**评估（按 LUID/index、
  按地址族、按字段）。
- 被外部修改的项目产生类型化的**按项冲突**（`conflictDetail`：LUID/index、family、field、expected vs
  current）并保持不动，而**无关的自有项目仍被恢复**。只有当任何自有项目被外部修改时 Phase 才变为
  `conflict`；否则恢复完成为 `configured`。恢复绝不因为一个无关的外部变更而变成全有或全无操作，
  也绝不覆盖被外部修改的项目。

### C9 — 幂等、崩溃安全的禁用与紧急路径

- 禁用/恢复是幂等的，可安全地重复运行；重入或失败的禁用绝不留下部分应用的状态。
- **紧急禁用**路径独立于 GUI 和 mihomo 进程：一个已文档化、owner 可运行的恢复（服务命令、捆绑的
  `--recover` 模式，或 helper 接受的 `.cmd`），即使应用已死也能恢复基线快照。它绝不能要求它正要
  修复的网络。

### C10 — 强制终止 / 崩溃后的恢复

- helper 将其变更及其目标撤销记录在磁盘上的 **mutation journal** 外加 **WrittenState** 与
  **BaselineSnapshot** 中，应用在下次启动时读取以调和。如果 helper 在激活中途被杀，下一次 `init()`
  （或紧急路径）针对 journal + 基线**按项**调和，只恢复应用所拥有的。以每个状态下的强制终止测试。
- **不同的异常退出路径（设计文档 §3.4）。**
  - **TUN 启用时应用或 mihomo 死亡：** helper **复制并监控**已绑定应用和 mihomo 两个进程句柄；其中
    任一异常退出时，它运行一个**有界的紧急恢复**（先逐项恢复路由/DNS，然后关闭创建者句柄，然后
    持久化结果并退出）。如果恢复失败，它**仍关闭创建者句柄**（绝不留无数据平面的 TUN 适配器），并为
    下一次恢复**保留 journal**，由显式的全局最大恢复超时封顶。
  - **helper 自身崩溃：** Windows 自动关闭其句柄，因此适配器**被移除**（0.14.1）。下一次
    `init()`/`--recover` 启动一个**新的恢复 helper**，它**不声称**调用 `WintunCloseAdapter`（它没有旧
    的创建者句柄），验证适配器已消失，并恢复残余的路由/DNS。如果适配器仍存在但新 helper **无法证明/
    拥有创建者句柄**，它**标记一个冲突**，**保留证据**，并且**绝不删除它**（C9）。

### C11 — 路由/DNS/IPv4/IPv6 共存（不失连通性）

- 路由/DNS 规则必须保留 loopback、LAN 和机器自身的连通性；auto-route 排除管理/loopback 路径。IPv4
  **和** IPv6 默认路由与 DNS 服务器都被记录并恢复。
- DNS 劫持限定在 TUN 接口名，带显式排除列表，并且如果预期适配器的物理属性缺失就 fail closed。
- 睡眠/唤醒与网络变更（接口上/下、DHCP 续租）事件会重新调和：在恢复或变更时，helper 重新断言 TUN 并
  重新验证基线未改动，遇冲突则 fail closed。

### C12 — 证据的完整性/真实性

- **确定性契约（round-6），取代原先的"HMAC/摘要保护或至少摘要"措辞。** 完整性边界是**存储 DACL +
  强制完整性标签**，而不是一个同用户攻击者也能改写的加密摘要：
  - 恢复状态位于 **`%ProgramData%\<brand-independent-id>\tun-state\<ownerSid>\`**（设计文档 §8.0），
    由**提升的 helper**创建，**owner = SYSTEM**，带**可解析的纯允许列表 SDDL**
    `O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)` + `S:(ML;OICI;NW;;;HI)`——**无 `DENY`**，也**无
    owner-SID ACE**（Medium UI 没有原始读取路径；它通过 helper COM 读取净化后的状态），外加一个
    **`High` 强制标签**（`NO_WRITE_UP`，`HI` = `S-1-16-12288`）。一个**同用户 Medium-IL 攻击者无法
    读取、写入、删除或重新 ACL 该存储**：它没有 owner-SID ACE，它的 `Administrators` 成员在 UAC 下是
    deny-only，并且 MIC write-up 在其共享所有者 SID 的情况下也阻止它——因此该存储**完全不可被用户写入**。
    **只有 High-IL helper 能访问它**（其令牌启用了 `Administrators` 组，故它经由 `BA` ACE 到达）。
  - 在该边界内，每条记录携带 **`schemaVersion` + 一个 SHA-256 摘要**（`state.manifest`），并且**仅由
    helper**写入（所有者的 Medium UI 绝不打开原始文件；它只通过 helper COM 读取**净化后**的状态）。
    该摘要检测**意外损坏/截断**——它**不**被呈现为防篡改的真实性。
  - **不声称磁盘状态 HMAC。** HMAC 需要一个密钥位置、密钥生成、**DPAPI** 保护、轮换和升级/恢复读取路径，
    这些**都不**提供，因此移除 HMAC 措辞；通道信封 MAC（IPC，设计文档 §4.3）是认证 COM 通道上的
    **独立的、逐消息**认证器，不是磁盘状态的声称。
  - **Fail closed。** 在读取失败、ACL 错误、owner 错误、发现 reparse 点或 schema/摘要异常时，helper 执行
    **零网络修改**并进入 **`restore-failed`**，保留该存储供人工/`--recover` 决策。
- 一个结构化、机器可读的记录（`service`、route、DNS、TUN 设备、phase 转换、快照摘要）在每次转换时写入
  可信存储（C04/C07 缓解措施）。
- 日志绝不能包含凭据、订阅 URL、controller 密钥或明文 helper 密钥。

### C13 — 测试/证据把关（仅一次性 Windows）

- 所有真实 TUN 行为只由一个**受把关的** Windows CI 作业执行，该作业：
  - 除非 `MURGE_RUN_REAL_TUN=1` **且**为 `win32`，否则被跳过（因此从不在默认 `npm test` 中运行），
  - 在前后捕获主机 `NetworkSnapshot`，如果任何安全相关字段意外改变则**fail closed**，
  - 证明 helper**从不丢失 VM 连通性**，禁用/卸载把路由和 DNS 恢复到确切的先前状态，并且恢复在强制
    进程终止后仍能存活，
  - 记录 service、route、DNS 与非代理感知请求的证据。

---

## 8. Fail-closed 不变量（在代码与测试中断言）

1. **无已验证 helper，即无变更。** 未验证签名/校验和或 IPC 认证失败的激活执行零变更。
2. **无快照，即无变更。** 基线在首次变更前写入并验证。
3. **冲突 ⇒ 不覆盖，按项。** 被外部修改的自有项目被报告（`conflictDetail`），绝不覆盖；无关的自有
   项目仍被恢复（按项，而非全有或全无）。
4. **renderer 只发意图。** renderer 读取状态，可发出类型化、无参数的意图（`requestEnable`/
   `requestDisable`）；只有串行化的主进程 `TunService`（promise-queue，效仿代理服务）发出对 helper
   的命令。无 renderer→helper 路径。
5. **无提升 shell。** 无原始命令字符串、无任意路径、固定的命令允许列表。
6. **Mac/无驱动 ⇒ 显式不支持/被阻止。** 非 Windows 构建绝不启用 TUN。

---

## 9. 映射到 Phase 9 路线图行

| 路线图行 | 主要威胁 | 所行使的控制 |
|---|---|---|
| 编写并批准 helper/权限威胁模型 | （本文档） | — |
| 定义安装/升级/回滚/卸载行为 | T02, T04, T05, T10 | C1, C2, C4, C8, C9, C10, C12 |
| 实现显式提升流程 | T12, T14 | C5, C6, C13 |
| 验证驱动/helper 签名与二进制完整性 | T01, T02, T13 | C1, C2 |
| 实现 TUN configured/starting/active/failed 状态与恢复状态（restoring / restore-failed / conflict / unsupported） | T10, T11 | C5, C7, C13 |
| 添加独立于 GUI 的紧急禁用与清理路径 | T07, T10 | C9, C10 |
| 测试 DNS、IPv4、IPv6、睡眠/唤醒、网络变更、崩溃恢复 | T03, T06, T10 | C10, C11, C13 |
| 记录 service/route/DNS 与非代理感知请求证据 | T07, T08 | C12, C13 |

---

## 10. Owner 决策（已解决 + 待解决）

由 owner 解决（对实现生效）：

1. **D1 — 设备模型：** **带签名 wintun（官方 WireGuard 发行版）。** 分发按架构的 `wintun.dll`
   （摘要钉定）并经由它加载带签名的 Wintun 驱动；绝不分发裸驱动文件或自签驱动/证书；**mihomo 拥有 TUN
   数据平面**（A1、A8、C1、C2）。
2. **D2 — Helper 形态：** **独立的提升 helper** 进程，而非 Windows 服务。（A2、C2、C5。）注意：以后若把
   D2 改为服务，需要撤销此决策，因为设计评审包（`docs/helper-design.md`）假设的是一个独立 helper。
3. **D3 — 适配器/驱动创建时机：** **首次启用时。** `wintun.dll` 在安装时暂存；Wintun 内核驱动的安装/加载
   与适配器创建**只在用户首次显式启用时**、在 `WintunCreateAdapter` 内部发生——**没有单独的驱动加载操作**。
   （A3。）
4. **D6 — OS 网络配置所有者：** **helper 是唯一的路由/DNS/接口修改者（选项 A）。** 主进程生成类型化的
   **`DesiredNetworkState`**，mihomo 的运行时配置有 `auto-route:false` / `auto-detect-interface:false` /
   `dns-hijack:false`，helper 逐字应用该状态。（A4、C7。）

实现开始前仍需决定：

5. **G1 — mihomo 是否复用 helper 创建的适配器。** **未经证明的假设；必须由 **G1 生命周期探针**证明
   （设计文档 §3.3、§12）：(a) helper 创建并持有**创建者句柄**；(b) mihomo `WintunOpenAdapter(Name)` +
   `WintunStartSession`；(c) helper `WintunCloseAdapter(creatorHandle)` / 退出；(d) 观察会话 + 适配器是否
   持续存在。两种结果是 **Observed A**（适配器被移除 ⇒ 确认 helper 必须在启用窗口内持有创建者句柄）/
   **Observed B**（mihomo 持有句柄时适配器存活 ⇒ 后续可优化为更早退出 helper）。**两者都不改变固定的安全
   基线**（设计文档 §0.4/§3.3/§5.5）：helper 是一个按启用的单客户端**常驻**服务器，在整个启用窗口内持有
   创建者句柄。它在一个可打快照、可带外恢复的 Windows VM 上、在受关卡的 CI（T0）中运行，**在任何 Phase 9
   helper 实现开始之前**，并且**绝不在本开发机上**。如果它失败/仍悬而未决，就停下并回到 owner 寻求修订后的
   所有权决策——不要回退到双重所有权。
6. **证书提供商与信任模型。** helper 和驱动用哪个 CA/证书；wintun 已由厂商签名——确认这是被依赖的产物，
   并且我们钉定其发布者。（影响 C1——见 `CODE_SIGNING.md`。）
7. **DNS 劫持范围。** DNS 是委托给 mihomo 的 dns-hijack、helper，还是留给 system-proxy 路径，以及排除列表。
   （在 D6 下 helper 拥有 DNS；排除列表仍需设置。）（影响 C11。）
8. **D4 — 已解决：无开机自启。** 不安装服务、计划任务、`Run` 键或后台启动触发器。独立 helper 只从显式启用
   操作或显式手动 `--recover` 启动；被动的启动/状态检查绝不启动它。
9. **D5 — 已解决：绝不移除预先存在/共享的 Wintun 状态。** 绝不调用 `WintunDeleteDriver`；绝不删除预先存在/
   外来的适配器；卸载时不移除任何共享驱动/适配器。只关闭那个由当前启用会话创建并拥有的确切适配器的持续
   持有的创建者句柄。
10. **HTTPS 解密/改写可见性。** 这些页面在 v1 中是保持可见 / 实验性 / 移除（已经在 owner backlog 中；影响 TUN
    设备是同时覆盖代理 HTTPS 还是只覆盖透明/非代理感知流量）。
11. **睡眠/唤醒与网络变更调和深度。**（影响 C11；实现前需要一个测试计划。）

---

## 11. 设计评审的开放问题

- 项目是否接受 Phase 9 **只**在带快照和带外恢复路径的一次性 Windows VM 上运行，并且绝不在开发机上执行？
- TUN 是否应该是**可选且默认关闭**（推荐），并在非 Windows 构建上显示为"unsupported"？
- helper 在执行一次变更之前必须收到的确切 **owner 授权**是什么，以及如何记录下来以复现？
- helper 应该复用哪些现有模式（backup store、owned-state restore、promise-queue mutex、fail-closed
  adapter），边界允许在何处偏离？
