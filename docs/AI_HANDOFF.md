# AI 实现移交文档

## 必读内容

编辑代码前，先阅读 `DEVELOPMENT_SAFETY.md`，然后打开 `ui-reference/murge-ui-preview.html`，并阅读 `ROADMAP.md`、`UI_SPEC.md`、`ARCHITECTURE.md`、`MIHOMO_API.md`、`BRANDING.md` 和 `ACCEPTANCE.md`。

以 `ROADMAP.md` 作为任务依据。只实现被分配的阶段或勾选项，并遵守其入口门禁、环境限制和退出标准。

## 开发机安全门禁

当前这台 Mac 可能是机主正在使用的远程连接。在这台机器上，不得启动真实的 mihomo，也不得修改系统代理、TUN、DNS、路由、接口、防火墙规则或任何其他网络状态。不得使用机主的真实订阅或凭据。只能使用测试夹具（fixtures）、伪进程、模拟（mocks）和单元测试。可以编写 Windows 网络代码，但不得在此处执行。

此限制优先于诸如“运行”“验证”“完成”或“端到端测试”之类的任务表述。只有机主针对某项确切网络测试做出的新的、明确的授权才能改变它。

## 不可协商的规则

1. 不得在未更新文档和测试的情况下重命名 IPC 通道或共享公共类型。
2. 不得向 Vue 暴露 `ipcRenderer`、控制器机密、Node API 或文件系统访问能力。
3. 在视觉评审批准响应式替代方案之前，不得替换固定的 934×672 参考尺寸。
4. 不得在品牌来源和品牌文档之外硬编码当前产品名称。
5. 在主进程验证操作系统/运行时状态之前，不得声称系统代理或 TUN 已生效。
6. 未进行校验和验证，不得下载或执行内核二进制文件。
7. 不得仅仅为了修改某个 GUI 支持的字段而重写整个 YAML 配置文件。
8. 保留用户无关的改动，并保持每个实现任务的范围克制。
9. 遵循 `DEVELOPMENT_SAFETY.md`；默认的开发与测试命令必须保持非破坏性。
10. 将 `ui-reference/murge-ui-preview.html` 视为规范性的视觉来源。未经机主明确批准，不得重新设计、过度装饰或替换你自己的布局。

## 推荐的任务顺序

### 任务 1 — 运行时校验与模式（schemas）

- 添加一个运行时模式校验库。
- 校验品牌配置、所有 IPC 输入和外部 API 响应。
- 为无效载荷添加单元测试。

当畸形（malformed）的 renderer 输入无法到达服务方法时即视为完成。

### 任务 2 — 内核监督器

- 在 `src/main/services/kernel-supervisor.ts` 中实现该契约。
- 在集成真实二进制文件前使用一个测试夹具进程。
- 添加生命周期竞态、启动失败、崩溃和优雅停止测试。

当 PID 变化、监听器就绪和 `/version` 成功被独立验证后即视为完成。

### 任务 3 — WebSocket 传输

- 添加一个可复用的主进程 socket 传输层。
- 实现 `/traffic`、`/connections` 和 `/logs` 订阅。
- 对 renderer 订阅进行引用计数，并限制事件速率。

当断开/重连不会重复采样或泄漏监听器时即视为完成。

### 任务 4 — Activity 页面集成

- 将夹具数据替换为基于类型化 IPC 的 store。
- 在加载、生效和失败状态下保持布局像素级稳定。
- 实现 `MIHOMO_API.md` 中描述的有界历史与聚合。
- 将 934×672 实现截图与 `ui-reference/murge-ui-preview.html` 中的 Activity 状态直接比较；不要重新解读其布局。

当截图几何在 934×672 下仍获认可，且实时数据每秒更新一次时即视为完成。

### 任务 5 — 策略与提供者

- 实现组/节点列表、选择、延迟测试和提供者刷新。
- 对路径分段进行编码，并安全地处理重复的显示名称。

当选择在随后的 API 读取中得到确认时即视为完成。

### 任务 6 — 配置

- 实现导入、订阅更新、校验和原子化激活。
- 保留不支持的 YAML 键。

当一次失败的校验使当前配置和内核保持不变时即视为完成。

### 任务 7 — Windows 系统代理

- 在一个接口之后实现，并为测试提供伪实现。（`src/main/system-proxy/{service,policy,backup-store,probe,factory,ordered-kernel-gateway}.ts` 以及 `adapters/{fake,disabled,windows-adapter,windows-helpers}.ts`；`WindowsSystemProxyAdapter` 拥有三个 HKCU Internet Settings 值，`FakeSystemProxyAdapter` 和 `DisabledSystemProxyAdapter` 分别覆盖开发和非 win32 场景。）
- 备份并恢复先前拥有的精确状态。（`FileSystemProxyBackupStore` 以原子方式写入变更前快照；`restore`/`restoreBeforeKernelUnavailable` 会回滚它们，并删除先前不存在的值。）
- 添加崩溃恢复。（`SystemProxyService.init()` 从已提交的备份中恢复一个孤立的 enable；有序内核网关在内核停止前恢复。）

当注册表/设置检查证明 enable 与 restore 行为时即视为完成。

仅在 win32 上完成，在其他平台 fail-closed：在非 win32 上（以及任何开发路径），适配器返回 `unsupported`，主进程暴露一个禁用状态，Overview 开关被禁用。真实的 enable/restore 路径由带门禁的 `tests/system-proxy-real.integration.test.ts`（`MURGE_RUN_REAL_SYSTEM_PROXY=1` + `win32`，否则跳过）覆盖，该测试写入三个 HKCU 值，证明宿主 `NetworkSnapshot` 仅在 HKCU Internet Settings 代理字段发生变化，并在 `finally` 块中恢复精确的原始值。单元/组件覆盖：`tests/system-proxy-{service,policy,backup-store,windows-helpers,handlers,static}.test.ts`。该特性与品牌无关（PowerShell `Add-Type` 使用通用的 `SystemProxy` 命名空间），并且从不绑定 socket——它只是注册代理，而不是提供服务。

### 任务 8 — TUN 辅助程序

- 编写代码前先写设计提案。
- 定义提权、安装、卸载和升级行为。
- 使其可独立审计。

只有在路由/DNS 检查证明流量确实被捕获后才算完成。

## 给实现代理的 PR 模板

包含：

- 完成的范围以及有意排除的内容。
- 变更的 IPC/API 契约。
- 测试命令与结果。
- 进程/网络变更的运行时证据。
- UI 变更的 934×672 截图。
- 新增的安全、提权或迁移考量。

## 停止条件

在以下情况前先询问机主：

- 更改机主批准的应用许可证；
- 发布 GitHub release；
- 更改 `appId` 或存储命名空间；
- 安装特权服务或驱动；
- 启用自动内核下载；
- 复制任何供应商拥有的图标或资源。
