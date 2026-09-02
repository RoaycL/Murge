# 第 1–8 阶段验收标准

## 当前里程碑

- [x] 默认开发命令不启动真实内核，也不修改系统网络。
- [x] macOS 上的系统代理与 TUN 实现缺失或被明确阻止。
- [x] `npm ci` 在 CI 中完成。
- [x] `npm run typecheck` 通过。
- [x] `npm run build` 通过。
- [x] `npm run brand:check` 通过。
- [x] 开发窗口以不小于 934×672 打开。
- [x] 默认路由是 Activity。
- [ ] 所有 Activity 和次级页面通过最终的原始像素视觉评审；剩余偏差记录在 `UI_DEBT.md` 中。
- [x] 一张 934×672 的 Activity 截图已与 `ui-reference/murge-ui-preview.html` 直接比较，且偏差已记录。
- [x] Overview 绝不将未实现的系统代理、TUN 或 LAN 控件报告为生效。
- [x] 导航页面可渲染，且第 4–5 阶段页面使用类型化的 live/mock 网关。
- [x] renderer 无 Node 访问能力。
- [x] 打包的 Windows 内核启动是显式的、经过认证的、仅回环且安全直接的。
- [x] API 与移交文档标识了引用来源和不确定性。
- [x] 机主选择的 GPL-3.0-only 应用许可证存在，且 `npm run license:check` 通过。
- [x] RC 路由/导航 allowlist 隐藏了没有完整服务契约的 TUN、捕获、HTTPS 解密、改写（rewrite）和占位页面。
- [x] 被排除的占位页面向源缺失，且受支持的 RC 控件在引用尺寸下具有可访问的名称/状态。
- [x] 已安装的工件对 Murge 和确切的捆绑 mihomo 版本保留源码获取说明。

## 第 8 阶段 — Windows 系统代理

- [x] 该特性与品牌无关（PowerShell `Add-Type` 使用通用的 `SystemProxy` 命名空间；`src/` 下的源码中无产品名）。
- [x] 非 win32（以及开发路径）fail-closed：适配器返回 `unsupported`，主进程暴露禁用状态，Overview 开关被禁用。
- [x] 主进程是唯一事实来源；UI 绝不乐观地翻转。
- [x] 先前的 HKCU 代理状态在任何写入前以原子方式备份，随后精确恢复。
- [x] 外部修改 / 冲突代理以结构化细节暴露 `SYSTEM_PROXY_STATE_CONFLICT`，且不执行任何变更。
- [x] 崩溃/孤儿恢复：`init()` 从已提交的备份恢复过期的已拥有 enable；有序内核网关在内核停止前恢复；`before-quit` 恢复。
- [x] `npm run license:check`、`npm run typecheck`、`npm test`、`npm run build` 和 `npm run brand:check` 全部本地通过。
- [x] 带门禁的真实测试 `tests/system-proxy-real.integration.test.ts`（除非 `MURGE_RUN_REAL_SYSTEM_PROXY=1` + `win32` 否则跳过）写入三个 HKCU 值，证明宿主 `NetworkSnapshot` 仅在 HKCU Internet Settings 代理字段发生变化，并在 `finally` 块中恢复精确的原始值。
- [x] 一个专门的 `system-proxy-real-windows` CI 任务已添加到 `.github/workflows/ci.yml`，并以 `MURGE_RUN_REAL_SYSTEM_PROXY=1` 加门禁，仅在 `windows-latest` 上运行。

第 8 阶段范围外（留待后续阶段跟踪）：提供实际代理并产生有效的请求路由证据；一个独立于 GUI 的恢复 CLI（当前恢复由主进程接线）。

## 未来运行时证据

命令返回成功是不够的。运行时任务必须证明相关层次：

- 内核：可执行路径、版本、PID、控制器监听器和 `/version`。
- 系统代理：操作系统设置的前后对照（由带门禁的真实测试证明）和有效的请求路由（暂缓——该特性注册代理，而不是提供服务）。
- TUN：服务/驱动状态、路由表、DNS 路径以及一个被捕获的非代理感知请求。
- 配置切换：校验、活动路径/配置以及保留的未支持字段。
- 更新：签名/校验和、版本变化、重启和回滚行为。
