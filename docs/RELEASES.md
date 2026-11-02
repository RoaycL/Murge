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
