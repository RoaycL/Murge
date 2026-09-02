# Windows 紧急网络恢复

首个发布候选支持 Windows 系统代理，并且不包含 TUN。以下步骤不会删除配置。

## 首选恢复方式

1. 正常退出应用。主进程会在停止 mihomo 之前恢复其拥有的系统代理。
2. 如果界面不可用，请在普通 PowerShell 窗口中运行已安装的可执行文件：

   ```powershell
   & "$env:ProgramFiles\Murge\murge.exe" --restore-system-proxy
   ```

   成功退出意味着要么精确保存的状态已恢复，要么 Murge 不再拥有当前代理值。冲突不会被覆盖。
3. 重新启动应用，并确认 Overview 报告系统代理已禁用。

## 如果应用已被移除

不要猜测或清除组织管理的代理/PAC 值。请重新安装相同版本，运行上面的恢复命令，然后正常卸载。配置与拥有式备份目录由卸载有意保留，因此恢复仍有可能。

## 需要保留的证据

在进行手动更改之前，请捕获三个 HKCU Internet Settings 值：`ProxyEnable`、`ProxyServer` 和 `ProxyOverride`。记录应用版本，并附上隐私安全的诊断包。绝不发布配置文件 YAML、控制器秘密、原始日志、目标地址或订阅 URL。

之所以不提供 TUN/路由/DNS 恢复说明，是因为 TUN 不属于此 RC。暴露 TUN 的构建不得在此范围内发布。
