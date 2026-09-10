# Murge {{VERSION}}

基于 mihomo 内核的 Windows 桌面客户端。

## 本次更新

- 修复 DNS 复写和嗅探复写显示已启用、但 Mihomo 仍继续使用配置文件原始参数的问题；相关设置现在通过进程内完整配置重载生效，不会重启内核或强制关闭现有监听端口。
- DNS 复写成功后会清理 DNS 与 Fake-IP 缓存，Fake-IP 网段、上游服务器及过滤规则可立即切换；内核拒绝新配置时会恢复并重新应用修改前的设置。
- 恢复特权服务从 ProgramData 产品命名空间到 service/state 子目录的完整 ACL 加固，阻止可写父目录或目录联接替换特权文件。
- 保留升级已有 Windows 服务所需的显式服务类型配置，避免再次出现 `UpdateConfig: The parameter is incorrect`；新增目录加固范围和服务升级配置回归测试。
