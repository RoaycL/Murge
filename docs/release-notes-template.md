# Murge {{VERSION}}

基于 mihomo 内核的 Windows 桌面客户端。

## 本次更新

- TUN 模式下 DNS 行为与 clash-party 保持一致：订阅未配置 DNS 时不再劫持 DNS，避免配置重载后真实 IP 与 fake-ip 来回切换、虚拟网卡重建，导致游戏等应用偶发登录失败。
- 订阅 DNS 未指定模式时沿用 mihomo 默认的 redir-host，不再强制改为 fake-ip；默认持久化 fake-ip 映射，内核重启后已缓存的地址仍然有效。
- 修复网卡名称包含 "lo"（如 "Local Area Connection"）时被误判为断网、内核被反复停止的问题。
- 开启系统代理时检测到 PAC 自动配置脚本会给出提示，因为 Windows 会优先使用 PAC。
- 清空 TUN 的路由地址 / 排除地址列表后，重新开启 TUN 会正确生效。
- TUN 开启状态下保存 TUN 设置会立即生效。
- 修改系统代理绕过列表失败时会还原并提示，不再出现设置稍后被自动改回的情况。
