# Murge

<div align="center">

**Another [Mihomo](https://github.com/MetaCubeX/mihomo) GUI**

[![Release](https://img.shields.io/github/v/release/RoaycL/Murge)](https://github.com/RoaycL/Murge/releases/latest)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

</div>

Murge 是一款基于 Electron + Vue 3 构建的现代化 Mihomo 图形客户端，专注于提供简洁、高效的代理管理体验。

## 特性

- **开箱即用** — 无需复杂配置，启动即用
- **TUN 模式** — 系统级虚拟网卡，全局代理无需手动配置系统代理
- **订阅管理** — 支持多订阅配置，自动更新与切换
- **策略组** — 可视化节点管理，支持手动选择、自动测速、故障转移
- **规则引擎** — 完整支持 Mihomo 规则集，实时查看规则命中统计
- **系统代理** — 一键接管/恢复系统代理，智能记忆原状态
- **深色主题** — 支持明暗双主题，自适应系统外观
- **自动更新** — 应用内自动检查更新，支持 GitHub 镜像加速

## 下载

前往 [Releases](https://github.com/RoaycL/Murge/releases) 页面下载最新版本。

目前支持 Windows x64 与 arm64。

> **macOS 用户**：Murge 不提供 macOS 版本。如需 macOS 客户端，请使用 [Surge](https://nssurge.com) —— Murge 的 UI 设计即参考自此项目。

## 技术栈

- **前端**：Vue 3 + TypeScript + Vite
- **后端**：Electron + Node.js
- **内核**：[Mihomo](https://github.com/MetaCubeX/mihomo)（Clash Meta）

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建
npm run build

# 打包 Windows 安装包
npm run dist
```

## 许可证

Murge 依据 [GNU General Public License v3.0](LICENSE) 开源发布。

第三方组件许可证详见 [THIRD_PARTY_NOTICES.md](resources/THIRD_PARTY_NOTICES.md)。

## 致谢

- [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo) — 规则代理内核（本项目基于此构建）
- [Surge](https://nssurge.com) — UI 设计参考
- [mihomo-party-org/clash-party](https://github.com/mihomo-party-org/clash-party) — 参考实现
- [clash-verge-rev/clash-verge-rev](https://github.com/clash-verge-rev/clash-verge-rev) — 参考实现
- [xishang0128/sparkle](https://github.com/xishang0128/sparkle) — 参考实现
