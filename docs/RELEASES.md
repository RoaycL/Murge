# 自动化 Windows 发布构建

推送版本标签会**直接发布正式版** GitHub Release，其中包含有意未签名的 Windows x64 与 arm64 NSIS 安装器、确定性的发布说明、发布证据以及 `SHA256SUMS.txt`。Windows 会显示"未知发布者"。

## 流程

1. 将 `package.json` 与 `package-lock.json` 更新到目标版本并提交（`chore(release): prepare vX.Y.Z`）。
2. 确认 `main` 分支的 CI 工作流通过。
3. 创建并推送匹配的带注释标签，例如版本 `0.5.9` 对应 `v0.5.9`。
4. 标签推送即自动构建并**直接发布**正式版 Release，用户可立即下载，应用内更新也会立刻发现它。

## 约束

- 工作流会拒绝与 `v` 加 `package.json` 版本不完全相等的标签。
- 对已发布的 Release，重复运行同一标签的构建会**拒绝覆盖**（保护正式版不被悄悄替换）。
- 打包会下载并 SHA-256 校验固定的官方 mihomo 归档，纳入两个安装器；不修改系统代理、TUN、DNS、路由或防火墙设置。
- 主 CI 任务会安装 x64 产物，验证 ASAR 内容与特权服务的安装/移除生命周期，卸载它，并证明系统代理基线精确不变。
- Electron/preload/托盘/可见窗口探测仅在 `windows-gui-smoke.yml` 中运行，且必须在一个带有交互式桌面的自托管 Windows 运行器上；在该工作流实际运行之前，这些探测不被当作通过。

> 标签一推，Release 即刻对外可见。若某版本确需先内测，应改用预发布标签而非正式版本标签。

## Tauri 正式版与 Beta（tauri 分支）

从 Tauri 成为正式版开始，发布都在 tauri 分支上打标签，由 `tauri-release.yml` 构建、签名并发布：

| 标签 | GitHub Release | 更新源 |
| --- | --- | --- |
| `tauri-vX.Y.Z`（正式版） | 普通 Release，标为 latest | `update-stable`；`update-beta`（除非那里已有更新的 Beta）；`channel-experimental`（给 0.9.37 及更早的 Tauri 版本） |
| `tauri-vX.Y.Z-beta.N`（Beta） | 预发布 | 只更新 `update-beta` |

- 应用里“包括 Beta 版本”关闭时只看 `update-stable`，打开时看 `update-beta`。只会升级到更高版本：从 Beta 关掉开关后，要等下一个更高的正式版。
- `package.json` 与 `src-tauri/Cargo.toml` 的版本必须一致，且只能是 `X.Y.Z` 或 `X.Y.Z-beta.N`。
- 更新源是固定的预发布（`update-stable` / `update-beta`），里面只有签名的 `latest.json`，不要从那里下载。哪些更新源会移动由 `scripts/release-feeds.mjs` 决定。
- `channel-stable` 是已退役的 Electron 更新源，只由 main 上的 `release.yml` 维护：它停在最后一个 Electron 过渡版，过渡版再把用户升级到 `update-stable` 上的 Tauri 正式版。
- 第一次发布前先手动运行一次 `tauri-release.yml`（workflow_dispatch）做干跑；第一次发 Beta 前同样干跑一次，确认安装包名带 `-beta.N`。
