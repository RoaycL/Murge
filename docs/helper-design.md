# Phase 9 — Windows TUN 特权 helper：设计评审包（rev. 8）

> 状态：**设计评审草稿（rev. 8）。** 仅设计/契约层面。未在本机执行任何代码执行、
> 任何网络变更、任何驱动/路由/DNS 修改。本修订解决了第二轮评审（round-5，§0.4）
> 中七个必须修复项：统一的每次启用单客户端常驻 helper、Observed A/B、
> WAL 顺序、三条崩溃恢复路径、WOW64 位数标志、以及 `%ProgramData%` 恢复状态存储；
> 并解决了**两个 round-6 安全阻塞项**（§5.1、§8.0、§8.3、§13）：一个
> **纯允许列表 COM/DACL/SDDL 契约**，以及一个**可信、高完整性、抗目录替换的恢复状态存储**，
> 带有一个**确定性完整性契约**（完整性术语 "HMAC/digest 或至少 digest" 已移除 — C12）。
> **Round-7 纠正了实际的 Windows 安全描述符契约**（§5.1、§8.0、§13、安装文档 §2/§8）：
> COM ACL 使用**显式 COM 权限掩码**（`0xB`/`0x3`，**无通用 `GX`**），无额外
> `DENY`，并且状态目录使用一个**可解析、完整的 SDDL**
> （`O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)` + `S:(ML;OICI;NW;;;HI)`），带有
> **无 owner-SID 文件 ACE**（Medium UI 没有原始读取路径）。**Round-8 纠正了
> 描述符转换/持久化契约**：SDDL 转换已经返回自相对数据；注册表 `REG_BINARY` 仅适用于 COM 描述符；
> 文件系统 API 应用/读取状态目录描述符；SYSTEM 被两个 COM ACL 都允许；并且受限 helper 必须
> 保留一个已启用、非 deny-only 的 `BA` SID。实现门槛仍然**未满足**，并且
> 在任何 Windows 实现之前需要设计评审签核以及另行所有权授权。
> 特别是 **G1（mihomo 复用 helper 创建的适配器）是一个未经验证的假设**，是硬性阻塞门槛，而不是
> 已确立的契约。

所有者提供的决策（已生效）：

- **D1 = 已签名 Wintun（官方 WireGuard 发行版）。** 发布官方
  每架构 `wintun.dll`；已签名的 Wintun 内核驱动在 `WintunCreateAdapter` 期间
  **由 DLL 按需加载**——**没有单独的驱动加载操作**，
  并且仅 `LoadLibraryEx(wintun.dll)` 自身**不会**安装/加载驱动。
- **D2 = 独立的提升 helper 进程**（不是 Windows 服务）。
- **D3 = 首次启用时创建 Wintun 适配器/驱动**（`wintun.dll` 由安装器暂存，
  但驱动仅安装 + 适配器仅在用户的首次显式启用时创建，在 `WintunCreateAdapter` 内）。

配套文档：`docs/helper-threat-model.md`、`docs/helper-install-upgrade-rollback.md`。
引用的惯例：`src/shared/system-proxy.ts`、`src/shared/ipc.ts`、
`src/shared/gateways.ts`、`src/main/system-proxy/service.ts` 与 `adapters/*`、
`src/main/kernel/mihomo-config.ts`、`src/main/kernel/mihomo-artifact.ts`。

---

## 0. 评审决议

### 0.1 第二轮评审修复（rev.3 — 保留）

| # | 发现 / 决议 |
|---|---|
| 1 | 虚构的独立 `load_driver` 操作已移除；驱动在 **`WintunCreateAdapter`** 内安装/加载；适配器按名称标识；**G1** 被标记为未验证（§1.3、§12）。 |
| 2 | 启用顺序已修复，使路由/DNS 跟随适配器创建；按逆日志顺序恢复（§10.1、§8.4）。 |
| 3 | 单一 OS 配置所有者**方案 A**；mihomo `auto-route:false`/`auto-detect-interface:false`/`dns-hijack:false`；类型化 `DesiredNetworkState`（§1.1、§9）。 |
| 4 | 提升引导重写为可执行的 **COM 提升标记（elevation-moniker）序列**；`runas` 无法继承句柄（§5）。 |
| 5 | 密钥生命周期：仅在完成握手后清零 `launchSecret`；保留 `sessionKey` 直到通道关闭/任务结束；所有路径上使用 `RtlSecureZeroMemory`；长度前缀的规范 MAC（§4.2、§4.3）。 |
| 6 | 类型修复：`dnsSets` 闭合 `>`；`NET_LUID` 作为规范十六进制字符串；`requestId` 单调 uint64 十进制字符串（§8.1）。 |
| 7 | 扩展测试/证据矩阵（§13）。 |

### 0.2 第三轮评审修复（rev.4 — 已被取代）

| # | 发现 | 决议（本文档） |
|---|---|---|
| 1 | Wintun ABI 错误：`WintunCreateAdapter(LUID*, Name, TunnelType, Session*)` 是不正确的签名 | **从官方 `wintun.h` 逐字修复**（§3.0，固定 **0.14.1**，记录架构/导出符号/头文件来源）：`WintunCreateAdapter(Name, TunnelType, RequestedGUID) -> WINTUN_ADAPTER_HANDLE`；`WintunGetAdapterLUID(Adapter, &Luid)`；`WintunStartSession(Adapter, Capacity)` 创建数据包会话；`WintunEndSession` 结束会话；`WintunCloseAdapter` 释放句柄（对由 create 创建的适配器，会将其移除）。"Wintun 没有 RequestedGUID 参数"的断言**已撤回** — `RequestedGUID` 是真实参数（§3.0、§3.2）。固定版本 + 架构 + 导出符号 + 头文件来源均已记录。 |
| 2 | 提升引导使用普通 `CoCreateInstance` + `requireAdministrator` 而非官方 COM 提升标记 | **已改写为 COM 提升标记流程**（§5.1–§5.2）：客户端使用 `CoGetObject("Elevation:Administrator!new:{CLSID}", BIND_OPTS3, ...)`；完整的 HKLM `CLSID`/`LocalizedString`/`Elevation`/`LocalServer32`（绝对路径 + `ServerExecutable`）/`AppID`/`LaunchPermission`/`AccessPermission` 均已列出；`RunAs = "Interactive User"`（Activate-as-Activator）；显式 `CoInitializeSecurity`/`CoSetProxyBlanket` 的 authn/impersonation/packet-privacy 参数。**下方 round-4 修正**（`Elevation\Enabled = REG_DWORD 1`，`ThreadingModel` 已移除，WOW64/位数位置已注明）。 |
| 3 | RPC 客户端 PID 错误：使用了 `RPC_CALL_ATTRIBUTES_V2.ClientProcessId` | **已修复为 `RPC_CALL_ATTRIBUTES_V2.ClientPID`**，带 `Flags = RPC_QUERY_CLIENT_PID`；断言调用通过本地 **`ncalrpc`** 到达；PID **仅用于打开并验证进程对象**（路径/摘要/发布者/会话密钥），绝不单独作为身份（§5.2、§5.4）。 |
| 4 | 日志并不是真正的 write-ahead（先创建适配器，再写日志意图） | **真正的 write-ahead 日志**（§8.3–§8.4）：`BaselineSnapshot` 先行提交；`CREATE_ADAPTER/PREPARED`（在 `WintunCreateAdapter` **之前** fsync）；之后 `CREATE_ADAPTER/APPLIED`；每个路由/DNS 操作都是 `PREPARED` → 变更 → `APPLIED`；任何两条记录之间崩溃由**列举产品适配器/当前 OS 状态**调停（PREPARED-but-unknown）。 |
| 5 | 无显式适配器删除；声称最后会话/句柄关闭会自动删除 | **已纠正为真实的 0.14.1 生命周期**（§3.3）：**没有 `WintunDeleteAdapter`**；由 `WintunCreateAdapter` 创建的适配器**仅**由 `WintunCloseAdapter(creatorHandle)` 移除；**没有 `RebootRequired` 适配器删除返回，也没有 `delete-pending`** 状态（唯一重启可见的产物是 Wintun 驱动，我们从不删除）。由于 creator 句柄是适配器的生命周期锚点，helper 必须在整个启用窗口内保持该句柄 — **经过证明，而非假设**，通过 **G1 lifecycle probe**（§3.3；固定的常驻生命周期见 round-5，§0.4/§3.3/§5.5）。自动删除和显式 `WintunDeleteAdapter` 的声明**均已移除**。 |
| 6 | 可复用的提升 helper 让第二个进程得以附加 | **每个激活、单客户端提升服务器**（§5.5）：每次启用使用 `Elevation:Administrator!new` 创建全新服务器，它**绑定第一个经过验证的客户端**，并**拒绝所有其他客户端**（包括路径/签名/哈希都相同的第二个 Murge 进程）。**Round-4 修正**：服务器的**进程生命周期绑定到已启用的 TUN 窗口**（它持有 creator 句柄），而非绑定到一条 IPC 命令 — 每次启用时全新激活，并在禁用/回滚时退出（helper 在整个启用窗口内持有 creator 句柄；见 round-5，§0.4/§3.3/§5.5）。已加入二次实例竞态测试（§13）。 |
| 7 | G1 仍未被证明 | 作为**实现前硬性门槛**保留。探针现在是 **G1 lifecycle probe**（§3.3、§12、§13）：创建 + 持有 creator 句柄 → mihomo 按名称打开 + 启动会话 → helper 关闭 creator 句柄/退出 → 验证会话 + 适配器持续存在；两个**观察结果**（A = 适配器在 creator 关闭时消失，B = 在 mihomo 持有句柄时存活 — §0.4/§3.3）。每个先前的"短命 helper"声明**均已移除**。它只能在受保护的 `phase9-tun-lab` 环境背后、另行授权的、可快照的、带外可恢复的自托管 Windows 实验室中运行 — **绝不在本开发机或通用托管运行器上**。 |

### 0.3 第四轮评审修复（rev.6 — 保留）

| # | 发现 | 决议（本文档） |
|---|---|---|
| 1 | 把不存在的 `WintunDeleteAdapter`（+ `RebootRequired`/`delete-pending`）混入了固定的 0.14.1 ABI | **已从整个设计中删除。** **官方 0.14.1 `wintun.h` 是唯一的 ABI 来源。** 移除是 `WintunCloseAdapter(creatorHandle)`，它只对由 create 创建的适配器"移除适配器"；没有 `WintunDeleteAdapter`、没有 `WintunFreeSendPacket`、没有 `RebootRequired` 适配器删除返回、没有 `delete-pending` 状态（§3.0、§3.3）。 |
| 2 | `WintunDeleteDriver` 的语义描述错误 | 该符号**确实**被导出（`BOOL WINAPI (VOID)`），但生产策略**禁止调用它** — 如果无适配器在使用，它会移除共享的 Wintun 驱动并影响其他 Wintun 消费者（D5）。在导出表中注明（§3.0）且从不调用。 |
| 3 | 短命 helper 与 creator 句柄生命周期的矛盾未解决 | **由 G1 lifecycle probe 解决**（§3.3）：因为 creator 句柄是适配器的生命周期锚点，所以该模型是**经过证明的，而非假设**。探针演练 a–d；两个结果记录为 **Observed A**（creator 句柄关闭时适配器被移除）和 **Observed B**（mihomo 持有自己的打开句柄时适配器存活）。**Round-5 取代了 B1/B2 架构框架**（§0.4/§3.3）：**安全基线是固定的** — helper 在整个启用窗口内持有 creator 句柄 — A/B 观察仅影响潜在的未来优化，**绝不**影响基线。G1 仍是**硬性门槛**（它必须证明 mihomo 复用同一适配器）。 |
| 4 | COM 提升的 `Elevation` 默认值是字符串 `"Enabled"`；未解释的 `ThreadingModel`；无数位/WOW64 说明 | **已修复**（§5.1）：`Elevation\Enabled` 是 **REG_DWORD `1`**（不是字符串）；`LocalServer32\ThreadingModel` **已移除**；**位数/WOW64 注册位置**通过 **`KEY_WOW64_64KEY`/`KEY_WOW64_32KEY`** 标志说明（无字面 `WOW6432Node` 路径）；由于产品仅发布 **amd64/arm64 helper**，我们明确**不注册 32 位 COM helper**（§5.1）。 |
| 5 | WAL 删除/恢复仍提及删除适配器 | **已改写**（§8.3–§8.4）：`CREATE_ADAPTER/APPLIED` 存储 `{Name, RequestedGUID, LUID}`；恢复**通过 `WintunOpenAdapter(Name)` 重新打开**并通过 `WintunGetAdapterLUID` + `ConvertInterfaceLuidToGuid`/SetupAPI 验证 `RequestedGUID`；仅在与**精确身份匹配**时才关闭 creator 句柄 / 运行产品生命周期清理；如果 creator 句柄已因崩溃关闭，**先观察适配器是否自动消失**再标记 `RECONCILED`。没有 `WintunDeleteAdapter`。 |
| 6 | 导出表不同步；无 ABI 检查产物 | 导出表是**逐字的 0.14.1 `Wintun_*_FUNC` 集合**（§3.0），包括 `WintunOpenAdapter`、`WintunGetRunningDriverVersion`、`WintunSetLogger`、以及已导出但禁止的 `WintunDeleteDriver`；移除了不存在的 `WintunFreeSendPacket`。**构建时 `dumpbin`/`GetProcAddress` ABI 检查**已加入（§3.0、§13）。 |
| 7 | G1 探针措辞是"一次性最小化" | **已重命名/扩展为 G1 lifecycle probe**（§3.3、§12、§13）：创建 + 持有 creator 句柄 → mihomo 按名称打开 + 启动会话 → helper 关闭 creator 句柄/退出 → 验证会话 + 适配器持续存在；探针**绝不在本机运行**（需要可快照、带外可恢复的 Windows VM + 门控 CI + 另行所有权授权）。 |

### 0.4 第五轮评审修复（rev.6 — 保留）

| # | 发现 | 决议（本文档） |
|---|---|---|
| 1 | helper 生命周期仍是"每次启用/禁用一个全新 helper"；禁用时无法触及旧的 creator 句柄 | **统一为一个常驻模型**（§3.3、§5.5）：一个**每次启用单客户端 helper**。`enable` 激活它；它绑定单一客户端、创建适配器，并在**整个启用窗口内持有 creator 句柄**（`resident-active`，§3.4）；`disable` 由**同一实例**通过**同一 COM 代理**服务。不再保留"每次事务一个全新 helper"的措辞。 |
| 2 | 未定义应用/mihomo 异常退出 | **已加入**（§3.4）：helper**复制并监视**绑定应用和 mihomo 进程句柄；任一异常退出时它运行**有界紧急恢复**（先路由/DNS → 关闭 creator 句柄 → 持久化结果 → 退出）。恢复失败时它**仍关闭 creator 句柄**并**保留日志**用于下次恢复。超时区分**active idle** 与握手/命令超时；**resident-active 时无 idle 退出**。 |
| 3 | 未定义 helper 自身的崩溃 | **已加入**（§3.4）：helper 死亡时，**Windows 自动关闭 creator 句柄 ⇒ 适配器被移除**（0.14.1）。下次 `init()`/`--recover` **启动新的恢复 helper**，它**不会**声称调用 `WintunCloseAdapter`，**验证适配器已消失**，并恢复残余路由/DNS；如果适配器仍然存在但新 helper **无法证明/拥有 creator 句柄**，则**标记冲突**、**保留证据**、并**不删除**它（D5）。 |
| 4 | 混淆的 B1/B2 架构命名 | **已移除**（§3.3、§12、§13）。替换为 **Observed A**（适配器在 creator 关闭时消失）/ **Observed B**（mihomo 句柄使其存活）。**安全基线是固定的** — helper 在整个启用窗口内持有 creator 句柄 — 并且**不依赖**该观察。G1 证明 mihomo **复用同一适配器**；A/B 观察仅决定未来优化，绝不决定基线。 |
| 5 | COM 服务器被标记为"短命事务服务器" | **已改为每次启用单客户端常驻服务器**（§5.5），带**详尽**的退出条件列表（正常禁用；启用失败恢复；紧急恢复后的边界客户端/kernel 死亡；握手阶段超时；显式全局最大恢复超时）。**resident-active 时无 idle 超时。** |
| 6 | WOW64 路径写为 `HKLM\Software\WOW6432Node\Software\Classes` | **已修复**（§5.1）：用 **`KEY_WOW64_64KEY`/`KEY_WOW64_32KEY`** 标志描述视图；由于产品仅发布 **amd64/arm64 helper**，我们明确**不注册 32 位 COM helper**（因此从不创建 32 位/WOW64 视图）。 |
| 7 | 常驻模型的状态机和测试未扩展 | **已加入**（§10.2 helper `resident-active` 状态；§13 测试）：启用 → 长时间无 IPC ⇒ 适配器仍存在；禁用使用**同一 helper PID**（enable PID == disable PID 记录在证据中）；三条**不同**恢复路径（应用崩溃 / mihomo 崩溃 / helper 崩溃）；新恢复 helper **无旧 creator 句柄**；helper 崩溃 ⇒ 适配器消失 + 路由/DNS 恢复。 |

### 0.5 第六轮评审修复 — 两个安全阻塞项（rev.6 — 保留）

| # | 发现（阻塞项） | 决议（本文档） |
|---|---|---|
| 1 | COM ACL/SDDL 使用 `DENY Everyone` + `DENY built-in Users` + `ALLOW some-interactive-user-SID`，把合法用户锁在门外（所有者是 Everyone 和 Users 的成员） | **纯允许列表 DACL**（§5.1）：`LaunchPermission` `D:P(A;;0xB;;;SY)(A;;0xB;;;BA)(A;;0xB;;;<ownerSid>)`；`AccessPermission` `D:P(A;;0x3;;;SY)(A;;0x3;;;<ownerSid>)`（**显式 COM 权限掩码** `0xB` = EXECUTE\|EXECUTE_LOCAL\|ACTIVATE_LOCAL；`0x3` = EXECUTE\|EXECUTE_LOCAL；**无通用 `GX`**）。**无** `DENY Everyone`/`DENY built-in Users`，**无** `Everyone`/`Users`/`Authenticated Users`。**完全无 `DENY`**（完整的纯允许列表通过缺席来拒绝；`ANONYMOUS LOGON`/`NETWORK` 也这样被拒绝）。SYSTEM（本地启动/激活/访问）；安装时所有者 SID（Local Launch/Activate/Access）；Administrators 仅用于安装/修复且**不在** `AccessPermission` 中。**逐 ACE 表**（对象 SID / 允许-拒绝 / 权限位）+ **AccessCheck** 验证（测试 `T24`）。 |
| 2 | 可信恢复状态是"应用数据（Medium/High）" — 模糊且用户可写 | **确定性存储**（§8.0）：`%ProgramData%\<brand-independent-id>\tun-state\<ownerSid>\`。由**提升的 helper** 创建；所有者 = SYSTEM；**可解析的纯允许列表 SDDL** `O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)` + `S:(ML;OICI;NW;;;HI)`（所有者 SYSTEM；`SY`/`BA` `GA`；**无所有者 SID ACE** — helper 通过 `BA` 访问它，因为它以管理员身份运行；Medium 有 `BA` deny-only + 无 ACE + High 标签）；**`High` 强制完整性标签**（`NW`/`NO_WRITE_UP`，`HI` = `S-1-16-12288`）— Medium/High 拆分需要 MIC + 缺失的 owner ACE（helper 和 Medium UI 共享一个 SID，因此仅靠 ACL 无法区分它们）。所有者 UI 通过 helper COM **仅**读取**清洗后的**状态（绝不读取原始 baseline/journal）。每条记录仅由 helper 写入；每个文件以 `FILE_FLAG_OPEN_REPARSE_POINT`（+ `FILE_FLAG_BACKUP_SEMANTICS`）打开，**拒绝** symlink/junction/mount/reparse point，复用持有的句柄 + `FileIdInfo` 重新验证（绝不按字符串路径重新打开），先写临时文件 → `FlushFileBuffers` → `ReplaceFile`/原子重命名，并且**绝不跟随用户可控路径**。升级/卸载**保留**该目录，仅在安全恢复完成后清理。 |
| 3 | 完整性被表述为"HMAC/digest 或至少 digest"（可选） | **确定性完整性契约**（§8.0，C12）：主要安全边界是**Medium 不可写的 DACL + 完整性标签**，而不是同用户攻击者能重写的摘要；记录仍携带 `schemaVersion` + SHA-256 以检测**损坏**；**HMAC 声明已移除**（不存在密钥位置/生成/DPAPI/轮换/升级读取路径）；通道信封 MAC（§4.3）是独立的逐消息认证器，不是磁盘状态声明。任何读取失败、错误 ACL、错误所有者、发现的 reparse point、或 schema/摘要异常 ⇒ **零网络变更** + `restore-failed`。 |
| 4 | WAL 未针对目录替换防御 | **目录替换防御**（§8.0、§8.3）：在 `init`/`--recover` 时验证存储目录的所有者/DACL/reparse；每次 `PREPARED`/`APPLIED`/`RECONCILED` 追加前重新验证已打开的句柄仍指向同一文件/目录（文件 ID）— **绝不**通过字符串路径重新打开；为崩溃后截断、篡改、junction/symlink、ACL 变更以及目录替换加入了测试（`T25`–`T30`）。 |
| 5 | 威胁模型 C12 说"快照和日志受 HMAC/digest 保护，或至少是 digest" | **C12 已改写**为上述确定性契约，并且 C2/C3 已与**纯允许列表** ACL 协调（无 `DENY Everyone`/`DENY Users`）；同用户 Medium 攻击者**无法写入**状态目录（只有 High helper 能）；篡改/损坏始终**安全关闭（fail closed）**。 |

### 0.6 第七轮评审修复 — 安全描述符契约（rev.7 — 保留）

| # | 发现（round 7） | 决议（本修订） |
|---|---|---|
| 1 | COM `LaunchPermission`/`AccessPermission` 使用了通用的 `GX`，依赖一个手工解释的 `GX → COM rights` 映射（并允许额外的 `DENY ANONYMOUS LOGON`/`NETWORK`） | **显式 COM 权限掩码**（§5.1）：`Launch` `D:P(A;;0xB;;;SY)(A;;0xB;;;BA)(A;;0xB;;;<ownerSid>)`（`0xB` = `EXECUTE 0x1 | EXECUTE_LOCAL 0x2 | ACTIVATE_LOCAL 0x8`）；`Access` `D:P(A;;0x3;;;SY)(A;;0x3;;;<ownerSid>)`（`0x3` = `EXECUTE | EXECUTE_LOCAL`）。每个 ACL 使用**一个统一的 new-style 掩码**，每个 ACE **包含 `0x1`**，并且**没有 `DENY` ACE**（完整的允许列表通过缺席来拒绝）。 |
| 2 | 状态目录 ACL 被逐 ACE 描述为 `GR → GW` + 遍历箭头，以及一个分号数量错误的 SACL | **一个可解析的完整 SDDL**（§8.0）：`O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)` + `S:(ML;OICI;NW;;;HI)`；**无 owner-SID 文件 ACE**（Medium 无原始读取；UI 仅经 COM 清洗），无箭头，`SY`/`BA` 的精确掩码 `GA`，`HI` = `S-1-16-12288`，`NW` = `NO_WRITE_UP`，`OICI` 继承。 |
| 3 | 无测试证明描述符构建/验证链 | **描述符构建测试**（§13）：`ConvertStringSecurityDescriptorToSecurityDescriptor` 成功并返回带 `SE_SELF_RELATIVE` 的有效描述符；仅 COM `LaunchPermission`/`AccessPermission` 描述符作为注册表 `REG_BINARY` 字节一致地往返；状态目录描述符用 `SECURITY_ATTRIBUTES`/`SetNamedSecurityInfo` 应用并用 `GetNamedSecurityInfo`/`GetSecurityInfo` 读回；`AccessCheck` 验证 Launch 和 Access（owner=allow，second user=deny，SYSTEM=allow）；每个 COM ACE 掩码**严格**为 `0xB`/`0x3` 且**包含 `0x1`**；目录**High** 强制标签存在且带 `NO_WRITE_UP`；**Medium** 所有者写入/删除/更改 ACL**失败**，而**带 `BA` 启用（非 deny-only）的 High helper 令牌**成功。 |
| 4 | 安装文档组件表把状态拆为"应用数据（Medium/High）"与 `%ProgramData%` 存储 | **已统一**（安装文档 §1）：`BaselineSnapshot`/`WrittenState`/`MutationJournal` + 所有权/版本清单都位于 `%ProgramData%\<brand-independent-id>\tun-state\<ownerSid>\`，helper 所有 / SYSTEM 所有者 / **High 完整性** / **Medium 不可写**；已删除过时的"应用数据（Medium/High）"描述。 |

### 0.7 第八轮评审修复 — 描述符 API 与令牌契约（rev.8 — 本修订）

| # | 发现（round 8） | 决议（本修订） |
|---|---|---|
| 1 | 测试链把 `ConvertStringSecurityDescriptorToSecurityDescriptor` 的已经自相对的输出直接传给 `MakeSelfRelativeSD`，而后者要求绝对输入 | **已修复**（§5.1、§13、安装文档）：验证返回描述符上的 `SE_SELF_RELATIVE` 并直接持久化它。可选的绝对/自相对转换测试必须先调用 `MakeAbsoluteSD` 再比较语义字段，而不是要求相同的重新编码。 |
| 2 | `REG_BINARY` 往返错误地包含了文件系统的"状态键" | **已分离**：字节一致的注册表往返仅适用于 COM `LaunchPermission`/`AccessPermission`；状态目录描述符用文件系统安全 API 应用/读取，并在语义上比较。 |
| 3 | T37 尽管有显式 `SY` `0x3` Access ACE，仍拒绝 SYSTEM 的普通访问 | **已对齐**：Launch 和 Access 两个 `AccessCheck` 矩阵都要求 owner=allow、second-user=deny、SYSTEM=allow。 |
| 4 | "受限令牌"未说明状态存储 `BA` ACE 所需的组属性 | **已改为 fail-closed**（§5.3、§13）：High helper 令牌必须保留 `BA` 启用且非 deny-only；启动和 T40 在任何网络变更前验证它。 |


---

## 1. 架构分层与每平面单一所有者

### 1.1 所有权拆分（项 3 — 每平面一个所有者）

每个平面恰有一个所有者：

| 平面 | 所有者 | 职责 |
|---|---|---|
| **TUN 数据平面**（适配器数据包会话） | **mihomo**（受监督内核，`tun.stack: system`） | 打开/复用适配器，读/写数据包。它**不得**修改路由或 DNS。 |
| **OS 网络配置平面**（驱动安装/加载 + 路由/DNS/接口变更 + 基线 + 恢复） | **helper**（提升的代理） | 调用 `WintunCreateAdapter`（按需安装/加载驱动），应用类型化的 `DesiredNetworkState`，记录/恢复基线。唯一的路由/DNS/接口修改者。 |
| **决策平面**（设置哪些路由/DNS/接口） | **main 进程** | 从验证过的 mihomo 配置推导出精确的类型化 `DesiredNetworkState`（§9）；helper 逐字执行它。 |

**方案 A（已选）。** helper 是**唯一**的 OS 网络配置所有者。因此：

- mihomo 的合成运行时配置有 `auto-route:false`、`auto-detect-interface:false`、
  和 `dns-hijack:false` — mihomo 从不添加/移除路由或劫持 DNS。
- main 进程生成 `DesiredNetworkState`（一个纯粹的、类型化的函数 — §9），helper
  精确地应用它；helper 自身**不**读取 mihomo 的配置，也从不被交给原始命令文本。
- 因为方案 A 是排他的，mihomo**不能**被赋予 `auto-route`/`dns-hijack`。
  选择方案 B（mihomo 拥有路由/DNS）被明确拒绝：那会要求 helper
  放弃对路由/DNS 的逐项所有权/恢复，并采用不同的可观察/恢复契约，
  还会让 mihomo（Medium IL）负责需要提升的 OS 变更。

因此，helper**从不持有 Wintun 数据包会话，也从不触碰数据包缓冲区**。
恰好有一个 TUN 数据平面所有者（mihomo）和一个 OS 网络配置所有者（helper）；
它们通过认证的通道（§5）用类型化、验证过的命令协调。

### 1.2 分层图

```
renderer ── typed window.desktop.tun.*  (intent + status only; §6)
   │ validated Electron IPC (ipc.ts tun:* intent channels)
   ▼
main ── TunService (service.ts)         state machine + serialized ops + probe + backup
   │      getStatus / init / enable / disable / onStatus
   ▼
main ── policy.ts                       pure helpers: derive DesiredNetworkState,
   │                                    ownership/merge/format (no I/O)
   ▼
main ── adapters/WindowsTunAdapter      privileged boundary: helper client,
   │                                    integrity verify, baseline snapshot/recovery
   ▼
main ── PrivilegedHelperClient          elevation-COM IPC + envelope (§5)
   ▼
elevated ── helper.exe (High IL)        broker: WintunCreateAdapter (driver on demand),
   │                                    apply DesiredNetworkState, snapshot/recover, verify;
   │                                    NO packet session
   ▼
wintun.dll (official, per-arch) ──► signed Wintun kernel driver (loaded inside the
                                    DLL during WintunCreateAdapter, not by a
                                    standalone "load driver" step)
   ▼
mihomo ── opens/reuses the adapter     the ONLY data-plane owner (G1 gate)
```

非 Windows 构建使用返回 `{ supported:false, phase:'unsupported' }` 的
`DisabledTunAdapter`，零变更（一个伪造适配器支撑开发/测试路径）。

### 1.3 适配器交接：未经验证的假设（G1），而非已确立的契约

数据平面所有者是 mihomo。OS 网络配置所有者是 helper，而
helper 是唯一能安装/加载 Wintun 驱动的组件（它需要提升）。
因此架构必须回答：**mihomo 能否打开并复用 helper 通过 `WintunCreateAdapter` 创建的适配器？**
这就是 **G1**。

- G1 **尚未确立**。它必须通过**真实的 mihomo Windows 集成测试**（门控的 `windows-latest` 作业）证明：
  mihomo 能 `WintunOpenAdapter(Name)`（按稳定的产品名打开现有适配器），并对
  helper 创建的适配器运行其数据包会话，且不跨边界传递数据包句柄。
- 在 G1 通过之前，设计**不声称**交接可用；它是一个假设，
  带有已记录的步骤、一个阻塞门槛、以及一条重新打开路径：
  - 如果 G1 **通过**：mihomo 打开 helper 创建的适配器；helper 保持
    唯一的 OS 网络配置角色；数据平面保持在 mihomo。这是预期的路径。
  - 如果 G1 **失败**（mihomo 无法复用 helper 创建的适配器 — 例如它总是
    创建自己的）：设计**停止并返回所有者**以作出修改后的
    所有权决策，因为 round-2 约束是**一个** OS
    网络配置所有者和**一个**数据平面所有者。设计不得静默
    回退到双所有权。
- 设计**现在**固定下来的步骤（独立于 G1 结果）：
  1. helper 在提升状态下调用 `WintunCreateAdapter(Name, TunnelType, RequestedGUID)`
     （官方 ABI，§3.0）。它返回 `WINTUN_ADAPTER_HANDLE`；这是
     **唯一**按需**安装/加载已签名驱动**并创建适配器的调用，
     由产品特定的**名称**（如 `"Murge TUN"`）、**隧道类型**、
     以及产品特定的稳定 **`RequestedGUID`** 来寻址。
  2. helper 通过 `WintunGetAdapterLUID(Adapter, &luid)`（一个关于适配器句柄的 `_Out_`
     参数）导出 **LUID**，从而获得名称/GUID→LUID 映射；它发布
     `{ name, requestedGuid, luid }`。helper **从不打开数据包会话**
     （`WintunStartSession`），只保留适配器句柄（而非会话），因此它从不触碰数据包缓冲区。
  3. helper 在网络配置阶段**之前**（§10.1）**固定 + 验证** LUID。
  4. 网络配置阶段应用路由/DNS/接口（§10.1）。路由/DNS 总是在
     适配器存在之后写入（其 LUID/索引已知）。
  5. mihomo 打开/复用适配器并成为唯一的数据包 I/O 所有者。**这就是 G1。**

> **对早先草稿的更正。** Wintun API **确实在 `WintunCreateAdapter` 上有用户提供的
> `RequestedGUID` 参数**。因此"稳定 GUID"是通过传入一个**产品特定、稳定的 `RequestedGUID`**实现的，
> 这样适配器可通过确定的 GUID 寻址以用于恢复（§3.2、§3.3）；**LUID** 从适配器句柄导出
> （`WintunGetAdapterLUID`），用作路由/DNS/接口的键。如果请求的 GUID 已被使用，
> `WintunCreateAdapter` **会失败**（→ `conflict`，零变更）。早先声称"Wintun 没有用户提供的 GUID
> 参数"**已撤回**。唯一性不变量仍然成立：helper 列举 Wintun 适配器，
> 通过 `Name`+`RequestedGUID` 断言恰好一个 Murge 适配器，如果外来适配器已持有该身份，
> 则失败关闭。

---

## 2. 共享契约（`src/shared/tun.ts`）

### 2.1 规范 `TunPhase`

```ts
export type TunPhase =
  | 'configured'      // supported & verified (helper/driver present), NOT active
  | 'starting'        // enabling: verify → elevate → snapshot → create adapter → apply
  | 'active'          // TUN up and owned by the app (adapter session open)
  | 'failed'          // non-recoverable failure (integrity, adapter create, capture)
  | 'restoring'       // tearing down to baseline (reverse journal order)
  | 'restore-failed'  // could not restore (not a conflict)
  | 'conflict'        // an externally-modified owned item; per-item (never all-or-nothing)
  | 'unsupported'     // platform/build cannot enable TUN
```

没有单独的 `disabled`："关闭但受支持"是 `configured`；"无法启用"是 `unsupported`。

### 2.2 `TunStatus`

```ts
export interface TunStatus {
  supported: boolean
  phase: TunPhase
  deviceName: string | null      // Wintun adapter name while active, else null
  luid: string | null            // canonical hex NET_LUID string while active
  port: number | null            // mixed-port the TUN stack proxies to, while active
  stack: string | null           // mihomo tun.stack ("system") while active
  owned: boolean                 // app can prove it wrote the current routes/DNS
  errorMessage: string | null
  conflictDetail: string | null  // per-item detail (LUID/index, family, field)
  updatedAt: string | null
}
export const TUN_LOOPBACK_HOST = '127.0.0.1'
```

### 2.3 IPC 通道 + 网关（`src/shared/ipc.ts`、`src/shared/gateways.ts`）

```ts
// ipc.ts
tunGetStatus:   'tun:get-status',
tunEnable:      'tun:request-enable',   // INTENT, parameterless (§6)
tunDisable:     'tun:request-disable',  // INTENT, parameterless (§6)
tunStatusEvent: 'tun:status-event',

// gateways.ts
export interface TunGateway {
  getStatus(): Promise<TunStatus>
  requestEnable(): Promise<TunStatus>    // intent only; main performs the real op
  requestDisable(): Promise<TunStatus>   // intent only
  onStatus(l: (s: TunStatus) => void): () => void
}
```

---

## 3. Wintun 发行与按需适配器创建（项 1、2）

### 3.0 固定 ABI — 从所选版本的官方 wintun.h 逐字固定

ABI **固定到 Wintun **0.14.1****（选定的稳定版本；确切版本
及其清单哈希记录在发行清单和第三方声明中 —
**实现时需对照固定版本的 `wintun.h` 重新确认**）。
下面的契约从**官方 `wintun.h`** 复制，因此我们的导出符号
和调用约定假设不会偏离 SDK。

**记录来源**

| 字段 | 值 |
|---|---|
| 头文件 | 从官方 Wintun 0.14.1 发行归档中提取的 `wintun.h`，验证归档 SHA-256 `07c256...ef51` 和头文件 SHA-256 `510a59...460f` 后；审核直接针对该头文件编译，绝不把 ABI 形状复制到 TypeScript |
| 版本 | **0.14.1** |
| 架构 | 每架构 DLL：`amd64`、`arm64`；**每个架构一个 DLL，该架构的 ABI 固定**（绝不跨架构捆绑） |
| 调用约定 | x86-64 上为 `WINAPI`（`__stdcall`）（x64 忽略但为正确性保持正确）；按名称导出（DLL 导出表） |
| 句柄类型 | `WINTUN_ADAPTER_HANDLE`、`WINTUN_SESSION_HANDLE`（不透明指针；不要在其他地方重新解释） |
| `NET_LUID` | 64 位 `NET_LUID` 联合；在 JSON 中序列化为**规范十六进制字符串**（§8.1） |
| 记录来源的 ABI | **来自发行 `0.14.1` 的官方 `wintun.h`**，仅在固定的归档/头文件摘要检查通过后接受；不要在 TypeScript 中手工声明任何原生签名 |
| 构建时 ABI 检查 | 构建步骤针对固定的 `wintun.dll` 运行 `dumpbin /exports`（MSVC）或 `llvm-readobj --coff-exports`，并断言**导出的符号名集合与上表完全匹配**；运行时检查还通过 `GetProcAddress` 解析每个名称，并在首次使用前断言非空。不匹配则构建失败（无运行时回退）。 |

**RequestedGUID 说明。** 确实**有**用户提供的 `RequestedGUID` 参数：传入一个
产品特定、稳定的 GUID 使适配器可通过该 GUID 寻址以用于恢复。
如果 GUID 已被使用，`WintunCreateAdapter` 会失败（→ `conflict`，无变更）。
恢复的稳定身份是 **`RequestedGUID` + `Name`**，而线上身份是关联的 **`NET_LUID`**。

**导出符号（从 Wintun 0.14.1 的官方 `wintun.h` 固定 — 唯一 ABI 来源）**

0.14.1 `wintun.h` 中的声明被写成函数指针 `typedef`（`WINTUN_*_FUNC`）；
每个都有 `WINAPI`（`__stdcall`）调用约定。这些函数是：

```
WintunCreateAdapter          WINTUN_ADAPTER_HANDLE WINAPI (Name, TunnelType, RequestedGUID)
WintunOpenAdapter            WINTUN_ADAPTER_HANDLE WINAPI (Name)
WintunCloseAdapter           VOID WINAPI (Adapter)
WintunDeleteDriver           BOOL WINAPI (VOID)             // exported, production policy FORBIDS it
WintunGetAdapterLUID         VOID WINAPI (Adapter, NET_LUID *Luid)
WintunGetRunningDriverVersion DWORD WINAPI (VOID)
WintunSetLogger              VOID WINAPI (WINTUN_LOGGER_CALLBACK)
WintunStartSession           WINTUN_SESSION_HANDLE WINAPI (Adapter, DWORD Capacity)
WintunEndSession             VOID WINAPI (Session)
WintunGetReadWaitEvent       HANDLE WINAPI (Session)
WintunReceivePacket          BYTE *WINAPI (Session, DWORD *PacketSize)
WintunReleaseReceivePacket   VOID WINAPI (Session, const BYTE *Packet)
WintunAllocateSendPacket     BYTE *WINAPI (Session, DWORD PacketSize)
WintunSendPacket             VOID WINAPI (Session, const BYTE *Packet)
```

0.14.1 中**没有 `WintunDeleteAdapter`，也没有 `WintunFreeSendPacket`**；两者都
绝不出现在我们的代码、ABI 记录或调用中。`WintunOpenAdapter` **被**导出，
是第二个进程（mihomo）按名称打开现有适配器的方式。
`WintunDeleteDriver` **被**导出，但生产策略**禁止调用它** — 
Wintun 驱动是其他 Wintun 消费者（如 WireGuard 应用）依赖的**共享系统资源**；
我们绝不移除预存在适配器或其他用户可能正在使用的驱动（D5）。

**固定签名（逐字取自官方 0.14.1 `wintun.h`）**

```c
typedef struct _WINTUN_ADAPTER *WINTUN_ADAPTER_HANDLE;
typedef struct _TUN_SESSION *WINTUN_SESSION_HANDLE;

// Creates a new Wintun adapter. RequestedGUID NULL => system-assigned GUID.
// Returns the adapter handle, else NULL (call GetLastError). Must be released with WintunCloseAdapter.
WINTUN_ADAPTER_HANDLE(WINAPI WINTUN_CREATE_ADAPTER_FUNC)(_In_z_ LPCWSTR Name, _In_z_ LPCWSTR TunnelType, _In_opt_ const GUID *RequestedGUID);

// Opens an existing Wintun adapter by name. Returns a handle, else NULL. Must be released with WintunCloseAdapter.
WINTUN_ADAPTER_HANDLE(WINAPI WINTUN_OPEN_ADAPTER_FUNC)(_In_z_ LPCWSTR Name);

// Releases adapter resources AND, if the adapter was created with WintunCreateAdapter, REMOVES the adapter.
VOID(WINAPI WINTUN_CLOSE_ADAPTER_FUNC)(_In_opt_ WINTUN_ADAPTER_HANDLE Adapter);

// Deletes the Wintun driver if there are no more adapters in use. Exported; FORBIDDEN by production policy.
BOOL(WINAPI WINTUN_DELETE_DRIVER_FUNC)(VOID);

VOID(WINAPI WINTUN_GET_ADAPTER_LUID_FUNC)(_In_ WINTUN_ADAPTER_HANDLE Adapter, _Out_ NET_LUID *Luid);

DWORD(WINAPI WINTUN_GET_RUNNING_DRIVER_VERSION_FUNC)(VOID);
```

> 0.14.1 头文件将这些声明为**函数指针 typedef**，命名为 `WINTUN_*_FUNC`
> （`WINTUN_ADAPTER_HANDLE(WINAPI ...)` 形式）。运行时会解析的**导出 DLL 符号**是上面导出表中的 `Wintun*` 名称
> （`WintunCreateAdapter`、`WintunOpenAdapter`、…）。构建时 ABI 检查（§3.0 / §13）
> 在 `wintun.dll` 中解析每个 `Wintun*` 符号，并断言其地址与相应的 `WINTUN_*_FUNC` 签名匹配。

**Creator 句柄生命周期（真实的 0.14.1 语义）**

- `WintunCreateAdapter` 返回**creator 句柄**。该句柄是适配器的**生命周期
  锚点**：根据 0.14.1 头文件，`WintunCloseAdapter` "释放资源，
  并且，**如果适配器是用 `WintunCreateAdapter` 创建的，则移除适配器**"。
  对于适配器移除，**没有** `WintunDeleteAdapter`，**没有** `ERROR_REBOOT_REQUIRED`/`delete-pending` —
  移除就是**关闭 creator 句柄**，唯一重启可见的产物是 Wintun **驱动**（我们从不删除）。
- `WintunOpenAdapter(Name)` — **第二个**进程（mihomo）按名称打开**另一个句柄**，
  并调用 `WintunStartSession(Adapter, Capacity)` 获得自己的数据包会话。
  creator 的**句柄**和打开的**句柄**是不同的；两者都用 `WintunCloseAdapter` 释放。
- `WintunGetAdapterLUID(Adapter, &Luid)` 从适配器句柄导出 `NET_LUID`（路由/DNS 键）。
- **数据平面由 mihomo 拥有**（§1.1）。helper 从不打开会话；它只在 TUN 启用的时间内
  持有**creator 句柄**，并在禁用/回滚时释放它（关闭 = 移除适配器）。
- **`WintunDeleteDriver` 从不被调用。** 我们不发布 `.sys`，绝不移除其他适配器/用户可能依赖的驱动（D5）。

### 3.1 官方发行模型

- **发布官方每架构 `wintun.dll`，绝不发布裸驱动文件。** Wintun
  发行版发布在 `https://www.wintun.net/`，为每个架构提供一个 ZIP 包含 `wintun.dll`
  （`wintun/bin/amd64/...`、`wintun/bin/arm64/...`）。**内核驱动由 DLL 按需安装/加载**，
  应用**不得**直接发布类似驱动名称的文件。所有"安装 .sys"、"升级 .sys"、删除 .sys"步骤均已移除。
- **每架构捆绑。** 将 `wintun-amd64.dll` / `wintun-arm64.dll` 作为
  `extraResources` 捆绑在 `resources/bin/<arch>` 附近（用于固定 mihomo 归档的同一每架构模型）。
  绝不跨捆绑另一架构。
- **来源。** 来自官方 Wintun 发行版（wintun.net）；在第三方声明中记录确切的发行版本 + URL。
- **许可证/声明合规。** 从官方发行捕获 Wintun 许可证文本，记录其 SPDX 标识符，
  并添加到 `resources/THIRD_PARTY_NOTICES.md`。因为应用是 `GPL-3.0-only`，请在打包**之前**确认兼容性和再分发义务（一个合规门槛）。
- **SHA-256 / 完整性。** 在固定的发行清单中设置确切的每架构 `wintun.dll` SHA-256
  （与 `mihomo-artifact.ts` 相同的机制）。运行时在加载前重新验证摘要；不匹配 ⇒ 失败关闭，不加载。
- **签名验证。** `helper.exe` 用项目证书进行 Authenticode 签名并验证其发布者（C1）。
  Wintun **内核驱动**由 DLL 安装（`WintunCreateAdapter`），并且**必须是 Windows 会加载的已签名驱动**（OS 只加载已签名的内核驱动）。我们**不**自签名、添加自签名证书或伪造驱动的签名。
  `wintun.dll` 通过其固定摘要验证；在 Windows 能报告时，断言已加载驱动的发布者与 Wintun 发布者匹配。
- **安全加载。** `LoadLibraryEx(wintun.dll)` **仅**映射 DLL — 它**不**安装或加载驱动。
  在（不可写的）安装目录中使用**绝对路径**，并带安全搜索标志（`LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR` /
  `SetDefaultDllDirectories`），绝不用短名称，以免搜索路径劫持替换 DLL。

### 3.2 适配器创建（helper 的提升动作）— 正确的 ABI，无 `load_driver` 操作

`load_driver` 操作以及每个"加载驱动一次"步骤**均已删除**。
Wintun 驱动的安装是 `WintunCreateAdapter` 的**副作用**，它需要提升并由 helper 调用。
因此没有以"加载驱动"为目的的操作；只有 `create_adapter`。

- **`create_adapter`**（helper，提升）。`LoadLibraryEx` 官方 DLL（绝对路径、安全标志）→ 解析固定的导出（§3.0）→ 调用：

  ```c
  WINTUN_ADAPTER_HANDLE h = WintunCreateAdapter(
      L"Murge TUN",          // product-specific, stable adapter name
      L"Murge TUN",          // stable opaque tunnel-type string
      &kProductRequestedGuid);// product-specific, stable RequestedGUID (never NULL)
  ```

  - `Name` 和 `TunnelType` 是**稳定的、产品特定的**值。
  - `RequestedGUID` 是**产品特定的稳定 GUID**，因此适配器可通过确定的 GUID 寻址以便恢复（§3.3）。如果 GUID 已被使用，`WintunCreateAdapter` **失败** → `conflict`，**零变更**。
  - 返回的 **`WINTUN_ADAPTER_HANDLE` 是 creator 句柄**，并且**是适配器唯一生命周期锚点**（§3.3）。**不**要把它重新解释为 LUID 或会话。
- **导出 LUID（路由/DNS 键）。** `WintunGetAdapterLUID(h, &luid)`（一个 `_Out_` 参数，在适配器句柄上）。发布 `{ name, requestedGuid, luid }`，`luid` 作为**规范十六进制字符串**（§8.1）— 这是路由/DNS/接口的键。
- **在此不要启动会话。** helper**不得**打开数据包会话（`WintunStartSession`）。数据平面由 mihomo 拥有（§1.1），它用 `WintunOpenAdapter(Name)` 打开自己的句柄并启动会话。helper**保持 creator 句柄打开，但绝不保持会话**。
- **唯一性/保留。** 列举 Wintun 适配器；断言恰好一个 Murge 适配器，且没有外来适配器已持有保留的 `Name`/`RequestedGUID`。否则 ⇒ `conflict`，无变更。
- **恢复身份。** 在重启/恢复时，列举 Wintun 适配器并按 **`Name` + `RequestedGUID`** 调停（GUID 是稳定地址；LUID 是每个适配器导出的）。来自未应用 `create_adapter` 的遗留适配器会被识别，并被采纳（如果它是本产品的）或在不属于可证所有的情况下无变更地调停（§3.3、§8.4）。
- **`probe_integrity`** 验证 helper 摘要/发布者 + `wintun.dll` 摘要；它**不**加载驱动，**不**需要提升。

### 3.3 句柄生命周期、交接与 G1 所有权探针

**没有 `WintunDeleteAdapter`。** 由 `WintunCreateAdapter` 创建的适配器**唯一**的移除方式是调用 **`WintunCloseAdapter(creatorHandle)`** — 根据 0.14.1 头文件，关闭适配器句柄"释放资源，并且，如果适配器是用 `WintunCreateAdapter` 创建的，**则移除适配器**"。没有 **`ERROR_REBOOT_REQUIRED`** 适配器删除返回，**没有 `delete-pending`** 日志状态（唯一重启可见的产物是 Wintun **驱动**，我们从不删除，以及 helper 总是恢复的路由/DNS 变更）。

**creator 句柄是适配器的生命周期锚点 — 这是核心设计事实。**

helper 创建适配器，因此它拥有**creator 句柄**。如果 helper 在 TUN 仍启用时关闭该句柄，适配器会被移除。这与已废弃的"每次启用/禁用命令一个全新 helper"想法**直接冲突**，后者会在启用事务结束时立即退出：**如果 helper 退出，它会关闭其 creator 句柄，适配器便消失。**

**安全基线是固定的，而非取决于探针**（§0.4/§5.5）：helper 每次启用时被激活，在**整个启用窗口内持有 creator 句柄**，且仅在 `disable` 的最后步骤或紧急恢复时关闭它。所以 helper**不得**在启用事务完成时退出。**G1 lifecycle probe** 的工作是（1）确认 mihomo 复用同一适配器（实际交接），（2）观察适配器是否会在 creator 关闭后存活（Observed A/B）**仅用于可能的未来优化** — 它并不门控基线。G1 仍是任何真实 TUN 工作之前的**硬性门槛**（§12）。它只能在受保护的 `phase9-tun-lab` 环境背后、门控的 `murge-tun-lab` 自托管 Windows 运行器上运行，带已验证的快照、带外恢复和另行所有权授权；它绝不在本开发机上运行（§0.0 / DEVELOPMENT_SAFETY）。

**G1 lifecycle probe（定义所有权模型）。** 探针演练 a-d 并记录适配器是否在步骤 (c) 后存活：

1. **(a)** helper `WintunCreateAdapter` → 持有**creator 句柄**；`${name}` 存在。
2. **(b)** mihomo `WintunOpenAdapter(name)` → **第二个句柄** + `WintunStartSession` ⇒ 一个活动数据平面；`${name}` + LUID 稳定。
3. **(c)** helper **`WintunCloseAdapter(creatorHandle)`** → helper 退出。
4. **(d)** 观察：mihomo 的会话和适配器 `${name}` 是否**仍然存在**？

**两种观察 — 但它们不选择架构。** 探针在 (d) 观察到其中之一。两者都记录为证据；都不决定下面的安全模型，它是固定的：

- **Observed A — 适配器在 creator 句柄关闭时被移除。** 这就是 0.14.1 头文件措辞所暗示的，也是保守预期：移除是 creator 句柄的工作，因此关闭它的 helper 会丢弃适配器。**因为产品的安全基线从不依赖适配器比 helper 存活更久**，Observed A 在模型中不改变任何东西 — 它仅确认 helper 必须在整个启用窗口内停留。
- **Observed B — 适配器在 mihomo 仍持有自己的打开句柄时经受住 creator 关闭。** 当某个句柄保持着它时，适配器存活；(d) 时 mihomo 持有一个。在 Observed B 下，可以设想 helper 可更早退出 — 但这**仅是未来优化**，绝不是当前基线。

**安全基线（固定 — 独立于探针设置）。** helper 每次启用时被激活，绑定单一经过验证的客户端，创建适配器，并在**整个启用 TUN 窗口内持有 creator 句柄**；它只在 `disable` 的最后步骤或紧急恢复时关闭该句柄（移除适配器）。因此 helper 的**进程生命周期 = TUN 启用生命周期**（§5.5），移除它始终是 helper 自己的显式、拥有所有权的行为。**G1 probe 所需的结论是 mihomo 复用同一适配器**（打开同一 `${name}` 并运行会话）；creator 关闭的**观察（A vs B）**仅记录我们能否日后优化（例如让 helper 在启用完成时退出），**绝不**改变当前安全模型是否成立。

- **启用 / 有效生命周期。** helper 每次启用时被激活；mihomo 打开第二个句柄 + 会话。helper**在**整个启用窗口内保持 creator 句柄打开**，并且**不在**启用事务完成或空闲时退出 — 它进入 **resident-active** 阶段（§3.4/§5.5）并持续到 `disable` 或一个紧急/退出条件。因此启用顺序是**固定**的，且不等待探针。
- **禁用 / 拆除。** main 通过同一 COM 代理调用**同一**常驻 helper；mihomo 在其打开句柄上调用 `WintunEndSession` 和 `WintunCloseAdapter`；helper 逐项恢复路由/DNS；然后 helper `WintunCloseAdapter(creatorHandle)` — 这**移除适配器**；它写入 `RECONCILED`、清零密钥、退出。无 `WintunDeleteAdapter`，无 `WintunDeleteDriver`。
- **所有权验证是强制性的。** 在 helper 关闭 creator 句柄之前，它重新验证适配器是**本产品/本实例的**（通过 `Name` + `RequestedGUID`，以及导出的 LUID）；如果它无法证明所有权，则**不**触碰适配器，而是记录 `RECONCILED`，无变更（§8.4）。预存在/共享的适配器从不被移除（D5）。

### 3.4 Helper 生命周期：resident-active、异常退出与 helper 崩溃（项 2、3）

两类失败，每类都有显式的**有界**恢复路径。每条路径都通过关闭 creator 句柄结束，因此我们**绝不留下一个没有数据平面的 TUN 适配器**；只有成功的恢复才以无待处理日志项结束。

**客户端 / 内核异常退出（TUN 启用时应用或 mihomo 死亡）。** helper**复制并监视**绑定应用进程句柄**和** mihomo 进程句柄（后者在 helper 启动/启动会话时获得）。在 resident-active 期间，它等待这两个句柄（加上命令通道）。如果**任一**异常退出：

1. helper 进入**有界紧急恢复**并首先在日志中记录失败；
2. 它**逐项恢复路由/DNS**（owned-only，逆日志顺序，§8.3/§8.5）；
3. **然后才**它**关闭 creator 句柄**（`WintunCloseAdapter(creatorHandle)`）— 适配器被移除（0.14.1 语义），因为没有数据平面的适配器不得保留；
4. 它**持久化结果**（`RECONCILED`，或 `RESTORE_FAILED` + 保留日志）并退出。

**如果恢复失败**，helper**仍关闭 creator 句柄**（所以不会留下没有数据平面的 TUN 适配器）并记录 `RESTORE_FAILED`，**保留日志**以便下次 `init()`/`--recover` 可以完成路由/DNS 恢复。紧急恢复由显式的**全局最大恢复超时**封顶；超时后它强制关闭 creator 句柄并以 `RESTORE_FAILED` 退出。

**helper 自身的崩溃。** 如果 helper 在 resident-active 期间死亡，**Windows 自动关闭其句柄**，根据 0.14.1 头文件，适配器被**移除**（creator 句柄消失）。因此下次 `init()`/`--recover` 启动一个**新的恢复 helper**：

- 新 helper**没有旧的 creator 句柄**，所以它**不得记录它调用了 `WintunCloseAdapter`** — 它没有；适配器消失是因为 OS 关闭了句柄；
- 它**验证适配器已消失**（按 `Name`/`RequestedGUID`/LUID 列举 — 不存在）并**逐项恢复任何残余路由/DNS**，对照快照/日志（§8.4），然后写入 `RECONCILED`；
- 如果适配器**异常地仍然存在**但新 helper**无法证明/拥有 creator 句柄**，它**标记冲突**，**保留证据**（快照 + 日志 + 适配器列举结果），并且**不触碰或删除适配器** — 它绝不移除预存在/外来适配器（D5）。恢复以冲突结束，而非破坏性删除。

因为启用和禁用共享**同一 helper 实例**（§5.5），它在禁用时关闭的 creator 句柄就是它拥有的那个；恢复只处理上述情况。**active idle** 与**握手/命令超时**的区别是显式的：超时仅适用于短暂的绑定前握手窗口和单个命令请求/响应（§4.4）— **绝不适用于无 IPC 流量的 resident-active helper**。

---

## 4. Helper IPC、认证与密钥生命周期（项 4、5）

### 4.1 为何拒绝早先的命名管道/继承方案

- `ShellExecuteEx(verb=runas)`（UAC 路径）**通过 shell/提升代理**创建提升进程；它**不**从调用方传播 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`。**因此句柄无法跨 `runas` 继承。** 任何让应用创建两个管道端并通过继承把一端交给 helper 的设计都**无法**通过 UAC 执行。
- 一个端点仅仅是随机名称 + SDDL + 用户可读秘密的通道，无法阻止**同用户** Medium-IL 进程冒充应用：端点名称、命令行上的任何 `launchSecret`、环境变量中或普通文件 / 用户注册表值中的任何秘密都可由同用户进程读取，且同用户参与者共享 DACL 授予的用户 SID。

因此设计转向**Windows 官方支持的安全引导：一个提升的进程外 COM 服务器**（helper），其中 OS（AppInfo 提升代理）认证并促成会合，因此无需自定义句柄跨提升传递，也不把同用户秘密放入用户可读介质（§5）。

### 4.2 命令信封（在 helper 中做 schema 校验）+ 规范 MAC

```ts
interface HelperCommand {
  v: 1
  op: HelperOp                 // allowlist below
  requestId: string            // monotonic uint64 as a decimal string (§8.1)
  mac: string                  // HMAC-SHA256 over the canonical encoding (§4.3)
  payload: HelperPayload       // op-specific, JSON-schema validated
}
type HelperOp =
  | 'probe_integrity'    // verify helper+wintun digest/publisher (no mutation, no elevation)
  | 'create_adapter'     // WintunCreateAdapter: installs/loads driver + creates adapter (WAL)
  | 'apply_network_state'// apply the typed DesiredNetworkState (routes/DNS/interface) (WAL)
  | 'close_creator_handle'// WintunCloseAdapter(creatorHandle): REMOVES a create-created adapter (§3.3) (WAL)
  | 'snapshot'           // capture/save the BaselineSnapshot BEFORE mutation
  | 'restore'            // per-item owned-only restore, reverse journal order (§8.4)
  | 'get_status'
  | 'health'
```

在 helper 中执行的规则：

- `op` 不在允许列表中 ⇒ 拒绝。`v` 必须是 `1`。`payload` 在任何副作用之前按操作 schema 验证。大小受限（如 4 KiB）。无任意路径、无原始命令字符串、无自由文本脚本。
- `apply_network_state` 携带**类型化的 `DesiredNetworkState`**（_§9_），绝不携带自由格式 CLI 文本。helper 不是 shell。

### 4.3 密钥生命周期与规范 MAC 编码（项 5）

**机密。** 存在两个机密：一次性的 `launchSecret`（仅引导）和 `sessionKey`（通道生命周期）。

- `launchSecret`（256 位）：**仅**用于在握手时派生 `sessionKey`。在握手完成后**立即**用 `RtlSecureZeroMemory` **清零** — 之后绝不再使用。
- `sessionKey`（用 HKDF-SHA256(launchSecret, 每会话盐 + 对端角色字符串) 派生，256 位）：唯一用于消息 MAC 的密钥。**为通道生命周期保留**，仅在**通道关闭 / 任务结束**时清零（绝不在更早时，因此它对活动操作的每条消息都可用）。
- **所有路径上清零。** `RtlSecureZeroMemory` 在 (a) 正常通道关闭、(b) 握手/命令超时、(c) 异常、(d) helper 进程退出时运行（在 `__try/__finally` 风格的守卫中做专门清理，外加进程退出处理器和 `TerminateGracefully` 路径）。两个密钥都绝不记录、绝不传给 renderer、绝不持久化。应用的客户端在握手后清零自己的 `launchSecret` 副本，在拆除时清零其 `sessionKey`。

**规范 MAC 编码。** MAC**不是**像 `v|op|requestId|payload` 这样的裸拼接（有歧义，因为字段可能包含分隔符且是变长的）。相反每个字段被**长度前缀**，且 payload 是规范的：

```
encode(field) = u32le(byteLength(field)) || fieldBytes
canonicalJSON(payload) = minimal/sorted-key, stable JSON of the op payload
mac = HMAC-SHA256(sessionKey,
        encode("v=1")        ||
        encode(op)           ||
        encode(requestId)    ||
        encode(canonicalJSON(payload)))
```

`requestId` 为 MAC 序列化为其 8 字节大端 uint64 值（规范数值），而其线上形式是十进制字符串。这消除所有歧义且是字节确定的，因此两侧计算相同的 MAC。

### 4.4 重放、顺序、超时

- `requestId` 在会话中是**单调**的（每会话 uint64 序列）。以 `requestId` 为键的有界重放缓存拒绝重复；陈旧/乱序 id ⇒ 关闭。（新会话的 id 永不冲突，因为序列随新的 `sessionKey` 重置，并由 `sessionKey` 的 HKDF 盐限定作用域。）
- helper 强制一个**引导握手超时**（如 5 秒，绑定前窗口），超时后退出、一个**每命令请求/响应超时**、以及一个**通道上的握手/空闲连接超时**。这些超时**仅**适用于短暂的握手窗口和单个命令 — 它们**不是**针对 resident-active helper 的空闲超时（§3.4、§5.5），后者必须在零 IPC 流量下保持运行。
- 因为传输是认证的 COM 通道（§5），OS 已提供逐消息完整性 + 隐私；信封 MAC + `requestId` 是**第二层**（应用层完整性 + 重放防御），这就是上面密钥生命周期仍然必需的原因。

---

## 5. 提升 + IPC 引导（项 4）— 可执行的 Win32 序列

helper 是**提升的、进程外的 COM 服务器**；应用是 COM **客户端**；**Windows 提升代理（AppInfo）**是会合点。**跨提升不继承句柄**（这是官方支持的替代方案），并且**不把同用户秘密放入用户可读介质**（秘密在认证的 COM 调用内部交换）。

### 5.1 参与方与注册（COM 提升标记）

helper 是**提升的、进程外的 COM 服务器**；应用是 COM **客户端**；**Windows 提升代理（AppInfo）**是会合点。客户端通过 **COM 提升标记**激活服务器 — 这是请求提升 COM 服务器的官方记录方式 — **不是**通过对 `requireAdministrator` 服务器使用普通 `CoCreateInstance`。

| 侧 | IL | 角色 | 构建 |
|---|---|---|---|
| `.exe` 主应用（`electron` main） | Medium | COM **客户端**；`PrivilegedHelperClient` 的唯一持有者 | Electron main |
| `helper.exe` | High（提升） | COM **服务器**；提升的代理 | 原生，`requireAdministrator`，无控制台，无网络监听 |

`helper.exe` 在**机器范围**（HKLM，因此每用户 `HKCU` 注册不能覆盖它）注册为一个进程外 COM 服务器，属于一个专用 **`AppID`**：

**`HKLM\Software\Classes\CLSID\{CLSID_PrivilegedHelper}`**

| 值 | 值 |
|---|---|
| (默认) | `Murge Privileged Helper (elevated)` |
| `LocalizedString` | `@C:\Program Files\Murge\resources\bin\helper.exe,-101` |
| `LocalServer32` (默认) | `C:\Program Files\Murge\resources\bin\helper.exe` — **绝对路径** |
| `LocalServer32\ServerExecutable` | `C:\Program Files\Murge\resources\bin\helper.exe` — 为标记提供的显式模块名 |
| `LocalServer32\AppID` | `{AppID_PrivilegedHelper}` |
| `Elevation\Enabled` | **REG_DWORD `1`**（标记允许提升） |
| `Elevation\IconReference` | `@C:\Program Files\Murge\resources\bin\helper.exe,0` — **可选**（自定义 UAC 图标） |

**`HKLM\Software\Classes\AppID\{AppID_PrivilegedHelper}`**

| 值 | 值 |
|---|---|
| (默认) | `Murge Privileged Helper` |
| `RunAs` | **`Interactive User`** — 要求如此，使服务器被激活为当前交互式用户的高完整性令牌（Activate-as-Activator / Interactive User 语义，按提升标记）。**不是**命名/已知账户。 |
| `LaunchPermission` | **纯允许列表 DACL**，带**显式 COM 权限掩码 `0xB`**（`EXECUTE|EXECUTE_LOCAL|ACTIVATE_LOCAL`），无 `Everyone`/`Users`/`Authenticated Users`，无掩盖所有者的 deny。仅向授权的用户主体、`SYSTEM` 和 `Administrators`（安装/修复）授予本地启动 + 本地激活。见下方精确 SDDL + ACE 表（+ 描述符构建测试）。 |
| `AccessPermission` | **纯允许列表 DACL**，带**显式 COM 权限掩码 `0x3`**（`EXECUTE|EXECUTE_LOCAL`）— 仅向授权的用户主体 + `SYSTEM` 授予本地访问（调用/连接）。`Administrators`**未被**授予普通调用访问（它仅在启动列表中用于安装/修复）。见下方精确 SDDL + ACE 表。 |

> **Round-6/7 — DACL 是纯允许列表，绝不是 deny-then-allow，并且完全不携带 `DENY`。** `DENY Everyone` + `DENY Users` + `ALLOW <ownerSID>` 模式**被拒绝**：
> 授权用户是 `Everyone` 和 `Users` 两者的成员，因此显式 `DENY` 条目会战胜 `ALLOW`，合法的所有者被锁在激活/调用 helper 之外。
> 相反 DACL 是仅正面 ACE 的**完整允许列表** — 缺席的 SID 获得**无有效访问**（在完整 DACL 上默认拒绝）。因为允许列表是完整的，**不添加 `DENY` ACE**（甚至不添加 `ANONYMOUS LOGON`/`NETWORK`）：添加 `DENY` 只会引入 ACE 顺序 / deny 覆盖风险，且在此无关紧要，因为没有 `ALLOW` ACE 的主体已获得无访问。
>
> **LaunchPermission SDDL** — `D:P`（受保护，无继承）；每个 ACE 使用**显式 COM 权限掩码 `0xB`**（单一、统一格式；**无**通用 `GX`）：
> ```
> D:P(A;;0xB;;;SY)(A;;0xB;;;BA)(A;;0xB;;;<ownerSid>)
> ```
> 其中每个 `A;;0xB;;;…` = **Allow**，带 `COM_RIGHTS_EXECUTE (0x1) | COM_RIGHTS_EXECUTE_LOCAL (0x2) | COM_RIGHTS_ACTIVATE_LOCAL (0x8)`。
>
> **AccessPermission SDDL** — `D:P` 受保护；每个 ACE 使用**显式 COM 权限掩码 `0x3`**（单一统一格式）：
> ```
> D:P(A;;0x3;;;SY)(A;;0x3;;;<ownerSid>)
> ```
> 其中每个 `A;;0x3;;;…` = **Allow**，带 `COM_RIGHTS_EXECUTE (0x1) | COM_RIGHTS_EXECUTE_LOCAL (0x2)`。
>
> **不混用新旧 ACE，也无额外 `DENY`。** 一个 ACL 中的每个 ACE 使用**相同的
> new-style 掩码**，每个都包含**`0x1`**（`COM_RIGHTS_EXECUTE`）— **没有**遗留的 `0x1` 专用 ACE 与 `0x3`/`0xB` ACE 混在一起。DACL 是**完整的纯允许列表**；缺席的 SID 获得**无有效访问**（默认拒绝），因此**不添加 `DENY` `ANONYMOUS LOGON`/`NETWORK` ACE**（那只会增加 ACE 顺序 / deny 覆盖风险，在完整允许列表上无必要）。`SY` = `S-1-5-18`，`BA` = `S-1-5-32-544`，`<ownerSid>` 是安装时解析的交互式用户 SID（`S-1-5-21-<dom>-<rid>`）。
>
> 这些注册表值是**二进制 `SECURITY_DESCRIPTOR`**（上面的 SDDL 字符串是 `ConvertStringSecurityDescriptorToSecurityDescriptor` 源码形式，`SDDL_REVISION_1`）。掩码是**实际的 COM 权限掩码**，因此**无需假设通用权限 → COM 权限转换**；该值被逐字写入。Launch 授予 launch+activate-local；Access 授予 call/connect local。因为**不授予 `COM_RIGHTS_*_REMOTE` 位且不授予 `GA`/`GW`**，网络/远程激活或访问被 DCOM 拒绝，这也支撑了 §5.2 中"本地 `ncalrpc` only"的要求。
>
> **逐 ACE 表**（每个 `A;;` = Allow；DACL 包含**无 `DENY`**）：

> | SDDL | ACE | 对象 SID | 允许/拒绝 | COM 权限掩码 | 有效 COM 权限 | 原因 |
> |---|---|---|---|---|---|---|
> | `Launch` `D:P(A;;0xB;;;SY)…` | `A` | `SYSTEM` `S-1-5-18` | **允许** | `0xB` | `EXECUTE (0x1) + EXECUTE_LOCAL (0x2) + ACTIVATE_LOCAL (0x8)` | SCM/RPCSS 必须能启动 + 激活进程外服务器；仅本地。 |
> | `Launch` `…(A;;0xB;;;BA)…` | `A` | `Administrators` `S-1-5-32-544` | **允许** | `0xB` | `EXECUTE + EXECUTE_LOCAL + ACTIVATE_LOCAL` | 安装/修复可以启动/激活（`BA`）；**不**授予普通调用访问（在 `AccessPermission` 中缺席）。 |
> | `Launch` `…(A;;0xB;;;<ownerSid>)…` | `A` | 所有者用户 SID `S-1-5-21-<dom>-<rid>`（安装时解析） | **允许** | `0xB` | `EXECUTE + EXECUTE_LOCAL + ACTIVATE_LOCAL` | **唯一**可能启动/激活 helper 的交互式用户。 |
> | `Access` `D:P(A;;0x3;;;SY)…` | `A` | `SYSTEM` `S-1-5-18` | **允许** | `0x3` | `EXECUTE (0x1) + EXECUTE_LOCAL (0x2)` | SCM 可以完成连接；仅本地。 |
> | `Access` `…(A;;0x3;;;<ownerSid>)…` | `A` | 所有者用户 SID `S-1-5-21-<dom>-<rid>` | **允许** | `0x3` | `EXECUTE + EXECUTE_LOCAL` | **唯一**可能调用 helper 的交互式用户。`Administrators`、`Everyone`、`Users`、`Authenticated Users` **缺席** ⇒ 无有效访问。 |
>
> **需要 `AccessCheck` 验证（见 §13 描述符构建测试）。** 从存储的二进制值（或上面的 SDDL）构建实际的 `SECURITY_DESCRIPTOR` 并断言：**所有者 SID 允许**、**第二个普通用户被拒绝**、**SYSTEM 允许**，对 `LaunchPermission` 和 `AccessPermission` 都如此；每个 COM ACE 掩码**严格**为 `0xB` 或 `0x3` 且**包含 `0x1`**。`ConvertStringSecurityDescriptorToSecurityDescriptor` 返回**已经是自相对的**描述符；验证 `SE_SELF_RELATIVE` 并按原样把那些返回的字节写为 COM `REG_BINARY` 值。`GetSecurityInfo` 读回相同的 DACL。（不存在 `ANONYMOUS LOGON`/`NETWORK` ACE；它们在完整允许列表上被缺席拒绝。）




> 因为服务器通过**提升标记**激活，`RunAs` 必须是 **`Interactive User`**（标记的 Activate-as-Activator / 交互式用户模型）。
> 如果你反而在 `RunAs` 中配置了特定账户，提升标记将不会按记录的交互式用户方式运作；因此设计明确拒绝命名账户的 `RunAs`。
>
> `LocalServer32` 路径和可选的 `ServerExecutable` 值必须**绝对且在不可写的安装目录中**，以免搜索路径/DLL 劫持替换二进制。
> `Elevation\Enabled` 是 **REG_DWORD `1`**，不是字符串 `"Enabled"`（字符串值不被 COM 提升代理认可）。进程外服务器在 `LocalServer32` 下**没有 `ThreadingModel`** — 在那里它不是有记录/有意义的值，因此不得发出。
>
> **位数 / WOW64 注册位置。** 注册进入**与 helper 二进制位数匹配的注册表视图**，在 `RegCreateKeyEx`/`RegOpenKeyEx` 调用上**显式用 `KEY_WOW64_64KEY` / `KEY_WOW64_32KEY` 标志**选择 — **不**是拼出 `WOW6432Node` 路径，因此我们从不把 `HKLM\Software\Classes` 变体或 `HKLM\Software\WOW6432Node\Software\Classes` 子树作为字面路径命名。产品仅发布 **amd64 和 arm64 helper（无 32 位 helper）**，因此我们明确**只注册 64 位 COM 视图（`KEY_WOW64_64KEY`）**，并且**完全不注册 32 位 COM helper**。运行的 helper **与其加载的 Wintun DLL 位数相同**（`wintun-amd64.dll`/`wintun-arm64.dll`，§3.1）；因为没有 32 位 helper，也就没有要产生的 32 位注册，混合位数（32 位标记对 64 位注册，或反之）是安装器绝不得产生的注册不匹配。

### 5.2 步骤（每个：进程、API、谁创建/连接、UAC API、句柄继承）

1. **客户端 COM 初始化（应用，Medium）。** `CoInitializeEx(NULL, COINIT_APARTMENTTHREADED)`；`CoInitializeSecurity(NULL, -1, NULL, NULL, RPC_C_AUTHN_LEVEL_PKT_PRIVACY, RPC_C_IMP_LEVEL_IMPERSONATE, NULL, EOAC_SECURE_REFS | EOAC_STATIC_CLOAKING, NULL)`。这为激活进程固定**packet-privacy 认证**和**模拟**。应用**不**预启动 helper，**不**使用 `runas`/`ShellExecuteEx` — 它激活 COM 服务器（步骤 2），OS 请求提升。
2. **通过提升标记激活（UAC 是提升 API）。**
   ```c
   BIND_OPTS3 bo = {};
   bo.cbStruct  = sizeof(bo);
   bo.hwnd      = hwnd;                    // parent window that owns the UAC prompt
   bo.dwClassContext = CLSCTX_LOCAL_SERVER;
   HRESULT hr = CoGetObject(
       L"Elevation:Administrator!new:{<CLSID_PrivilegedHelper>}",
       &bo, IID_PPV_ARGS(&pHelper));
   ```
   `CoGetObject` 加 **`Elevation:Administrator!new:{CLSID}`** 标记是提升请求点 — 仅由显式用户操作触发（§10.1 启用）。**提升代理（AppInfo）** 显示 UAC 并按标记命名的（交互式用户）对象以 **High IL** 启动 `helper.exe`，遵循清单的 `requireAdministrator`。
3. **服务器侧（helper，High）。** 在其 CLSID/AppID 下注册类工厂，以 High IL 运行。**句柄继承：** 设计**不**使用 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`；它**不需要继承句柄**（通过标记的提升激活无法传播一个）。
4. **通道。** 认证的 COM 接口**就是**通道；每个请求是 schema 校验的 `HelperCommand` 信封（§4），作为长度前缀、大小受限的字节 blob/`IStream` 传递。**无应用创建的命名管道**，因此没有端点名称泄露到用户可读介质。服务调用前服务器在代理上强制隐私：`CoInitializeSecurity(..., RPC_C_AUTHN_LEVEL_PKT_PRIVACY, RPC_C_IMP_LEVEL_IMPERSONATE, ...)`；客户端在其代理上用 `CoSetProxyBlanket(pHelper, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, NULL, RPC_C_AUTHN_LEVEL_PKT_PRIVACY, RPC_C_IMP_LEVEL_IMPERSONATE, NULL, EOAC_NONE)` 设置同样的。
5. **helper 认证应用（身份绑定）。** 在每次特权调用时 helper：
   - `CoImpersonateClient()`（以及为纯 RPC 对等的 `RpcImpersonateClient()`），然后
   - `RpcServerInqCallAttributes(call, RPC_CALL_ATTRIBUTES_V2, &atts)`，带 `atts.Version = 2` 和 **`atts.Flags = RPC_QUERY_CLIENT_PID`**；读取 **`atts.ClientPID`**（不是必须由调用方以不同方式命名的一个字段）→ **客户端 PID**。
   - **传输。** 断言调用通过**本地 `ncalrpc`** LPC 传输到达（由同一会话中的 LocalServer 使用）；拒绝任何 `ncacn_ip_tcp`/远程传输。（本地 RPC 是标记 LocalServer 使用的唯一协议。）
   - 在模拟令牌上 `GetTokenInformation(TokenUser/TokenStatistics/TokenIntegrityLevel)`：断言相同的**登录会话**、相同的**用户 SID**、**Medium IL**、**令牌类型**（primary/impersonation）。
   - **PID 仅用于打开并验证进程对象**，绝不单独作为身份：`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, clientPid)` + `QueryFullProcessImageName` → **规范化规范路径**；验证该路径的 **SHA-256 摘要**和 **Authenticode 发布者**与固定的应用身份匹配。同用户冒充者 — 即使带**复用 PID** — 也会失败路径/摘要检查，且不呈现**会话密钥**。
   - 检查后 `CoRevertToSelf()` / `RpcRevertToSelf()`。
6. **应用认证 helper。** `bootstrap` 方法返回**helper PID**；应用 `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, helperPid)` + `QueryFullProcessImageName` + Authenticode，并断言 helper 的规范路径 + SHA-256 + 发布者与固定的 helper 匹配。产生 medium-IL 服务器的改道/每用户注册失败此检查，因此应用拒绝信任它。
7. **握手 + 密钥。** 在认证通道上两侧派生 `sessionKey`（HKDF）；`launchSecret` 在**认证调用内部**交换（绝不在 cmdline/env/file 上）并在握手后立即用 `RtlSecureZeroMemory` 清零（§4.3）。`sessionKey` 为通道生命周期保留，在关闭/退出时清零。

这是使用**有记录提升标记引导**的自洽、可执行序列。因为传输是互认证且隐私加密的，同用户欺骗威胁由 OS 而非可读介质中的秘密关闭。

### 5.3 最小权限

- UAC 仅在首次启用（显式用户操作）时显示。`probe_integrity`/`get_status`/`health` 从不触发 UAC。
- helper 以 **High IL 但带受限令牌**运行。限制移除不必要的特权，但它**必须保留 `Administrators`（`BA`）SID 为已启用，而非 deny-only**，因为可信存储 DACL 特意通过其 `BA` ACE 授权 helper。启动时在打开或变更存储之前验证此令牌属性；失败则安全关闭，零网络修改。最小启用特权集包括用于 `WintunCreateAdapter` 的 `SeLoadDriverPrivilege`；路由/DNS/接口更改使用 `IP Helper`/`netsh` 等价 API，而非宽泛 admin。
- helper 是专用进程：无控制台、无自己的网络监听、无意外管理员 shell，**无**数据包会话（§1）。

### 5.4 实现前需对照固定的 Windows 目标确认的事实

以下是从一般 Windows 模型断言的，必须在任何实现前**对照精确的固定 Windows SDK / 最低 OS 目标以及精确的 Wintun 发行版重新检查**，因为本次会话未做实际查证：

- **提升标记**激活（`CoGetObject("Elevation:Administrator!new:{CLSID}", BIND_OPTS3, ...)`）触发 UAC 并启动 `requireAdministrator` LocalServer。确认能对 Medium-IL 激活产生 high-IL `helper.exe` 的确切 HKLM `CLSID`/`AppID`/`Elevation`/`LocalServer32` 键 + 值集，并且 **`RunAs = "Interactive User"`** 是正确设置（标记的 Activate-as-Activator / 交互式用户模型）。
- **`RPC_CALL_ATTRIBUTES_V2.ClientPID`** 配合 **`Flags = RPC_QUERY_CLIENT_PID`** 在目标上可用且被填充；且客户端调用通过本地 **`ncalrpc`** LPC 传输到达。如果目标无法报告传输/`ClientPID`，回退到 `CoImpersonateClient` + 在 `RPC_CALL_ATTRIBUTES_V1` + 令牌检查上的 `RpcServerInqCallAttributes`，并记录确切的替代方案。
- §3.0 固定的 **Wintun ABI** 与所选发行版的 `wintun.h`/`wintun.def` 匹配（导出名、`WINAPI` 调用约定、句柄类型、`NET_LUID`），且 **`WintunCreateAdapter` 按需安装/加载驱动**并接受 **`RequestedGUID`**。
- mihomo 能否按名称（或导出的 LUID）**打开/复用 helper 创建的适配器**正是 **G1** 问题 — **此处不回答**，且由 **G1 lifecycle probe**（§12）**门控**。

这些检查是实现前先决条件，使设计诚实而不主张未验证的 OS 行为。无论怎样，设计都立足于 round-3 修复；这些检查仅确定要调用哪些确切的 OS API。

### 5.5 每次启用单客户端常驻服务器（项 6）

helper 是**每个启用 TUN 窗口一个实例**，而非每个 IPC 事务一个。`enable` 激活它，它在整个启用窗口内保持 **resident-active**（§3.4）；`disable` 由**同一**实例服务 — main 进程通过**同一 COM 代理**发出两者 — 因此 helper 仍拥有来自 `create_adapter`（§3.3）的 creator 句柄。它**从不**是旧的"每命令全新 helper"模式（即单条命令完成就退出），因为**disable 无法触及一个它从未保持存活的进程**。

- **绑定到一个客户端。** 激活时 helper 注册类工厂，**仅接受第一个通过身份检查的客户端**（步骤 5–6）。每个后续激活客户端**被拒绝** — 包括一个逐字节相同（同一路径、同一 Authenticode 签名、同一 SHA-256）但是不同进程的**第二个 Murge 进程**：helper 已绑定到第一个经过验证的客户端的 `ClientPID`+登录会话+会话密钥，并拒绝第二个 `ProcessId`。此绑定对 helper 的**整个生命周期**成立（而非每命令），因此没有其他客户端可以附加到已经常驻的特权实例。
- **Resident-active；无 idle 退出。** 从 `create_adapter` 到拆除，helper 持有 creator 句柄并运行 **resident-active**（内部状态，§10.2）。**它在启用事务完成时**不退出**，并且**不受**活动窗口期间的普通空闲超时约束** — creator 句柄是保持适配器（进而数据平面）存活的东西，因此只要 TUN 启用，helper 就必须持续存在，即使零 IPC 流量。
- **退出条件（详尽）。** helper**仅**在以下情况退出：
  1. **正常 `disable` 完成**（路由/DNS 恢复、creator 句柄关闭、`RECONCILED` 写入、密钥清零）；
  2. **启用失败 + 恢复完成**（适配器回滚或干净调停）；
  3. **紧急恢复后的边界客户端/内核死亡**（§3.4）；
  4. **握手阶段超时**（短暂的绑定前引导窗口 — 与活动窗口不同）；
  5. 一个显式的**全局最大恢复超时**（对卡住的紧急恢复的硬上限，§3.4）。
  **没有其他定时器 — 特别是 resident-active 期间不适用 idle 超时。**
- **为何每次启用而非可复用。** 可复用 helper 会让无关进程（或带相同二进制的重启应用）附加到特权实例。每次启用激活 + 客户端绑定 + resident-active 生命周期关闭了这一点；OS 在它退出时也卸载该提升进程，因此在禁用或崩溃后没有残留的 High-IL 进程。
- **无双重激活。** 如果 `requestEnable` 已在执行中（promise-queue 序列化，§10），main 进程不发出第二次激活；尝试独立激活的第二个应用实例被客户端绑定规则拒绝（且在适用时，第二个实例已被单实例应用规则门控）。

---

## 6. Renderer 契约（仅意图）

- renderer **无法访问 helper 客户端、无设备/会话句柄、无特权**。它只有 `TunGateway`（一个 main 进程代理）。
- renderer 只能：
  - 通过 `getStatus()`/`onStatus()` **读取** `TunStatus`，以及
  - **发送类型化、无参数的意图** `requestEnable()`/`requestDisable()`（一次不携带任何参数点击）。这些是验证过的 IPC 意图；授权、变更、顺序和错误处理都在 main 进程 `TunService` 中完成，它是 `PrivilegedHelperClient` 句柄的**唯一持有者**。
- **没有** renderer→helper 路径、**无**任意参数、**无**直接变更状态的操作。UI 从不乐观地翻转状态；它渲染 main 报告的内容。

---

## 7. 驱动/helper 完整性流程（C1、C2）

- **清单：** 每架构 `helper.exe` + `wintun.dll` SHA-256 摘要和发布者指纹，在签名安装器内验证并在运行时重新检查（复用 `sha256File`、`mihomo-artifact.ts`）。
- **运行时：** 每次 `create_adapter`/`apply_network_state` 重新验证 helper 摘要 + 发布者和 `wintun.dll` 摘要。失败 ⇒ `{ phase:'failed'|'unsupported' }`，零变更，helper 不受信任。
- **失败关闭：** 缺失清单、摘要不匹配、不受信任的签名者、不可读文件 ⇒ 中止。自签名证书只允许在 CI "smoke" 路径中，绝不在生产激活中。

---

## 8. 网络快照 / 已写入 / 日志模型（项 2、项 6）

### 8.0 可信状态存储、完整性与 WAL 目录防御（round-6，项 2–4）

**恢复状态是一个**可信、仅 High-IL**存储，而不是任何用户可写文件夹（无 `AppData`/`%TEMP%`/application-data）。** 路径在安装时决定，并由**提升的 helper**创建（绝不由无特权安装器或 Medium 应用）：

```
%ProgramData%\<brand-independent-id>\tun-state\<ownerSid>\
    baseline.json     (BaselineSnapshot)
    written.json      (WrittenState)
    journal.json      (MutationJournal)
    state.manifest    (record set: schemaVersion + per-file SHA-256)
```

- **在首次 `enable`（或 `--recover`）时由提升的 helper 创建，按固定布局。** `<brand-independent-id>`（如 `Murge` — 一个稳定、品牌无关的令牌，因此改名不丢失恢复状态）和 `<ownerSid>`（授权用户的 SID，十六进制/`S-1-5-21-…`）分离每个所有者的状态，因此一个账户无法看到或损坏另一个的。
- **所有者是 `SYSTEM`**（S-1-5-18）。DACL 是**纯允许列表**，**无继承**、**无掩盖所有者的 deny**：
  * `SYSTEM` — `GA`（完全控制：创建/读取/写入/删除/更改 ACL）；
  * `Administrators` — `GA`（完全控制：安装/修复/恢复）；
  * **无`owner user SID` ACE**（见下文），并且不授予 `Everyone`/`Users`/`Authenticated Users`。

  **状态目录 DACL（可解析的 SDDL）。** 所有者 `SYSTEM`（`O:SY`）、主组 `SYSTEM`（`G:SY`）、**受保护**（`D:P`）、**容器/对象继承**（`OICI`）、**完整的纯允许列表**，**无 `DENY`**，携带**High 强制完整性标签**，带 `NO_WRITE_UP`（`NW`）和继承（`OICI`）：

  ```
  O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)
  S:(ML;OICI;NW;;;HI)
  ```

  | SDDL ACE | 对象 SID | 允许/拒绝 | 访问掩码 | 继承 | 原因 |
  |---|---|---|---|---|---|
  | `(A;OICI;GA;;;SY)` | `SYSTEM` `S-1-5-18` | **允许** | `GA` generic-all（0x1F01FF） | 对象 + 容器 | 完全控制 — 对存储树的创建/读取/写入/删除/更改 ACL。 |
  | `(A;OICI;GA;;;BA)` | `Administrators` `S-1-5-32-544` | **允许** | `GA` generic-all（0x1F01FF） | 对象 + 容器 | 安装/修复/恢复；完全控制以便修复能重建存储。 |
  | (无) | 所有者用户 SID `S-1-5-21-<dom>-<rid>` | **缺席（无 ACE）** | — | — | Medium 所有者获得**无原始读取**（如需要），因此 **owner SID ACE 被省略**；UI 仅通过 helper COM 读取**清洗后的**状态（见下文）。 |
  | (无) | `Everyone` / `Users` / `Authenticated Users` | **缺席（无 ACE）** | — | — | 在完整 ACL 上默认拒绝 ⇒ 无访问；从不授予。 |
  | `(ML;OICI;NW;;;HI)` | `High` `S-1-16-12288`（标签 ACE） | — | `NW` = `NO_WRITE_UP` | 对象 + 容器 | 强制完整性的 `High` 标签，被继承，带 `NO_WRITE_UP`；`HI` = `S-1-16-12288`。 |

  **为何**没有**`owner SID` ACE（Medium 表面从不打开原始文件）。** helper（通过 `RunAs = Interactive User` 作为**所有者的高完整性令牌**激活）是 **`Administrators`** 的成员（COM 提升标记仅在交互式用户是管理员或提供管理员凭据时运行），因此其令牌携带 **`BA` 启用**，并通过 `BA` ACE（`GA`）到达存储。同一用户的 **Medium** 令牌把 `Administrators` 视为 **deny-only/受限**（UAC 管理员批准模式），并且**没有** `owner SID` ACE，因此它被**DACL 和 High 强制标签**（`NO_WRITE_UP`）**拒绝读写、删除和更改 ACL**。Medium UI 仅通过 helper COM 读取**清洗后的**状态，**从不**打开原始 `baseline.json`/`journal.json`。这是审阅者指出的**首选**情况 — 因为 Medium 表面**不需要原始读取**，不添加 `owner SID` 文件 ACE，UI 仅使用 COM 清洗的状态。（如果未来的非管理员 helper 必须写入存储，确切的文件掩码会由 §13 中的描述符构建测试断言；这不是这里的设计。）

- **同用户 Medium/High 拆分是存储契约的要义。** helper 作为**所有者的高完整性令牌**（`RunAs = Interactive User`）运行，它是 **`Administrators`** 的成员（提升标记 ⇒ 交互式用户是管理员或提供管理员凭据），因此它通过 **`BA`（`GA`）ACE**到达存储。**同一用户 SID** 的 Medium UI 令牌把 `Administrators` 视为 **deny-only/受限**（UAC 管理员批准模式）且**没有** `owner SID` ACE，因此它被 DACL **且**被 **`High` 强制标签**拒绝。分离是**强制完整性控制 + 缺失的 owner ACE**：`tun-state` 和 `<ownerSid>` 目录携带 **`High` 强制标签**（`S:(ML;OICI;NW;;;HI)`，`HI` = `S-1-16-12288`，`NW` = `NO_WRITE_UP`）。该 SID 的 **Medium** 令牌被**拒绝 写入 / 删除 / ACL 更改**（MIC write-up），而 **High** helper 通过。因此 Medium 表面**无法**写入、删除或重新 ACL 状态目录/文件 — 这是 round-6 审阅者要求的属性。
- **所有者仅通过 helper COM 读取清洗后的状态。** 为获取状态，helper 暴露 `get_status`/`get_state`，它返回**清洗后的投影**（renderer 需要的当前 `WrittenState` 字段，**无**原始 `BaselineSnapshot`/`MutationJournal` 记录，无机密，无超过 UI 显示的 LUID/GUID）。**main（Medium）从不打开原始文件**；没有面向 Medium 的读取路径到 `baseline.json`/`journal.json`。
- **每条记录仅由 helper 写入**，始终通过安全文件 I/O：
  * 用 `CreateFile` 打开，带 **`FILE_FLAG_OPEN_REPARSE_POINT`**（因此 reparse point 会被浮现，而非跟随）+ 目录的 `FILE_FLAG_BACKUP_SEMANTICS`；
  * 使用前**验证每个路径组件**，并且**拒绝**存储路径上的任何 **symlink / junction / mount point / reparse point**（用 `FILE_FLAG_OPEN_REPARSE_POINT` 打开并查询 `FileAttributeTagInfo`/`GetFileInformationByHandle` 的 `FILE_ATTRIBUTE_REPARSE_POINT`），因此植入的 `junction`/`symlink` 无法重定向存储；
  * 绝不**按字符串路径重新打开**用户可替换的位置 — 一旦文件打开（并记录其 `file ID`），复用该 **句柄**，并在每次追加前**重新验证**句柄仍指同一对象（`FileIdInfo` / `GetFileInformationByHandleEx`），匹配记录的 `file ID`；不匹配 ⇒ **失败关闭**；
  * 写入**同一目录**中的临时文件、`FlushFileBuffers`，然后**原子 `ReplaceFile`/重命名**到位（因此写入中途崩溃绝不会留下撕裂记录）；
  * **绝不跟随用户可控路径**（`%TEMP%`/app-data 中的文件不会被提升到提升位置；存储仅存在于 `%ProgramData%\<id>\tun-state\<ownerSid>` 下）。
- **升级/卸载保留目录。** 它跨升级和卸载被保存，且**仅**在安全恢复完成后移除（无待处理 `PREPARED`/`APPLIED` 记录且路由/DNS 回到基线），因此丢失恢复状态不会使活动接口或路由/DNS 变更成为孤儿。

**完整性 / 真实性是确定的 — "HMAC 或 digest"已移除。** **首要权威是上述 Medium 不可写 DACL + High 强制标签**（同用户攻击者**根本不能**写入存储）。在该边界之上，记录携带 **`schemaVersion` + 一个 SHA-256 摘要**（在 `state.manifest` 中）*仅用于检测意外损坏/截断* — 能写入存储的同用户攻击者也会重写摘要，因此摘要**不**被呈现为防篡改的真实性。**没有磁盘状态 HMAC**主张：如果使用 HMAC，它需要密钥位置、密钥生成、**DPAPI** 保护、轮换和升级/恢复读取路径，这些我们**不**提供 — 因此 HMAC 措辞**已删除**，只主张 DACL/完整性标签边界 + 损坏检测。（§4.3 中 IPC 的**通道**信封 MAC 是认证 COM 通道之上的独立逐消息认证器，**不是**磁盘状态完整性主张。）

**对任何异常失败关闭。** 在**读取失败、错误 ACL、错误所有者、发现的 reparse point、或 schema/摘要异常**时，helper 执行**零网络修改**并进入 **`restore-failed`**（状态机 §10.2），保留存储供人工/`--recover` 决策 — 它绝不从无法信任的数据继续变更路由/DNS 或关闭句柄。

### 8.1 记录与类型修复

```ts
// BaselineSnapshot — exact pre-enable OS state (immutable reference for restore)
interface BaselineSnapshot {
  schemaVersion: 1
  instanceId: string
  capturedAt: string
  interfaces: InterfaceSnapshot[]            // keyed by LUID/index
  firewallProfile: string | null
}
interface InterfaceSnapshot {
  luid: string                               // canonical hex NET_LUID string (64-bit, NOT a JS number)
  index: number                              // 32-bit interface index (safe as number)
  description: string
  type: string                               // e.g. "Ethernet"/"Wireless"/"Loopback"
  metric: number | null
  state: string
  ipv4Routes: RouteSnapshot[]
  ipv6Routes: RouteSnapshot[]
  dns: DnsSnapshot[]
}
interface RouteSnapshot {
  destination: string                        // prefix, e.g. "0.0.0.0/0"
  prefixLength: number
  nextHop: string | null
  metric: number
  protocol: string                           // static | dhcp | onlink | ...
  routeStore: 'active' | 'persistent'
}
interface DnsSnapshot {
  server: string
  source: 'dhcp' | 'static' | 'manual'
}

// WrittenState — EXACTLY what the helper wrote (owned reference)
interface WrittenState {
  schemaVersion: 1
  instanceId: string
  writtenAt: string
  routeAdditions: Array<{ luid: string; route: Omit<RouteSnapshot,'source'> }>
  routeDeletions: Array<{ luid: string; route: Omit<RouteSnapshot,'source'> }>
  dnsSets: Array<{ luid: string; servers: string[] }>   // FIX: closing '>' on Array<...>
  metricSets: Array<{ luid: string; metric: number }>
}

// MutationJournal — WRITE-AHEAD, append-only, ordered log (crash recovery)
// Every mutation is a two-phase record: PREPARED (fsync'd BEFORE the mutation) then
// APPLIED. The journal is the authoritative recovery log; the OS is never mutated before
// its PREPARED record is durable on disk (§8.3, §8.4).
interface MutationJournalEntry {
  seq: number
  at: string
  journalType: 'PREPARED' | 'APPLIED' | 'RECONCILED'
  op: string            // createAdapter | deleteAdapter | addRoute | delRoute |
                        // setDns | setMetric | ...
  // target identity, all as canonical types so an un-applied op is recoverable:
  adapterName: string | null       // product adapter name
  requestedGuid: string | null     // product RequestedGUID (stable identity)
  luid: string | null              // canonical hex NET_LUID string (64-bit, not a JS number)
  before: unknown
  after: unknown       // expected value (for APPLIED); null for a not-yet-applied PREPARED
  baselineFingerprint: string   // sha256 of the committed BaselineSnapshot
}
```

> **类型修复（项 6）：** `dnsSets` 是 `Array<{...>`（未闭合）→ 现在为 `Array<{...}>`。`NET_LUID` 是 **64 位值**，在 JSON 中的任何地方都序列化为**规范十六进制字符串**，绝不是 JS number。`requestId` 是**单调 uint64 十进制字符串**（每会话序列），绝不是 UUID/字符串混合。

### 8.2 `DesiredNetworkState`（项 3 — 唯一修改者意图）

```ts
interface DesiredNetworkState {
  schemaVersion: 1
  adapter: {
    name: string          // stable product adapter name ("Murge TUN")
    tunnelType: string    // stable opaque tunnel-type string ("Murge TUN")
    requestedGuid: string // stable product RequestedGUID (identity for create/recover)
  }
  routes: Array<{ family: 4 | 6; destination: string; prefixLength: number;
                  nextHop: string | null; metric: number; routeStore: 'active'|'persistent' }>
  dns: Array<{ luid: string; servers: string[]; source: 'static' | 'dhcp' }>
  metrics: Array<{ luid: string; metric: number }>
}
```

由 main 进程（`policy.deriveDesiredNetworkState(validatedMihomoConfig)`）从验证过的运行时配置生成，并由 helper 逐字应用。因为 `auto-route`/`dns-hijack` 在运行时配置中被禁用，这是路由/DNS/接口变更的**唯一**来源。

### 8.3 预写日志（WAL）— 在变更之前先将意图持久化

日志是**预写（write-ahead）**的：OS**绝不在其 PREPARED 记录在磁盘上持久化之前被变更**。

- **`BaselineSnapshot` 先行提交。** 在任何变更之前 — 并在 `create_adapter` 之前 — helper 写入 + 验证 + fsync 完整的 `BaselineSnapshot`（原子：临时 → 验证 → 重命名）。如果无法做到，它以**零变更**中止。
- **`create_adapter` 本身就是 WAL。** 在调用 `WintunCreateAdapter` 之前，helper 写入 + fsync `CREATE_ADAPTER/PREPARED`，携带 `{ adapterName, tunnelType, requestedGuid }`（可恢复身份）。仅在该记录持久化后它才调用 `WintunCreateAdapter`。成功后它写入 `CREATE_ADAPTER/APPLIED`，带导出的 `luid`（来自 `WintunGetAdapterLUID`）+ 从句柄导出的 GUID。
- **每个路由/DNS/接口变更都是两阶段记录。** 对每个操作（`addRoute`、`delRoute`、`setDns`、`setMetric`）：写入 + fsync `${op}/PREPARED` 记录，带其目标身份和预期 `after`；变更 OS；然后写入 `${op}/APPLIED`，记录确切的最终值（这也是 `WrittenState`）。
- **日志是仅追加且有序的。** 崩溃可能发生在**任意两条记录之间**；恢复重放的是持久的记录流，而不是假设。
- **WAL 本身受到目录替换防御（§8.0）。** 在 `init`/`--recover` 时，helper 首先验证存储**目录** — 其**所有者**、其**DACL**（允许列表/HIGH 标签契约）及其**reparse 状态**（无 junction/symlink/mount point）。日志文件在运行期间**打开一次**；在**每次** `PREPARED`/`APPLIED`/`RECONCILED` 追加前，helper**重新验证已打开的句柄仍指向同一对象**（`FileIdInfo`/`GetFileInformationByHandleEx` 文件 ID 匹配）— 它**绝不按字符串路径重新打开 `journal.json`**（用户可替换的位置）。任何不匹配 ⇒ **零网络变更** + `restore-failed`。

### 8.4 恢复：对照当前 OS 状态调停 PREPARED-but-unknown

崩溃可能留下一个**PREPARED** 记录，无匹配的 **APPLIED** — 变更可能发生也可能没有。恢复必须**通过列举调停**，而非假设：

- **下次启动 / `--recover`。** `TunService.init()`/`--recover` 加载 `BaselineSnapshot` + 日志。对每个从末尾向前的操作：
  - **APPLIED** → 撤销（反转该操作），遵守逐项 owned-only 规则（§8.5）；然后写入匹配的 `RECONCILED` 记录。
  - **无 APPLIED 的 PREPARED** → 变更成功**未知**。**不**假设发生或未发生。相反**对照当前 OS 状态调停**：
    - 对 `CREATE_ADAPTER`：按名称 **`WintunOpenAdapter(Name)`** 打开产品适配器并验证身份 — 将 `RequestedGUID` 与 `WintunGetAdapterLUID(handle, &luid)` + `ConvertInterfaceLuidToGuid`（和/或 SetupAPI 设备匹配）比较。仅在与**精确身份匹配**时才关闭 creator 句柄 / 运行产品生命周期清理；如果 creator 句柄已关闭（在 `APPLIED` 与清理之间崩溃），先**观察适配器是否自动消失** — 如果已消失，标记 `RECONCILED`（无撤销）；如果仍存在，它现在只是我们从未为其创建句柄的孤儿，因此按名称+身份调停并记录 `RECONCILED`，不做不想要的变更。无 `WintunDeleteAdapter`。
    - 对路由/DNS 操作：**读取该 LUID/前缀的当前 OS 状态**；如果匹配操作的 `after`，把它撤销回 `before`；如果从未生效，标记 `RECONCILED`（无撤销）。
- **逐项 owned-only 规则（绝不全部或全无）。** 撤销按 LUID/族/字段进行。如果当前值仍等于我们写入的，恢复到基线；如果被外部更改，**不**覆盖 — 记录一个**逐项 `conflict`**（`conflictDetail`）并保留该项。无关项不受影响；仅当拥有的项被外部修改时相位变为 `conflict`，否则恢复完成到 `configured`。
- **逆序。** 撤销**反向**遍历日志，因此依赖项（如在接口指标之后添加的路由）在它依赖的依赖项被拆除之前被拆除。恢复中途崩溃会幂等地重新运行（每个撤销都受现有 `RECONCILED` 标记保护）。
- **`CLOSE_CREATOR_HANDLE`（提交点）。** 适配器**仅**通过关闭 creator 句柄被移除 — 这是**最后**的撤销步骤，本身是 WAL：`CLOSE_CREATOR_HANDLE/PREPARED` → 通过 `Name` + `RequestedGUID`（以及导出的 LUID）验证所有权 → 确保 mihomo 已结束其会话并关闭其打开句柄 → `WintunCloseAdapter(creatorHandle)` → `CLOSE_CREATOR_HANDLE/APPLIED`（→ `RECONCILED`）。**没有** `WintunDeleteAdapter`、**没有** `ERROR_REBOOT_REQUIRED` 适配器删除返回、**没有** `delete-pending` 状态。一旦句柄关闭，适配器被报告为消失。如果所有权无法证明，**不**关闭句柄；记录一个逐项 `conflict` 并保留它（D5）。

### 8.5 逐项 owned-only 恢复规则

恢复**绝不全部或全无**。把整个快照当作一个单元要么因为一项被外部更改而全部失败，要么覆盖用户的更改。相反每项独立决定：

- 将**当前** OS 值与我们的写入（操作的 `after`/`WrittenState`）比较。
- 如果仍等于我们写入的 → 恢复到 `BaselineSnapshot` 值。
- 如果被**外部更改** → **不覆盖**；记录一个逐项 `conflict`（`conflictDetail`：LUID/索引、族、字段、预期 vs 当前）并保留它。
- 无关项不受影响；仅当拥有的项被外部修改时相位变为 `conflict`，否则恢复完成到 `configured`。

---

## 9. 配置门控（C7）— 仅允许单所有者激活

今天 `mihomo-config.ts` 对每个文档断言 `tun`/`dns` 只包含 `enable` 且必须为 `false`。Phase 9 通过一个经评审、被测试的更改改变这一点：

- 保留开发安全默认：非 Windows 或无已验证 helper，仍失败关闭并拒绝合成的 `tun.enable:true` / `dns` 块。
- 在 Windows 上，运行时激活路径可以**仅**在运行配置中合成一个 `tun`/`dns` 块（绝不作为用户偏好持久化，在禁用时拆除），并且它**仅**由 main 进程为单所有者模型产生：
  - `tun: { enable: true, stack: system, auto-route: false, auto-detect-interface: false }`
  - `dns: { enable: true, hijack: false, nameserver: [mihomo loopback DNS] }`
  - `auto-route` / `auto-detect-interface` / `dns-hijack` 为 **false/缺席**，因为 helper 是唯一修改者（方案 A，§1.1）。helper 应用的路由/DNS 来自 `DesiredNetworkState`（§8.2），而非 mihomo。
- `mihomoConfigErrors` 保持单一门控并获得一个显式 `allowedTunContext: false|'activate'` 参数：除授权的 `activate` 路径外处处为 `false`。携带自己的 `tun`/`dns`/`rules` 的配置文件仍然无法漏过。
- helper 从未被交给要变更的 mihomo 配置；它只接收类型化的 `DesiredNetworkState`。

---

## 10. TUN 状态机、启用顺序与 UI 文案

### 10.1 启用顺序（固定，项 2） — 预写

启用操作在 main 进程 `promise-queue`（序列化）内运行。每个变更都是**预写**的：其 `PREPARED` 记录在 OS 被触碰**之前**持久化（§8.3）。确切顺序是：

```
  1 verify            probe_integrity (helper + wintun digest/publisher); no elevation, no mutation
  2 elevate/bootstrap activate helper via Elevation:Administrator!new; handshake + sessionKey
  3 BaselineSnapshot  helper writes + fsyncs + verifies the FULL baseline BEFORE any mutation;
                      abort with zero mutation if it cannot
  4 CREATE_ADAPTER/PREPARED  helper writes + fsyncs {adapterName, tunnelType, requestedGuid}
                      BEFORE calling WintunCreateAdapter (recoverable identity)
  5 create adapter    helper calls WintunCreateAdapter(Name, TunnelType, RequestedGUID);
                      installs/loads driver on demand + creates adapter; WintunGetAdapterLUID
                      derives the LUID; assert exactly one Murge adapter (Name+RequestedGUID)
  6 CREATE_ADAPTER/APPLIED  write {adapterName, requestedGuid, luid} and pin the canonical-hex LUID
 7 apply routes/DNS  for each op: write ${op}/PREPARED -> mutate OS -> write ${op}/APPLIED
 8 start mihomo     mihomo opens/reuses the adapter (G1) and starts its packet session
  9 readiness probe  probe the TUN/loopback path is live; assert routes/DNS present
 10 active           phase → active; helper is resident-active (§3.4/§5.5): it keeps the creator
                     handle open for the whole enabled window; renderer gets the true status
```

- **路由/DNS 总是在适配器创建之后写入**（步骤 7+ 跟随步骤 5–6），因此它们的目标接口 LUID/索引已存在。
- **`CREATE_ADAPTER` 是预写的**：`PREPARED` 记录（步骤 4）在 `WintunCreateAdapter`（步骤 5）**之前**被 fsync，`APPLIED` 记录（步骤 6）仅在它成功之后写入。步骤 4 与 6 之间崩溃留下 `CREATE_ADAPTER/PREPARED` 记录，恢复通过 **`WintunOpenAdapter(Name)`** + 身份验证调停（§8.4）。
- **基线/日志位于可信状态存储（§8.0）。** 步骤 3 首先创建/验证 `%ProgramData%\<id>\tun-state\<ownerSid>\` 目录（所有者、DACL、强制标签、reparse 状态），然后在那里写入 + fsync `BaselineSnapshot`；每个后续记录通过持有的句柄落入同一已验证存储。任何步骤的存储/ACL/reparse/完整性异常 ⇒ **零网络变更** + `restore-failed`。
- **任何步骤的失败都按逆日志顺序恢复**（§8.4），把每个 PREPARED-but-unknown 操作对照当前 OS 状态调停：步骤 9 失败撤销步骤 7–6 然后适配器（关闭 creator 句柄，§3.3）；步骤 5（或 4–6 之间）失败通过 `WintunOpenAdapter(Name)` + 身份调停适配器；步骤 2（UAC 取消/超时）失败留下**零变更**。
- **禁用是镜像，由**同一个常驻 helper**服务（§3.3、§5.5）：** main 通过同一 COM 代理调用同一 helper；mihomo 结束其会话（`WintunEndSession`）并关闭其打开句柄 → helper 逐项恢复路由/DNS（逆 WAL 顺序）→ **`CLOSE_CREATOR_HANDLE/PREPARED` → 通过 `Name`+`RequestedGUID`+LUID 验证所有权 → `WintunCloseAdapter(creatorHandle)`（移除适配器）→ `CLOSE_CREATOR_HANDLE/APPLIED`/`RECONCILED`** → 调停日志 → `configured`。**没有** `WintunDeleteAdapter`，**没有** `delete-pending`/`RebootRequired` 路径。helper**在整个启用窗口内持有 creator 句柄**（固定安全基线，§3.3），因此**disable 能到达创建适配器的同一实例** — 它从不为了 disable 而生成新 helper。

### 10.2 转换表

| 相位 | 进入 | 允许的动作 | 失败时 |
|---|---|---|---|
| `configured` | init/recovery，禁用结束 | enable | — |
| `starting` | `requestEnable` 意图 | verify → snapshot → `create_adapter`/PREPARED→APPLIED → pin LUID → `apply_network_state`（每个操作 PREPARED→APPLIED）→ mihomo open → probe | → `restoring`（逆 WAL 顺序）→ `restore-failed`/`failed` |
| `active` | 路由/DNS 已应用 + mihomo TUN up | disable、拆除 | → `restoring` |
| `restoring` | disable/拆除/回滚 | 逐项 owned-only 恢复，逆日志顺序 | → `conflict`（逐项）或 `restore-failed`（损坏） |
| `failed` | 不可恢复的完整性/适配器/捕获 | retry / report | — |
| `conflict` | 外部修改的拥有项 | 无（report，逐项） | owner/emergency 路径 |
| `unsupported` | 非 Windows / 无已验证 helper | 无 | — |
| `restore-failed` | 无法恢复（非 conflict） | retry / `--recover` | — |

不变量：每个转换重新验证所有权 + 基线摘要；`restoring` 是幂等的；激活中途崩溃在下次启动时从日志 + 基线调停，或通过 `--recover` 调停。在可信存储上，**读取失败、错误 ACL、错误所有者、发现的 reparse point、或 schema/摘要异常**（§8.0）⇒ **零网络变更**和 `restore-failed`（绝不从无法信任的数据继续变更）。

> 此表是**renderer 可见**的产品相位。与之并列，helper 有自己的内部状态机，带一个 **`resident-active`** 状态（§3.4/§5.5）：从 `create_adapter` 到 disable/emergency，helper 都是 `resident-active`，持有 creator 句柄并监视绑定应用 + mihomo 进程句柄；在有界紧急恢复期间它是 `recovering`；否则它是 `booting`/`handshake`（短暂预绑定窗口）或 `exiting`。helper**绝不会**在 `resident-active` 时因空闲超时退出。

### 10.3 规范 UI 文案（中文，与 `system-proxy` 风格一致）

| 相位 | UI 文案 |
|---|---|
| `configured` | TUN 未启用（当前平台支持） |
| `starting` | TUN 正在启动… |
| `active` | TUN 已启用 |
| `failed` | TUN 启用失败 |
| `restoring` | 正在恢复网络设置… |
| `restore-failed` | 网络设置恢复失败 |
| `conflict` | 检测到网络配置被外部修改，未还原该条目 |
| `unsupported` | 当前平台不支持 TUN |

---

## 11. 提议的模块/接口布局

| 文件 | 内容 | 测试 |
|---|---|---|
| `src/shared/tun.ts` | `TunPhase`、`TunStatus`、`TunGateway`、IPC 名称、`HelperOp`/`HelperCommand`、`DesiredNetworkState` | — |
| `src/shared/schemas/tun.ts` | 用于 `TunStatus`、`HelperCommand`、`DesiredNetworkState`、snapshot/written/journal 记录的运行时 Zod schema | 有效/无效/前向兼容 |
| `src/main/tun/service.ts` | `TunService`（状态机、promise-queue、probe、backup、reconcile） | `FakeTunAdapter` + `RecordingBackupStore` |
| `src/main/tun/policy.ts` | 纯 `deriveDesiredNetworkState`、`isOwned`/`matchesWritten`/`buildBaseline`/canonical-MAC 辅助函数 | 纯单元 |
| `src/main/tun/adapters/windows-tun-adapter.ts` | helper 客户端 + 完整性验证 + 快照/调停 | 伪造；真实路径门控 |
| `src/main/tun/adapters/disabled-tun-adapter.ts` | 非 win32 用 `{supported:false, phase:'unsupported'}` | 单元 |
| `src/main/tun/adapters/fake-tun-adapter.ts` | 用于开发/测试的确定性内存 helper | — |
| `src/main/tun/helper-client.ts` | COM 提升激活 + 身份绑定 + 信封 + 密钥生命周期 | 单元（伪造 COM） |
| `src/main/tun/types.ts` | 本地类型（snapshot/written/journal/DesiredNetworkState、status） | — |
| `src/main/tun/probe.ts` | TUN 就绪探针（复用累积缓冲模式） | 单元 |

---

## 12. 实现前的门槛与剩余决策

**必须先通过/先决策的硬性门槛：**

- **G1（适配器交接 + creator 句柄生命周期）— 未验证，且是硬性实现前门槛。** 在对交接路径做任何 Phase 9 实现之前，在门控作业中运行 **G1 lifecycle probe**，它在一次性、可快照的 Windows VM 上演练四步并记录一个决定性事实：
  1. **(a)** helper `WintunCreateAdapter` → 持有**creator 句柄**；`${name}` 存在；
  2. **(b)** mihomo `WintunOpenAdapter(name)` → **第二个句柄** + `WintunStartSession` ⇒ 活动数据平面；
  3. **(c)** helper `WintunCloseAdapter(creatorHandle)` → helper 退出；
  4. **(d)** mihomo 的会话**和**适配器 `${name}` 是否**仍然存在**？
  探针**不得**扩展为完整的 Phase 9 实现（无 helper 服务、无路由/DNS、无持久化、无 UAC 引导机制），且它**绝不在本开发机上运行**（它需要可快照、带外可恢复的 Windows VM + 门控 CI + 单独的所有权授权记录 — §0.0 / DEVELOPMENT_SAFETY）。**两种观察**：如果适配器在 (c) 消失 → **Observed A**；如果它在 mihomo 持有句柄时存活 → **Observed B**。**两者都不改变安全基线**，它是**固定**的（§0.4/§3.3/§5.5）：helper 在**整个启用窗口内持有 creator 句柄**，并且是**每次启用单客户端常驻服务器**；观察仅告诉我们以后的优化（如让 helper 在启用完成时退出）是否可信。**如果 G1 失败 / 无法完成**（mihomo 无法复用 helper 创建的适配器），**停止并返回所有者**以作出修改后的所有权决策；不要回退到双所有权（§3.3）。
- **D4 — 已解决：无开机自启动。** 独立 helper 没有服务、计划任务、`Run` 键或其他启动触发。它仅为应用内显式启用动作或显式手动 `--recover` 启动；状态/探针/UI 启动从不提升或启动它。
- **D5 — 已解决：绝不移除预存在/共享的 Wintun 状态。** 生产从不调用 `WintunDeleteDriver`，绝不会删除预存在/外来适配器，且卸载从不移除它未创建并持续拥有的驱动或适配器。唯一的适配器移除动作是关闭本启用会话可证所有的 creator 句柄（§3.3）。
- `helper.exe` 的**证书提供者 / 受信任发布者**（见 `CODE_SIGNING.md`）。
- 独立**所有权授权**记录（谁、什么、何时），在任何实现之前。
- **DNS 劫持范围**、HTTPS 解密/改写可见性、休眠/唤醒 + 网络变化调停深度。

仓库只包含一个**仅验证的 G1 工作流脚手架**（`.github/workflows/g1-probe.yml`）：手动触发 + 精确确认 + 授权、目标、快照和恢复标识符 + 受保护的 `phase9-tun-lab` 环境 + `self-hosted, windows, x64, murge-tun-lab` 运行器。它记录 `probeExecuted:false`；尚无原生探针体。剩余行的实现/测试仅在设计评审签核和另行所有权授权之后进行，且仅在门控的一次性 Windows 作业中（`MURGE_RUN_REAL_TUN=1` **且** `win32`，绝不在默认 `npm test` 中）。

---

## 13. 测试 / 证据矩阵（项 7）

所有真实行为仅在门控的 `windows-latest` 作业中运行（`MURGE_RUN_REAL_TUN=1` **且** `win32`），绝不在默认 `npm test` 中。**访问控制 / 描述符构建**行（`T24`、`T38`–`T40`、以及状态目录 DACL/SACL 读取）是**仅 Windows 的单元测试，无需真实 TUN、无需网络变更、无需提升 helper** — 它们在进程内构建 `SECURITY_DESCRIPTOR`，因此它们在没有 `MURGE_RUN_REAL_TUN` 的 `win32` 作业中运行。

| # | 测试 | 断言 | 证据 |
|---|---|---|---|
| T0 | **G1 lifecycle probe（一次性、硬性门槛）** | (a) helper `WintunCreateAdapter` 持有 creator 句柄；(b) mihomo `WintunOpenAdapter` + `WintunStartSession` ⇒ 活动数据平面；(c) helper `WintunCloseAdapter(creatorHandle)` / 退出；(d) 断言**适配器/会话是否仍然存在**。在一个之后带外恢复的可快照 VM 上 | 在 a/b/c/d 各自列举适配器 + 会话存在性；记录**哪个观察**（A = 在 creator 关闭时消失，B = 在 mihomo 持有句柄时存活）并断言**固定基线**（无观察改变 helper-持有-creator-句柄 模型）；机器已恢复 |
| T1 | **单所有者数据平面 / 适配器交接（G1）** | helper 创建适配器后，mihomo **复用同一 GUID/LUID**（RequestedGUID 是稳定身份）且系统中恰好有**一个 Murge 适配器** | 在之前/之后按 Name/RequestedGUID/LUID 列举适配器；断言 count==1；断言 mihomo 会话绑定同一 LUID |
| T2 | 顺序：适配器创建之后的路由/DNS | 路由/DNS/接口**仅在**适配器存在之后写入；适配器创建之前的失败留下零路由/DNS | 在每步的日志 seq + 适配器存在性；断言没有路由/DNS 操作先于 `createAdapter` |
| T3 | **mihomo 不发出任何路由/DNS 变更** | 带 `auto-route:false`、`auto-detect-interface:false`、`dns-hijack:false`，mihomo 在 helper 之外**不**添加/移除任何路由/DNS/接口 | mihomo 启动前后的路由/DNS 快照，diff == 仅 helper 写入的集合 |
| T4 | 隔离双所有权回归 | 当 helper 拥有 OS 配置时，断言运行时配置绝不包含 `auto-route:true`/`auto-detect-interface:true`/`dns-hijack:true` | config-validator 单元 + 集成 grep |
| T5 | **提升标记引导：同用户恶意竞态连接** | 当应用正在连接时，第二个 Medium-IL 进程无法激活/连接到运行中的提升 helper，且无法冒充应用 | 从第二个 medium 进程尝试激活/连接；断言被拒绝（身份绑定） |
| T5b | **第二个 Murge 实例竞态（同一路径/签名/哈希）** | **第二个 Murge 进程** — 逐字节相同二进制（同一路径、同一 Authenticode、同一 SHA-256）— 尝试连接运行中的每次启用常驻 helper；helper 已绑定第一个经过验证的客户端并**拒绝**第二个 | 启动第二个应用；断言其激活/连接被拒绝；断言它无法驱动 helper |
| T6 | **PID 复用** | 进程对象被复用（退出 + 替换）的客户端 PID 因路径/摘要/会话密钥不再匹配而被拒绝 | 退出应用，让一个复用 PID 连接；断言拒绝 |
| T7 | **握手/命令超时 + helper 退出清零** | **握手阶段**超时或**命令请求/响应**超时清零 `launchSecret`/`sessionKey` 并留下零变更，且 helper 退出；一个**resident-active** helper 在**无 IPC** 接收时**不**退出 | 在绑定前窗口和每命令注入超时；断言无变更 + 机密已清零；断言在长 IPC 间隙期间 resident-active helper 保持（适配器仍存在） |
| T8 | **重放** | 带陈旧 `requestId` 的重放 `HelperCommand` 被拒绝 | 重放记录的帧；断言拒绝 |
| T9 | **在每个日志记录边界注入崩溃（WAL）** | 在**每个持久日志边界**强杀 helper（预快照、后快照、`CREATE_ADAPTER/PREPARED`-已写、**`WintunCreateAdapter` 中途**、后 `CREATE_ADAPTER/APPLIED`、预 `${op}/PREPARED`、路由/DNS 变更中途、后 `${op}/APPLIED`、预 mihomo、后 probe、`CLOSE_CREATOR_HANDLE/*`）；断言下次 `init()`/`--recover` 把每个记录对照当前 OS 状态调停并恢复基线 | 每边界的日志重放 + 前后路由/DNS diff；对 `CREATE_ADAPTER` PREPARED-but-unknown，用 `WintunOpenAdapter(Name)` + 身份调停 |
| T10 | 崩溃恢复恢复确切先前状态 | 在激活中途强制杀后，disable 把路由/DNS 恢复到确切的启用前状态 | 相对基线的路由/DNS diff |
| T11 | 仅一个 Murge 适配器的唯一性 + RequestedGUID 冲突 | 持有保留 `Name`/`RequestedGUID` 的外来适配器以 `conflict` 阻塞激活，零变更 | 预创建带保留身份的适配器；断言 `conflict` |
| T12 | **通过 creator 句柄关闭移除适配器（无 `WintunDeleteAdapter`）** | disable 后产品适配器消失**因为 `WintunCloseAdapter(creatorHandle)` 被调用**（唯一移除路径）；**没有** `RebootRequired`/`delete-pending` 状态；**预存在/外来**适配器绝不移除，且在任何关闭前用 `Name`+`RequestedGUID`+LUID 验证 | 列举适配器；断言产品适配器仅在所有已验证且 mihomo 会话结束后移除；断言外来适配器存在 |
| T13 | 卸载在删除前先运行恢复 | 卸载运行 `--recover`、恢复路由/DNS、在损坏快照上中止 | `NetworkSnapshot` diff；退出码 / `Abort` 路径 |
| T14 | 独立于 GUI 的紧急 `--recover` | 杀应用，运行 `--recover`，断言已恢复 | 已恢复状态 |
| T15 | 非 Windows / 无 helper ⇒ unsupported | 非 Windows 或无已验证 helper 返回 `{supported:false, phase:'unsupported'}`，零变更 | 状态探针单元 + CI |
| T16 | **Resident-active 经受长 IPC 间隙** | `enable` 后，应用与 helper 之间长时间**无 IPC/消息**使适配器和路由/DNS **完好**（helper 是 resident-active 且不会 idle-exit） | 等待 > idle 超时；列举适配器 + 相对已应用的路由/DNS diff；断言仍存在（测试中时钟加速） |
| T17 | **disable 使用与 enable 相同的 helper 实例** | `disable` 由**处理 `enable` 的同一** helper 进程服务（持有 creator 句柄的那个）；证据记录 **enable helper PID == disable helper PID**，且 disable 到达 creator 句柄 | 在 enable + disable 记录 helper PID；断言相等；断言 creator 句柄在 disable 时关闭 |
| T18 | **TUN 启用时应用崩溃 ⇒ 紧急恢复** | 强杀绑定**应用**进程；helper（监视应用进程句柄）运行有界紧急恢复：先路由/DNS，然后关闭 creator 句柄，然后持久化结果并退出 | 强杀应用；断言路由/DNS 已恢复、适配器已移除、`RECONCILED`（或 `RESTORE_FAILED` + 日志保留）、helper 已退出 |
| T19 | **TUN 启用时 mihomo 崩溃 ⇒ 紧急恢复** | 强杀 **mihomo**进程；helper（监视 mihomo 进程句柄）运行有界紧急恢复 | 强杀 mihomo；断言相同恢复序列 + 结果 |
| T20 | **helper 崩溃 ⇒ 适配器自动移除 + 下次恢复** | 强杀 **helper**；Windows 关闭其 creator 句柄使适配器被移除；下次 `init()`/`--recover` 启动一个**新**恢复 helper，它**不声称**调用 `WintunCloseAdapter`，验证适配器已消失，并恢复残余路由/DNS | 强杀 helper；断言适配器消失 + 新恢复 helper 调停 `RECONCILED`；断言它**未**记录 `WintunCloseAdapter` |
| T21 | **新恢复 helper 无旧 creator 句柄** | 崩溃后启动的恢复 helper **没有**来自死亡 helper 的句柄；它**不得**尝试关闭 creator 句柄，而是从日志 + 当前 OS 适配器状态决定恢复 | 断言恢复路径分支到"适配器消失 / 冲突"，无 creator 句柄关闭 |
| T22 | **helper 崩溃不留下完整但孤儿的适配器** | helper 崩溃后，不留下带**活动数据平面但无拥有 helper** 的 Murge 适配器；如果观察到适配器仍存在，新 helper 标记 `conflict`、保留证据、且**不**删除它（D5） | 列举适配器；断言要么缺席，要么 `conflict` + 证据 + 不删除 |
| T23 | **外来/预存在适配器在恢复时绝不移除** | 共享保留身份的预存在/外来适配器绝不移除，即使恢复一个拥有的适配器时 | 预创建外来适配器；运行恢复；断言它保持 |

| T24 | **COM ACL 是纯允许列表（AccessCheck）** | 存储的 `LaunchPermission`/`AccessPermission`（+ 状态目录 DACL）`SECURITY_DESCRIPTOR` 给予**所有者 SID 允许**、**第二普通用户被拒绝**、**SYSTEM 允许**，且不授予**任何** `Everyone`/`Users`/`Authenticated Users` ACE（也**无 `DENY` ACE** — `ANONYMOUS LOGON`/`NETWORK` 被缺席而非 `DENY` 拒绝）。确切的 COM 掩码断言在下方描述符构建组（`T32`–`T40`） | 对 owner / second-user / SYSTEM 令牌的构建描述符做 `AccessCheck`；断言矩阵（owner=allow、second-user=deny、system=allow）；断言无 `Everyone`/`Users`/`AuthUsers` ACE 且无 `DENY` ACE |
| T25 | **启动时验证状态目录 owner/DACL/reparse** | 在 `init`/`--recover` 时 helper 验证存储目录 owner = SYSTEM、允许列表 DACL 和 reparse 状态；**错误 owner** 或**错误 ACL** ⇒ **零网络变更** + `restore-failed` | 在目录上预设错误 owner/ACL；启动恢复；断言无路由/DNS 变更 + `restore-failed` + 存储保留 |
| T26 | **存储路径上的 reparse point 被拒绝** | 植入存储路径（目录或记录文件）上的 **symlink / junction / mount point** 被检测（`FILE_FLAG_OPEN_REPARSE_POINT` + reparse-tag 查询）且操作**失败关闭** | 在 `tun-state\<ownerSid>` 或记录文件上创建 junction/symlink/mount；断言检测 + fail-closed + 无变更 |
| T27 | **WAL 句柄/文件 ID 重新验证（目录替换）** | 如果日志**目录**在追加之间被替换（用同名另一目录替换），已打开句柄的**文件 ID**不再匹配记录的那个 ⇒ 下次 `PREPARED`/`APPLIED`/`RECONCILED` 追加**失败关闭** | 记录文件 ID；替换目录；追加；断言不匹配 → fail-closed、无变更、无按字符串重新打开 |
| T28 | **日志截断 / 篡改 / schema+摘要异常** | 截断、篡改或 schema/摘要不匹配的日志（或 `state.manifest` 不匹配）被检测且**发生零网络修改**；恢复进入 `restore-failed` | 截断/篡改 `journal.json` / `state.manifest`；断言检测 + 无变更 + `restore-failed` |
| T29 | **状态目录 ACL 被较低信任进程修改** | 更改状态目录 DACL 以添加用户/Everyone ACE，或移除 owner ACE，从 Medium **不可行**（MIC write-up），且如果被观察到，helper **失败关闭** | 尝试从 Medium 改 ACL；断言被阻塞（MIC）；断言 helper 重新验证 ACL 并 fail-closed |
| T30 | **Medium-IL 所有者无法写/删/改 ACL 存储** | 同一用户的 **Medium** 令牌无法在 High 标记的存储中创建/修改/删除/ACL 文件，而**带启用、非 deny-only `BA` 的 High 受限 helper** 可以 | 尝试从 Medium 创建/写/删/SetSecurity；断言被拒；断言已验证的 High helper 令牌成功 |
| T31 | **卸载在安全恢复前保留存储** | 卸载保留 `%ProgramData%\<id>\tun-state\<ownerSid>\` 且**仅**在安全恢复完成后清理（无待处理记录 + 路由/DNS 回到基线） | 模拟待处理 `PREPARED`；运行卸载；断言存储保留 + 无清理；在干净恢复后断言清理 |
| T32 | **描述符构建：SDDL → `SECURITY_DESCRIPTOR`** | `ConvertStringSecurityDescriptorToSecurityDescriptor` 在 `LaunchPermission` SDDL、`AccessPermission` SDDL **和**状态目录 SDDL（`O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)S:(ML;OICI;NW;;;HI)`）上成功，产生有效描述符 | 对每个 SDDL 字符串调用 API；断言成功 + 非空描述符 + `GetSecurityDescriptorLength` 合理 |
| T33 | **描述符构建：返回形式** | `ConvertStringSecurityDescriptorToSecurityDescriptor` 已经返回**自相对**描述符，适合持久化字节 | 调用 `GetSecurityDescriptorControl`；断言 `SE_SELF_RELATIVE`。**不要**把这结果直接传给 `MakeSelfRelativeSD`（该 API 要求绝对输入）。可选转换测试必须先用 `MakeAbsoluteSD`，再 `MakeSelfRelativeSD`，并比较描述符语义而非要求相同字节布局 |
| T34 | **描述符构建：COM `REG_BINARY` 往返** | 把每个返回的自相对 **COM** 描述符写为 `LaunchPermission`/`AccessPermission` `REG_BINARY` 值然后读回，得到**字节一致**数据 | 只写两个 COM 注册表值；读回；断言字节相等和 `REG_BINARY` 类型。状态目录描述符不是注册表值且被排除 |
| T35 | **描述符构建：状态目录安全读回** | 通过目录安全 API 应用状态目录描述符并读回得到匹配的 owner/DACL/SACL 语义（owner SYSTEM、允许列表 DACL、带 `NO_WRITE_UP` 的 `High` 标签） | 用 `SECURITY_ATTRIBUTES` 创建或用 `SetNamedSecurityInfo`/`SetSecurityInfo` 应用；用 `GetNamedSecurityInfo`/`GetSecurityInfo` 读取；断言 owner SID + DACL ACE + SACL 标签 |
| T36 | **`AccessCheck` — `LaunchPermission`** | 构建的 Launch 描述符授予**owner SID = allow**、**第二普通用户 = deny**、**SYSTEM = allow**；无 `Everyone`/`Users`/`Authenticated Users` ACE 授予访问 | 用 owner / 第二普通用户 / SYSTEM 令牌做 `AccessCheck`；断言 allow/deny 矩阵 + 无其他 ACE 授予 |
| T37 | **`AccessCheck` — `AccessPermission`** | 构建的 Access 描述符授予**owner SID = allow**、**第二普通用户 = deny**、**SYSTEM = allow**，匹配显式 `SY` `0x3` ACE | 用 owner、第二用户和 SYSTEM 令牌做 `AccessCheck`；断言 owner allow、second-user deny、SYSTEM allow |
| T38 | **COM ACE 掩码相等** | `LaunchPermission` 中的每个 ACE 有掩码**严格 `0xB`**；`AccessPermission` 中的每个 ACE 有掩码**严格 `0x3`**；**无**通用 `GX`/`GA` ACE；且**每个** COM ACE 包含 `0x1`（`COM_RIGHTS_EXECUTE`）位 | 在构建描述符上列举 ACE；断言每个掩码 == `0xB` 或 `0x3` 且 `mask & 0x1 == 0x1` |
| T39 | **状态目录 High 强制标签 + `NO_WRITE_UP`** | 存储目录携带 **`High`** 强制完整性标签（`S:(ML;OICI;NW;;;HI)`，`HI` = `S-1-16-12288`），带 `NW`/`NO_WRITE_UP` 和 `OICI` 继承 | `GetSecurityInfo` SACL 读回；断言带 `S-1-16-12288` SID 和 `NO_WRITE_UP` 的 `SYSTEM_MANDATORY_LABEL_ACE` |
| T40 | **存储目录 Medium vs High + helper 令牌组状态** | 所有者 SID 的 **Medium** 令牌**无法写入 / 删除 / 改 ACL** `tun-state` 目录中的文件，而**带 `BA` 启用（非 deny-only）的 High 受限 helper 令牌**可以执行这些操作 | 用 `GetTokenInformation(TokenGroups)` 检查 helper 令牌并断言 `BA` SID 启用且非 `SE_GROUP_USE_FOR_DENY_ONLY`；尝试从 Medium 创建/写/删/SetSecurity（拒绝）和 High helper（允许）；缺失/deny-only `BA` 在任何网络变更前 fail-closed；交叉引用 T25/T29/T30 |
