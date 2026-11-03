# Windows 网络恢复

Murge 会改动两处系统网络状态：**系统代理**（当前用户的 Internet 设置）和 **TUN 模式**（由 Murge 核心服务以 SYSTEM 身份运行 mihomo 并创建虚拟网卡，网关模式下还会打开 IPv4 转发）。正常退出 Murge 时两者都会被还原。以下步骤用于 Murge 崩溃、界面打不开或被强制结束后网络不通的情况，都不会删除配置、订阅或备份。

## 先试：重新打开 Murge

1. 再次启动 Murge。启动时它会读取上次保存的状态，接管或清理遗留的内核与 TUN 会话。
2. 在概览页把「系统代理」和「TUN 模式」两个开关都关掉，确认网络恢复后再按需打开。
3. 从托盘菜单选择退出，而不是在任务管理器里结束进程。

## 系统代理没有还原

浏览器提示无法连接代理、但其他程序正常时，多半是系统代理还指向已经停止的 Murge 端口。在**普通**（非管理员）PowerShell 中运行：

```powershell
& "$env:ProgramFiles\Murge\murge.exe" --restore-system-proxy
```

这条命令不会打开窗口，也不会启动内核。它只在注册表仍是 Murge 写入的值时，才把代理改回 Murge 接管前的状态；如果代理已被你或其他软件改过，会保持原样不覆盖。退出码 0 表示已还原或无需还原，1 表示未能还原。

如果 Murge 安装在其他目录，请把路径换成实际的 `murge.exe` 位置。

## TUN 停不下来

Murge 崩溃后，核心服务里的 mihomo 可能仍在运行，所有流量继续经过 TUN。先按上面的方法重新打开 Murge 并关闭 TUN。如果 Murge 打不开，可以在**管理员** PowerShell 中停止核心服务，服务停止时会结束它启动的 mihomo 并关闭 IPv4 转发：

```powershell
Get-Service ProxyDesktopTun_* | Stop-Service
```

核心服务下次开机时会自动启动。想立即再用 TUN，在管理员 PowerShell 中运行 `Get-Service ProxyDesktopTun_* | Start-Service`。

## 卸载之后网络异常

卸载程序会先还原 Murge 接管的系统代理，再移除核心服务。如果卸载后仍有残留代理设置，请不要猜测或清除由公司或组织下发的代理 / PAC 配置：重新安装同一版本，运行上面的还原命令，再正常卸载。只要卸载时没有勾选删除应用数据，配置与代理备份目录都会保留，还原依然可行。

## 反馈问题时请附上

- Murge 版本号，以及问题发生时开启的是系统代理、TUN 还是两者都开。
- 「更多 → 日志 → 运行诊断」导出的诊断报告。它不包含配置、订阅地址、控制器密钥或访问记录。
- 手动修改前，`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 下 `ProxyEnable`、`ProxyServer`、`ProxyOverride` 三个值。

请不要公开配置文件 YAML、订阅地址、控制器密钥或原始日志。
