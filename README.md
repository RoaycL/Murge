# Murge desktop framework

一个面向 Windows 优先网络客户端的 Electron + Vue 3 框架，由单独监管的 mihomo 进程作为内核。

项目目前实现了第 1–9B 阶段的应用外壳、类型化 IPC、配置文件、mihomo REST/WebSocket 传输、Windows 打包、已验证的 Windows 系统代理接管，以及社区式单 mihomo 内核生命周期：系统代理与 TUN 共用同一个 mihomo（TUN 开启时以特权方式重启该内核并注入 `tun` 配置），数据面（规则/分组/测量/日志）始终读取该单内核控制器。自动应用/内核更新暂未实现。

## 启动 UI 开发构建

```bash
npm install
npm run dev
```

开发模式使用进程内回环 mock 控制器和一个无害的 fixture 进程。它从不会启动真正的 mihomo，也不会修改系统网络。打包的 Windows 构建同样以停止状态启动；只有在用户在 Overview 中按下“启动”后才会下载并运行经过验证的内核，使用仅回环、已认证的控制器并应用当前激活的配置。启用 TUN 会以特权方式重启同一内核并注入 `tun` 配置；系统代理与 TUN 指向同一混合端口。

## 交接阅读顺序

1. [`docs/DEVELOPMENT_SAFETY.md`](docs/DEVELOPMENT_SAFETY.md)
2. [`docs/ui-reference/murge-ui-preview.html`](docs/ui-reference/murge-ui-preview.html)
3. [`docs/AI_HANDOFF.md`](docs/AI_HANDOFF.md)
4. [`docs/ROADMAP.md`](docs/ROADMAP.md)
5. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
6. [`docs/UI_SPEC.md`](docs/UI_SPEC.md)
7. [`docs/MIHOMO_API.md`](docs/MIHOMO_API.md)
8. [`docs/BRANDING.md`](docs/BRANDING.md)
9. [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)

> 安全门禁：此 Mac 可能是所有者的活动远程连接。不要启动真实内核，也不要修改其代理、TUN、DNS、路由、防火墙或其他网络状态。完整的强制规则见 `docs/DEVELOPMENT_SAFETY.md`。

## 项目状态

- Electron 安全默认设置：已实现
- Vue 路由与应用外壳：已实现
- Activity 与 Overview UI：已实现；最终的跨页面像素校对待完成
- 类型化的 renderer/preload/main IPC 契约：已实现并通过运行时验证
- Mihomo REST/WebSocket 传输：已实现
- 内核进程监管：已实现；真实的 Windows 启动仅为显式操作
- 配置文件/订阅与稳定的生产存储：已实现
- Windows x64/arm64 打包与 GitHub 草稿发布：已实现
- Windows 系统代理与 TUN（单内核）：已实现；系统代理的启用/精确恢复/崩溃恢复已通过 Windows 验证，TUN 的 Windows 运行时证据仍在补全
- 安装包签名与更新通道：未实现

## 命名

产品名称并非架构标识符。请通过 [`brand.config.json`](brand.config.json) 重命名项目；见 [`docs/BRANDING.md`](docs/BRANDING.md)。

## 许可说明

Murge 是依据[仅 GNU 通用公共许可证第 3 版](LICENSE)（`GPL-3.0-only`）发布的自由软件。除非存在完整的根许可证和匹配的 `package.json` SPDX 标识符，否则标记的发布构建会故障关闭（fail closed）。第三方组件仍保留其各自许可证；见 [`resources/THIRD_PARTY_NOTICES.md`](resources/THIRD_PARTY_NOTICES.md)。
