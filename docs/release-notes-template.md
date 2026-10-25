# Murge {{VERSION}}

## 本次更新

- 修复部分订阅配置在实验版里加载就崩溃（提示 `no entry found for key`）的问题，例如 proxy-providers 没写 path/format 的配置。
- 实验版处理配置 YAML 的规则改为与稳定版一致：正确展开 `<<: *锚点` 合并写法，`yes/no/on/off` 等写法、文件开头的 BOM、`!!str` 等类型标签都和稳定版、mihomo 的理解相同。
