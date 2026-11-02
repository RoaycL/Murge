# 发布

Murge 正式版是 Tauri 版本，发布都在 `main` 分支上打标签。旧的 Electron 版本在 `electron-legacy` 分支，已停止发布（最后一个版本是 v0.9.38）。

## 正式版与 Beta

在 `main` 上打标签，由 `tauri-release.yml` 构建、签名并发布：

| 标签 | GitHub Release | 更新源 |
| --- | --- | --- |
| `tauri-vX.Y.Z`（正式版） | 普通 Release，标为 latest | `update-stable`；`update-beta`（除非那里已有更新的 Beta）；`channel-experimental`（给 0.9.37 及更早的 Tauri 版本） |
| `tauri-vX.Y.Z-beta.N`（Beta） | 预发布 | 只更新 `update-beta` |

- 应用里“包括 Beta 版本”关闭时只看 `update-stable`，打开时看 `update-beta`。只会升级到更高版本：从 Beta 关掉开关后，要等下一个更高的正式版。
- `package.json` 与 `src-tauri/Cargo.toml` 的版本必须一致，且只能是 `X.Y.Z` 或 `X.Y.Z-beta.N`。
- 更新源是固定的预发布（`update-stable` / `update-beta`），里面只有签名的 `latest.json`，不要从那里下载。哪些更新源会移动由 `scripts/release-feeds.mjs` 决定。
- `channel-stable` 是已退役的 Electron 更新源，停在最后一个 Electron 过渡版 v0.9.38，过渡版再把用户升级到 `update-stable` 上的 Tauri 正式版。
- 第一次发布前先手动运行一次 `tauri-release.yml`（workflow_dispatch）做干跑；第一次发 Beta 前同样干跑一次，确认安装包名带 `-beta.N`。

## CI 不重复跑

`scripts/ci-gate.mjs` 让 CI 不把同一份代码测两遍：

- 只改了版本号（`package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 里的应用版本）和/或文档的改动，如果它所基于的提交已经通过，就跳过 CI。版本号 PR 和它合并进 `main` 时都不再重跑。
- PR 合并进 `main` 后，如果合并结果和 PR 最后测过的代码完全一样（分支已包含最新 `main`），就不再重跑。
- 打标签发布时，如果 `CI` 和 `Tauri Windows build` 已在这个提交上通过，发布构建不再重复跑 typecheck 和单元测试（Windows 单元测试已移到 `Tauri Windows build` 的 x64 任务里）；它们失败过则拒绝发布；没跑完（最多等 10 分钟）就由发布构建自己测。
