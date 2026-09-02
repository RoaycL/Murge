# 已验证的框架状态

在 macOS 上于 2026-08-24 验证：

- `npm install`: 通过；已生成 lockfile。
- `npm run brand:check`: 通过。
- `npm run typecheck`: 通过。
- `npm run build`: 针对 main、preload 和 renderer 打包均通过。
- `npm run dev`: Electron 进程和 Vite 开发服务器已启动。
- `http://localhost:5173/`: 在开发进程活动时返回 HTTP 200。
- Activity、Overview、Processes、Devices、Policies、Rules、Capture、Decrypt、Rewrite 和 Settings 的视觉外壳均存在。
- 通过进程内模拟的 mock 控制器实现控制器 WebSocket 流（`/traffic`、`/logs`、`/connections`）；重连退避、抖动和监听器清理已验证。

本里程碑未验证：

- Windows x64/arm64 打包。
- Windows 代码签名。
- 实际的 mihomo 二进制监督。
- Windows 系统代理变更/恢复。
- TUN 安装和流量捕获。

GitHub 远程仓库尚未创建，因为本地 GitHub CLI 凭据无效。请在创建仓库前重新认证。
