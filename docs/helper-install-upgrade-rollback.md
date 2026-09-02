# Phase 9 — TUN 特权 helper：安装 / 升级 / 回滚 / 卸载

> 状态：**供设计评审的草稿。** 这是行为定义，不是代码。它不授权任何网络变更，是 Phase 9
> 路线图第二条（"定义安装、升级、回滚和卸载行为"）的交付物。它建立在
> `docs/helper-threat-model.md`（控制 **C1**…**C13**）之上，并效仿已经发布的 system-proxy
> 安装/卸载模式：`resources/nsis/uninstall-restore.nsh` 和 `electron-builder.config.mjs`。

---

## 0. 参考模型

- 应用文件安装在 `Program Files\<product>` 下（按架构的安装程序、NSIS `oneClick:false`、
  NSIS include 钩子 `uninstall-restore.nsh`）。
- 用户数据（profiles、自有备份、日志、内核产物）位于品牌无关（brand-independent）的
  **application-data** 命名空间中，并在卸载后保留（`deleteAppDataOnUninstall:false`）。
- 内核二进制**按架构**捆绑、校验和钉定、在打包时验证并在运行时解压前重新验证
  （`resources/bin/<arch>`、`mihomo-artifact.ts`）。
- helper、**按架构官方 `wintun.dll`**（绝不是裸驱动文件——见 `docs/helper-design.md` §3），以及
  TUN 恢复工具遵循相同规则，应用于 helper 必须位于 **High IL** 的地方（威胁模型 §1）。

---

## 1. helper 特性拥有的组件

| 组件 | 位置 | 信任 | 生命周期 |
|---|---|---|---|
| Helper 可执行文件 | 应用安装目录（Program Files） | High IL | 随应用安装/更新；仅在完整性检查后替换 |
| **按架构官方 `wintun.dll`** | 应用安装目录 `resources/bin/<arch>`（绝不是裸驱动文件） | Medium/High | 按架构捆绑、摘要钉定；带签名的 Wintun 内核驱动由 DLL 在 `WintunCreateAdapter` 内于**首次启用时按需安装/加载**（**没有单独的驱动加载步骤**），我们**不**自行分发/删除 `wintun.sys` |
| 可选 helper 服务（替代方案，D2） | Windows 服务（SERVICE_WIN32_OWN_PROCESS） | High IL / service SID | 仅当 owner 撤销 D2（独立 helper）时；随应用注册/更新；在安全拆除后的卸载时移除 |
| BaselineSnapshot + WrittenState + mutation journal | `%ProgramData%\<brand-independent-id>\tun-state\<ownerSid>\`（helper 拥有；owner = SYSTEM；**High** 完整性 → **Medium-不可写**） | High | 在首次变更前写入；卸载后保留以支持回滚 |
| TUN 恢复工具（`--recover`） | 应用安装目录 | High IL | 由卸载钩子和紧急路径使用 |
| 所有权/版本清单标记 | `%ProgramData%\<brand-independent-id>\tun-state\<ownerSid>\`（`state.manifest`——helper 拥有；owner = SYSTEM；High 完整性 → Medium-不可写） | High | 记录哪个 helper+dll 版本为升级/回滚安装/加载了什么 |

---

## 2. 安装（全新）

1. **放置与 ACL。** 在 `Program Files`（或已批准等价物）下安装 helper、按架构的 `wintun.dll`
   和恢复工具。目录 DACL 阻止 Medium-IL 写入（C2）。绝不在 `%TEMP%` 或攻击者可写的每用户路径
   暂存特权二进制或 DLL；绝不让 DLL 从较低信任进程能影响的搜索路径加载（C2）。安装程序还保留
   **可信状态存储**的基 `%ProgramData%\<brand-independent-id>\tun-state\`，带**仅 Admin 的基础
   DACL**（不继承到每 owner 子树）；**每 owner** 的 `tun-state\<ownerSid>\` 子树由**提升的 helper**
   在首次启用时创建，带纯允许列表 DACL + **High** 强制完整性标签（设计文档 §8.0）。
1b. **COM 注册 ACL（纯允许列表，精确 COM 权限掩码）。** 把 `LaunchPermission` / `AccessPermission`
   注册为**纯允许列表** DACL，带**显式 COM 权限掩码**，来自设计文档 §5.1——`Launch`
   `D:P(A;;0xB;;;SY)(A;;0xB;;;BA)(A;;0xB;;;<ownerSid>)` 和 `Access`
   `D:P(A;;0x3;;;SY)(A;;0x3;;;<ownerSid>)`（`0xB` = `EXECUTE 0x1 | EXECUTE_LOCAL 0x2 |
   ACTIVATE_LOCAL 0x8`；`0x3` = `EXECUTE 0x1 | EXECUTE_LOCAL 0x2`）——向**所有者用户 SID** + `SYSTEM`
   （外加在 `LaunchPermission` 中的 `Administrators` 用于安装/修复；**绝不**在 `AccessPermission`
   中）授予本地启动/激活/访问。**无** `DENY Everyone`/`DENY Users`，**无** `Everyone`/`Users`/
   `Authenticated Users`，并且**根本没有 `DENY`**（一个完整的允许列表靠缺席来拒绝）。安装程序写入
   二进制 `SECURITY_DESCRIPTOR`（上述 SDDL），应用用**描述符构建测试**（设计文档 §13
   `T32`–`T40`：`ConvertStringSecurityDescriptor…` 返回 `SE_SELF_RELATIVE`；仅 COM 的
   `REG_BINARY` 往返；状态目录 `SetNamedSecurityInfo`/`GetSecurityInfo`；`AccessCheck`）重新验证它。
2. **首次使用前的完整性。** 在首次激活时（不是安装时）验证 helper 的 SHA-256 针对钉定的发布清单
   及其 Authenticode 发布者，以及官方 `wintun.dll` 按架构的 SHA-256（C1）。Wintun 内核驱动由 DLL
   在 `WintunCreateAdapter` 内安装/加载，且必须是 Windows 会加载的带签名驱动；我们不自签驱动或
   驱动证书。
3. **Wintun 适配器/驱动创建是延迟且显式的。** 带签名的 Wintun 驱动**由官方 `wintun.dll` 在
   `WintunCreateAdapter` 内按需安装/加载**，而（提升的）helper 只在用户首次**启用** TUN（一个显式
   操作）时调用它——而不是在应用安装时。单独调用 `LoadLibraryEx(wintun.dll)` 本身**不**安装或加载
   驱动，因此没有单独的"加载驱动"步骤。我们绝不分发/安装裸 `wintun.sys`；预先存在/共享的 Wintun
   驱动绝不覆盖或移除。
4. **启用顺序（单一 OS 配置所有者）。** 在启用时、任何 OS 变更之前，helper 首先**创建/验证可信
   状态存储** `%ProgramData%\<id>\tun-state\<ownerSid>\`（owner = SYSTEM、纯允许列表 DACL、
   **High** 强制标签、**无 reparse 点**；设计文档 §8.0）并在其中写入和验证 **BaselineSnapshot**；
   存储/ACL/reparse/完整性异常 ⇒ **零网络变更** + `restore-failed`。然后它写入（并 **fsync**）
   **`CREATE_ADAPTER/PREPARED`**，使恢复知道一次创建正在进行；**然后**它调用
   `WintunCreateAdapter(Name, TunnelType, RequestedGUID)`（按需驱动 + 创建适配器），并且**只有在那之后**
   才写入带 LUID（钉定——重新派生以断言恰好一个 Murge 适配器）的 **`CREATE_ADAPTER/APPLIED`**；
   **然后**它应用路由/DNS/接口（它们总是在适配器存在**之后**写入）。mihomo 的运行时配置有
   `auto-route:false`/`auto-detect-interface:false`/`dns-hijack:false`，因此 mihomo 不自行添加任何
   路由/DNS（唯一修改者 = helper）。任何失败都通过按逆 journal 顺序、把每个 `PREPARED-but-unknown`
   记录与当前 OS 状态调和来恢复。**禁用是镜像的操作，只用唯一的移除路径：** 拆除 mihomo 的会话 +
   关闭其打开的句柄，逐项恢复路由/DNS，然后验证所有权（`Name`/`RequestedGUID`/LUID）并写入
   `CLOSE_CREATOR_HANDLE/PREPARED` → `WintunCloseAdapter(creatorHandle)`（移除适配器）→
   `CLOSE_CREATOR_HANDLE/APPLIED`/`RECONCILED`。**没有 `WintunDeleteAdapter`**、**没有
   `RebootRequired`/`delete-pending`**，并且**没有**随最后会话/句柄关闭而自动删除——适配器通过关闭
   创建者句柄来移除。禁用由**同一个**创建了该适配器的按启用常驻 helper 服务（设计文档
   §3.3–§3.4/§5.5）；helper**在整个启用窗口内持有创建者句柄**，因此关闭顺序不依赖于 G1 探针（G1
   只确认 mihomo 复用适配器）。
5. **服务注册**（仅当 helper 是服务，即 D2 被撤销）：以限制性 DACL 和最少特权集创建（C5）；以**禁用/
   手动**启动，而非自动启动，除非紧急路径需要它（C9——owner 决策）。在当前 D2（独立 helper）下，
   此步被跳过。
6. **安装时不进行网络变更。** 安装绝不能触碰路由、DNS、接口或防火墙。它只暂存文件，并（若需要）
   预注册一个禁用的服务。
7. **首次运行把关。** renderer 把 TUN 显示为 **configured**（或在非 Windows 上显示为
   **unsupported**）——绝不是 **active**——直到用户显式启用且 helper 报告成功。

---

## 3. 升级

升级绝不能把机器留在半更新状态的 TUN 中。

1. **保留用户数据。** Profiles 与日志（app-data）外加**恢复状态**——位于
   `%ProgramData%\<brand-independent-id>\tun-state\<ownerSid>\` 的
   `BaselineSnapshot`/`WrittenState`/mutation journal——在升级后保留。helper 二进制/驱动版本改变，
   用户的数据命名空间不变。
2. **替换前调和进行中的 TUN。** 如果升级时 TUN 处于激活状态，新构建必须在其替换 helper 文件之前
   先运行**拆除/恢复**路径（读取旧版本记录的 `BaselineSnapshot` + `WrittenState` + mutation
   journal）。快照/journal 格式是**有版本**的，因此新 helper 可以读取并恢复由旧 helper 写入的状态
   （向前兼容的恢复，C4/C9/C10）。
3. **仅在验证后替换。** 新 helper 和 `wintun.dll` 只在 SHA-256 + Authenticode 检查通过后放置（C1）；
   失败的检查会中止升级的 helper 交换，并让先前版本保持完整可用。
4. **服务/`wintun.dll` 更新。** 如果服务存在（D2 被撤销），停止它、替换二进制、重启；不要短暂地
   同时保留两个版本。否则只是替换 helper 旁按架构的 `wintun.dll`（带签名的内核驱动不是由我们分发或
   替换的）。
5. **交换本身不进行变更。** 升级替换文件/注册服务；它只通过与正常使用相同的激活路径执行路由/DNS
   变更。
6. **回滚安全。** 失败的升级会留下先前的 helper+`wintun.dll` 和新鲜写入的快照，使得**回滚**（§4）
   仍能干净地恢复先前状态。

---

## 4. 回滚（到前一版本）

1. **拆除当前状态。** 在安装较旧的 helper/`wintun.dll` 之前，运行恢复/拆除路径，使当前 TUN 被移除，
   且路由/DNS 匹配启用前的**基线**（设计文档 §8；C8/C9）。如果当前 helper 无法恢复（崩溃、损坏），
   **紧急路径**（§6）必须仍能进行，并且回滚必须中止，而不是堆叠两个不一致的状态。
2. **版本兼容的记录。** 把 helper+`wintun.dll` 回退到先前版本，同时保留
   `BaselineSnapshot`/`WrittenState`/journal。因为恢复是向前兼容且**按项仅自有**的，旧 helper 可以
   恢复同一基线。
3. **冲突 ⇒ 不覆盖，按项。** 如果当前路由/DNS 不再匹配 helper 写入的值（外部编辑），记录一个**按项
   冲突**（`conflictDetail`）并让该项目不动，同时恢复无关的自有项目（C8）——绝非全有或全无。把结构化
   冲突呈现出来，并要求对这些冲突项走紧急/owner 路径。
4. **安装时的二进制完整性。** 降级的 helper 和 `wintun.dll` 在被信任运行前经过验证（C1）。

---

## 5. 卸载

效仿 `resources/nsis/uninstall-restore.nsh`，为 TUN 扩展。

1. **卸载前恢复钩子。** 一个 `customUnInstall`/等价步骤在卸载程序删除已安装文件**之前**运行，并启动
   无界面（headless）的 **`--recover`**（别名 `--restore-tun`）路径，它：
   - 读取 `BaselineSnapshot`/`WrittenState`/journal 并终止 TUN 会话（mihomo 拥有数据平面设备；钩子
     停止那进程/会话），
   - **逐项且仅当**当前状态仍匹配 helper 写入的值时恢复路由/DNS/接口指标（C8），
   - 在已恢复 / 已禁用 / 安全冲突（外部编辑保持不变、其他自有项目已恢复）时以 0 退出，使卸载程序
     继续，
   - 在**非零**（损坏/不可读的快照）时**中止卸载**，使应用及其恢复工具留在磁盘上，用户可以重试或
     使用紧急路径——保证 OS 绝不留有悬空的 TUN/路由。
2. **仅在安全拆除后移除。** 在 D2（独立）下**没有**要删除的 **helper 服务**；如果 D2 之后被撤销为服务，
   **只在**卸载前恢复完成之后删除它。我们**不**分发一个要删除的驱动文件；带签名的 Wintun 内核驱动
   通过 `wintun.dll` 加载，预先存在/共享的 Wintun 驱动保持原位。helper **只**移除产品拥有的适配器
   （经由 `WintunCloseAdapter(creatorHandle)`，在其会话结束后）并保持任何预先存在的适配器不动（C9）。
   **没有 `WintunDeleteAdapter`**。
3. **保留用户数据。** `deleteAppDataOnUninstall:false` 保留 profiles 和
   `BaselineSnapshot`/`WrittenState`/journal，使中止或部分的卸载可恢复。如果 owner 之后想要一个
   "移除所有数据"选项，它是一个单独、显式的选择，并且必须仍然先运行 TUN 恢复。**可信状态存储**
   （`tun-state\<ownerSid>\`，设计文档 §8.0）在升级和卸载时**保留**，并且**只**在一次安全恢复完成后
   移除（无待处理的 `PREPARED`/`APPLIED` 记录且路由/DNS 回到基线）；过早丢失它可能导致一个仍被创建的
   适配器或一个路由/DNS 变更变成孤儿（见"卸载保留存储直到安全恢复"测试）。
4. **Fail-closed 中止。** 卸载钩子把非零的恢复退出当作停止的理由（与代理钩子行为相同），因此应用
   消失后一个损坏的 TUN 绝不会在 OS 级作为悬空的路由/DNS 存留下来。

---

## 6. 紧急禁用 / 逃生舱（独立于 GUI）

- 一个捆绑、已文档化的 **`--recover`** 模式（和/或服务命令），owner 可以从控制台运行，以恢复基线
  快照**而无需** renderer 或 mihomo 进程（C9）。它绝不能依赖它正要修复的网络。
- helper 在磁盘上记录一个 **write-ahead**（预写）变更 **journal**（每个操作是 `PREPARED` → 变更 →
  `APPLIED`；`CREATE_ADAPTER/PREPARED`/`CLOSE_CREATOR_HANDLE/PREPARED` 在触碰 OS 之前 fsync），因此
  即使激活期间崩溃，恢复也能通过枚举当前 OS 状态而非假设来调和（C10）。
- 恢复是幂等的，可安全重复运行；它绝不重新应用一个已经回退的变更。

---

## 7. 设计评审的决策/授权标记

这些是安装/升级/回滚行为所依赖的决策（来自威胁模型 §10）。**D1–D6 已解决**并生效；**G1 与证书
提供商**在设计评审签字前保持开放：

| # | 决策 | 状态 | 对本规范的影响 |
|---|---|---|---|
| D1 | 设备模型：带签名 wintun 对比 纯用户态 | **已解决：带签名 wintun（官方按架构 `wintun.dll`）** | 通过官方 `wintun.dll` 加载带签名的 Wintun 驱动；绝不分发裸驱动文件或自签驱动证书；驱动在**首次启用时于 `WintunCreateAdapter` 内安装/加载** |
| D2 | Helper 形态：独立提升进程 对比 Windows 服务 | **已解决：独立提升 helper** | 无服务注册/升级/移除步骤；§3.4/§5.2 删去服务路径（但保留为已文档化的替代方案） |
| D3 | 适配器/驱动创建时机：应用安装时 对比 延迟到首次启用 | **已解决：首次启用时** | §2.3 在安装时暂存 `wintun.dll`；§2.4 在首次启用时调用适配器创建（按需驱动）；**没有单独的驱动加载步骤** |
| D6 | OS 网络配置所有者 | **已解决：helper 是唯一修改者（选项 A）** | mihomo 运行时配置有 `auto-route:false`/`auto-detect-interface:false`/`dns-hijack:false`；helper 应用类型化的 `DesiredNetworkState`；路由/DNS 只在适配器存在后写入 |
| D4 | helper 是否允许为紧急路径开机启动 | **已解决：无开机自启** | 无服务/计划任务/`Run` 条目；只为显式启用或显式手动 `--recover` 启动；被动启动/状态绝不提升 |
| D5 | 是否移除预先存在/共享的 Wintun 驱动或适配器状态 | **已解决：绝不** | 绝不调用 `WintunDeleteDriver`；绝不删除预先存在/外来的适配器；卸载两者都不移除；只关闭当前会话的持续持有、可证明拥有的创建者句柄 |
| G1 | mihomo 能否复用 helper 创建的适配器 | **开放（未证明的假设）** | 阻断关卡：**G1 生命周期探针**（创建 + 持有创建者句柄 → mihomo `WintunOpenAdapter` + `WintunStartSession` → helper `WintunCloseAdapter(creatorHandle)`/退出 → 观察会话 + 适配器是否持续；设计文档 §3.3）必须在任何 Phase 9 helper 实现之前，在一个可打快照、可带外恢复的 Windows VM 上、于受关卡的 CI 中通过。结果有 **Observed A/B**；**两者都不改变固定基线**（helper 是一个按启用的常驻服务器，在整个启用窗口内持有创建者句柄，§3.4/§5.5）。 |

> 因为 D2 解决为**独立 helper（不是服务）**，§5.2 的"删除 helper 服务"步骤只在之后某个 owner 决策
> 撤销 D2 时才适用；驱动移除规则（仅自有、不占用、绝无预先存在-共享驱动）无论如何都保持。

提交在库中的 `.github/workflows/g1-probe.yml` 刻意是**仅验证**的。它要求手动派发、精确的 owner 确认、
authorization/asset/snapshot/带外恢复标识符、经受保护的 `phase9-tun-lab` 环境的批准，以及一个标记为
`murge-tun-lab` 的自托管 Windows runner。当前脚本记录 `probeExecuted:false` 并拒绝非验证调用；它不能
创建适配器或修改网络。

---

## 8. 测试 / 证据映射（仅一次性 Windows）

| 行为 | 测试 | 证据 |
|---|---|---|
| 安装暂存文件，无网络变更 | 安装前后快照，断言不变 | `NetworkSnapshot` diff |
| 首次启用需要显式操作 | 启动时断言无 TUN 激活 | status phase = configured |
| 适配器/驱动在首次启用时创建（无单独加载） | 在首次启用时 helper 调用 `WintunCreateAdapter(Name, TunnelType, RequestedGUID)`；断言驱动只在那时出现，且没有"加载驱动"操作 | 启用前后是否存在驱动/适配器；journal 无 `load_driver` 操作 |
| **G1 生命周期探针（一次性，硬关卡）** | (a) helper `WintunCreateAdapter` 持有创建者句柄；(b) mihomo `WintunOpenAdapter` + `WintunStartSession`；(c) helper `WintunCloseAdapter(creatorHandle)`/退出；(d) 观察会话 + 适配器是否持续。之后在一个可打快照、带外恢复的 VM 上 | a/b/c/d 处适配器 + 会话存在性；记录**哪个观察结果**（A = 创建者关闭时适配器消失，B = mihomo 持有句柄时它存活）并断言**固定基线**（两者都不改变 helper-持有-创建者句柄的模型）；机器已恢复 |
| 适配器移交 + 单一适配器（G1） | helper 创建适配器后，mihomo 复用同一 **RequestedGUID/LUID**，且恰好有**一个** Murge 适配器 | 前后按 Name/RequestedGUID/LUID 枚举；断言 count==1 且 LUID 相同 |
| 路由/DNS 总在适配器创建后写入 | 断言路由/DNS journal 操作绝不先于 `createAdapter`；适配器前的失败留下零路由/DNS | journal seq |
| mihomo 不产生路由/DNS 变更 | 在 `auto-route:false`/`auto-detect-interface:false`/`dns-hijack:false` 下，mihomo 在 helper 之外不添加/移除任何路由/DNS | mihomo 启动前后的路由/DNS 快照，diff == 仅 helper 写入的集合 |
| 升级保留数据 + 调和 | 启用 TUN、升级，断言先前状态被恢复/一致 | journal + snapshot 摘要 |
| 回滚恢复前一版本 | 启用、回滚，断言基线 | 路由/DNS diff vs 基线 |
| 卸载恢复路由/DNS 并移除产品适配器 | 卸载，断言路由/DNS == 基线；helper 在其会话结束后只通过 `WintunCloseAdapter(creatorHandle)` 移除**仅**产品拥有的适配器；绝不涉及分发/`pre-existing` 驱动或适配器 | 前后快照；适配器枚举 |
| 损坏快照时卸载中止 | 损坏快照、卸载，断言中止 + 二进制保留 | exit code、`Abort` 路径 |
| 紧急 `--recover` 独立于 GUI | 杀死应用、运行 `--recover`，断言恢复 | 恢复的状态 |
| 激活中途崩溃的调和（WAL） | 在**每个持久 journal 记录**处强制杀死 helper（预快照、`CREATE_ADAPTER/PREPARED`、创建中、`APPLIED`、每个路由/DNS `PREPARED`→`APPLIED`、`CLOSE_CREATOR_HANDLE/*`），断言 `init()`/`--recover` 通过由 `WintunOpenAdapter(Name)` 打开并按当前 OS 状态身份验证，调和每个 PREPARED-but-unknown 记录 | journal 重放 + 路由/DNS diff + 适配器枚举 |
| **常驻 helper 跨过长 IPC 间隙保持** | `enable` 后，一段长无 IPC 时期让适配器 + 路由/DNS 保持完整（无空闲退出） | 等待 > 空闲超时；枚举适配器；路由/DNS diff == 已应用 |
| **禁用使用同一 helper 实例** | `disable` 由启用的同一 helper PID 服务；证据记录 enable PID == disable PID；创建者句柄在禁用时关闭 | 在启用 + 禁用时记录 helper PID；断言相等；所有权检查后移除适配器 |
| **启用时应用崩溃 ⇒ 紧急恢复** | 强制杀死应用；helper（监控应用进程句柄）恢复路由/DNS、关闭创建者句柄、持久化结果、退出 | 路由/DNS 已恢复；适配器已移除；`RECONCILED`（或 `RESTORE_FAILED` + journal 保留）；helper 已退出 |
| **启用时 mihomo 崩溃 ⇒ 紧急恢复** | 强制杀死 mihomo；helper（监控 mihomo 进程句柄）运行同样的有界紧急恢复 | 相同的恢复序列 + 结果 |
| **helper 崩溃 ⇒ 适配器自动移除 + 新的恢复** | 强制杀死 helper；Windows 关闭其创建者句柄，因此适配器被移除；下一次 `init()`/`--recover` 启动一个新的恢复 helper，它**不**声称调用 `WintunCloseAdapter`，验证适配器已消失，并恢复残余的路由/DNS | 适配器已移除；新恢复 helper 调和 `RECONCILED`；未记录 `WintunCloseAdapter` |
| **新恢复 helper 没有旧创建者句柄** | 崩溃后启动的恢复 helper 没有已死 helper 的句柄，必不能关闭创建者句柄；它从 journal + 当前 OS 适配器状态决定恢复 | 恢复分支到"适配器已移除 / 冲突"而不做创建者句柄关闭 |
| **helper 崩溃不留孤儿适配器 / 不删除外来** | helper 崩溃后，如果观察到适配器仍存在，新 helper 标记 `conflict`、保留证据，并且**不**删除它（D5） | 适配器不存在或 `conflict` + 证据 + 无删除 |

| **COM ACL 是纯允许列表（AccessCheck）** | 存储的 `LaunchPermission`/`AccessPermission`（+ 状态目录 DACL）描述符 → **owner SID 允许**、**第二个普通用户被拒绝**、**SYSTEM 允许**；**无** `Everyone`/`Users`/`Authenticated Users` ACE，**无 `DENY` ACE**（`ANONYMOUS LOGON`/`NETWORK` 靠缺席而非 `DENY` 拒绝） | 对 owner / 第二用户 / SYSTEM 令牌的 `AccessCheck`；断言矩阵；枚举 ACE（无 `Everyone`/`Users`/`AuthUsers`、无 `DENY`） |
| **描述符构建：SDDL → 描述符** | `ConvertStringSecurityDescriptorToSecurityDescriptor` 对 `LaunchPermission`、`AccessPermission` 和状态目录 SDDL 成功，并返回一个有效的**self-relative** 描述符 | 调用该 API；断言成功/非空，并经 `GetSecurityDescriptorControl` 验证 `SE_SELF_RELATIVE`；不要在此结果上直接调用 `MakeSelfRelativeSD` |
| **描述符构建：COM `REG_BINARY` 往返** | 把返回的 `LaunchPermission` 和 `AccessPermission` 描述符作为 `REG_BINARY` 写入再读回，得到**字节完全相同**的数据 | 只写/读那两个 COM 注册表值；断言字节相等 + `REG_BINARY` 类型 |
| **描述符构建：状态目录安全读取** | 用目录安全 API 应用状态目录描述符并读回，得到 owner SYSTEM、允许列表 DACL 以及 `High` `NO_WRITE_UP` 标签 | 使用 `SECURITY_ATTRIBUTES` 或 `SetNamedSecurityInfo`/`SetSecurityInfo`，然后 `GetNamedSecurityInfo`/`GetSecurityInfo`；断言 owner/DACL/SACL 语义 |
| **描述符构建：COM 掩码相等 + `0x1`** | 每个 `LaunchPermission` ACE 掩码**严格为 `0xB`**，每个 `AccessPermission` ACE 掩码**严格为 `0x3`**，**无**通用 `GX`/`GA`，并且每个 COM ACE 含 `0x1` | 枚举 ACE；断言每个掩码 == `0xB`/`0x3` 且 `mask & 0x1 == 0x1` |
| **状态目录 High 标签 + `NO_WRITE_UP`** | 存储目录携带 `High` 强制标签（`S-1-16-12288`）、`NO_WRITE_UP` 和 `OICI` 继承 | `GetSecurityInfo` SACL；断言 `SYSTEM_MANDATORY_LABEL_ACE` 为 `S-1-16-12288` + `NO_WRITE_UP` |
| **状态存储在启动时验证（owner/DACL/reparse）** | 在 `init`/`--recover` 时 helper 验证存储目录 owner = SYSTEM、允许列表 DACL 与 reparse 状态；一个错误 owner/ACL 或被植入的 symlink/junction/mount point ⇒ **零网络变更** + `restore-failed` | 预设错误 owner/ACL / 创建 junction；断言 fail-closed + 存储保留 + 无路由/DNS 变更 |
| **WAL 句柄 file-ID 重新验证（目录交换）** | 在追加之间交换 journal **目录**会使打开句柄的 file ID 与记录的不匹配，因此下一次 `PREPARED`/`APPLIED`/`RECONCILED` 追加**fail closed**（无字符串路径重开） | 记录 file ID；交换目录；追加；断言不匹配 → fail-closed |
| **journal 截断/篡改/schema+摘要异常** | 被截断、篡改或 schema/摘要不匹配的 journal/manifest 被检测到，并且发生**零网络修改**；恢复进入 `restore-failed` | 截断/篡改 `journal.json`/`state.manifest`；断言检测 + 无变更 + `restore-failed` |
| **Medium-IL owner 无法写入/删除/更改 ACL 存储** | **同一用户的 Medium** 令牌无法创建/修改/删除/ACL 该 High 标签存储，而 **High 受限 helper 令牌保留 `BA` 为启用（非 deny-only）** 且能够 | 检查 helper `TokenGroups`；断言启用的非 deny-only `BA`；从 Medium（deny）和 High helper（allow）尝试操作；缺失/deny-only `BA` 在网络变更前 fail closed |
| **卸载保留存储直到安全恢复** | 卸载保留 `%ProgramData%\<id>\tun-state\<ownerSid>\`，并**只**在一次安全恢复完成后清理它（无待处理记录 + 路由/DNS 回到基线） | 模拟待处理 `PREPARED`；运行卸载；断言存储保留 + 无清理；干净恢复后断言清理 |


上面所有这些只在受关卡的 `windows-latest` 作业中运行（除非 `MURGE_RUN_REAL_TUN=1` **且**为 `win32`，
否则跳过），绝不在默认 `npm test` 中运行。**ACL/状态存储结构测试**（**描述符构建**组——
`ConvertStringSecurityDescriptorToSecurityDescriptor` 返回形式验证、仅 COM 的 `REG_BINARY` 往返、
状态目录安全 API 读取、`AccessCheck` 矩阵、COM 掩码相等 `0xB`/`0x3` + `0x1`、状态目录 `High`
`NO_WRITE_UP` 标签——以及 COM `AccessCheck`、存储 owner/DACL/reparse 验证、WAL 句柄 file-ID 重新验证、
journal schema/摘要异常、Medium-vs-High MIC 阻塞、卸载保留存储）是**仅 Windows 的单元测试**（COM +
`SecurityDescriptor` + reparse/`FileIdInfo` + 令牌 IL 是 Windows 概念），但**不**需要真实的 TUN
适配器/网络变更，因此它们可以在一个较轻的 Windows CI 作业中运行（仍为 `win32`，不是默认
`npm test`）。
