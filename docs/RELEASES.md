# 自动化 Windows 发布构建

推送版本标签会创建一个草稿 GitHub Release，其中包含有意未签名的 Windows x64 与 arm64 NSIS 安装器、确定性的发布说明、发布证据以及 `SHA256SUMS.txt`。Windows 会显示“未知发布者”。

1. 将 `package.json` 更新到目标版本并提交。
2. 等待普通的 `main` CI 工作流通过。
3. 创建并推送匹配的标签，例如版本 `0.1.0` 对应 `v0.1.0`。
4. 打开 GitHub Releases，并下载/测试生成的草稿中的产物。
5. 完成 `RELEASE_CANDIDATE_CHECKLIST.md`，包括 N-1 升级矩阵。
6. 在明确的所有者批准下，手动发布草稿前，复核显式的未签名证据、校验和与最终截图。

该工作流会拒绝与 `v` 加 `package.json` 版本不完全相等的标签。重新运行草稿构建会替换其产物，但拒绝覆盖已发布的 Release。打包会下载并 SHA-256 校验固定的官方 mihomo 归档，以纳入两个安装器；它不修改系统代理、TUN、DNS、路由或防火墙设置。主托管的 CI 任务会安装 x64 产物，验证 ASAR 内容与特权服务的安装/移除生命周期，卸载它，并证明系统代理基线精确不变。Electron/preload/托盘/可见窗口探测仅在 `.github/workflows/windows-gui-smoke.yml` 中运行，且必须是在一个带有交互式桌面的、明确打标签的自托管 Windows 运行器上；在该工作流实际运行之前，这些探测不会被当作通过。

首个 RC 支持 x64。arm64 在真实 Windows arm64 硬件上安装生命周期证据存在之前，一直属于测试产物。TUN 以及 `RELEASE_SCOPE.md` 中列出的其他被排除表面必须保持隐藏。

## v0.3.0 里程碑（单 mihomo 内核）

本次发布迁移为社区式**单 mihomo 内核**：系统代理与 TUN 共用同一个 mihomo（TUN 开启时
以特权方式重启该内核并注入 `tun` 配置），数据面始终读取该单内核控制器；删除"安全直连
内核"概念。TUN 现在是已包含的发布表面（见更新后的 `RELEASE_SCOPE.md` 与
`src/shared/release-scope.ts`，其 Windows 运行时证据仍在补全）。系统代理 `enable()`
修复了端口跨会话重分配后陈旧自有 bundle 的误判冲突。
