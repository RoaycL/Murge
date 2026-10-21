# Murge {{VERSION}}

基于 mihomo 内核的 Windows 桌面客户端。

## 本次更新

- 修复开机自启开关显示关闭，但 Windows 计划任务实际仍启用的问题。
- 正确识别 Windows 任务数据省略 Enabled 字段时的默认启用状态，关闭开关时实际禁用任务。
- 增加与 Windows 导出任务格式一致的回归测试，防止再次误判自启状态。
