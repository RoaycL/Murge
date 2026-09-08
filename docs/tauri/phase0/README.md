# Phase 0 交付物索引

迁移计划 Phase 0（冻结基线）的文档集。写代码前先读
`docs/TAURI_MIGRATION_PLAN.md` 与 `docs/ARCHITECTURE.md`。

| 文件 | 内容 | 对应 Phase 0 交付物 |
|---|---|---|
| [IPC_INVENTORY.md](./IPC_INVENTORY.md) | 全部 121 个 `window.desktop` 方法/事件与 IPC 通道 → 主进程实现链 + 测试映射；事件源汇总；横切守护清单 | 「Export an inventory mapping every `window.desktop` method/event and every IPC channel to its owning service and tests」 |
| [DIRECTORIES.md](./DIRECTORIES.md) | app-data/executable/logs/working/kernel/Sub-Store/service 目录基线、命名空间规则、开发/生产差异 | 「Record the current app-data, executable, logs, working, kernel, Sub-Store, and service directories」 |
| [PARITY_CHECKLIST.md](./PARITY_CHECKLIST.md) | 托盘 17 项 / 设置页 22 项 / headless 10 项 / 深链 5 项 / 更新器 10 项 / 关停 12 项对等矩阵 + 启动顺序义务 | 「Add a parity checklist for all tray commands, settings pages, headless commands, deep links, updater states, and shutdown paths」 |
| [BASELINE.md](./BASELINE.md) | 测试基线（TS/Go 真实执行结果）、性能测量方案与 Windows 占位、CI 链接占位 | 「Preserve a passing baseline」+「Record installer size, idle memory, cold start …」 |

## 当前完成度（对照退出门）

- [x] 清单覆盖每一个当前 IPC 方法与事件（121/121，脚本核对）
- [x] TS/Go 测试基线绿色（本环境真实执行）
- [ ] 基线测量数值与 CI 运行链接提交 —— **阻塞于 Windows CI/真机**（方法与占位已就绪，见 BASELINE.md）
- [x] 无产品行为变化（仅新增文档；`git diff main` 验证）

## 给 Phase 1+ 的使用规则

1. Phase 2/3 实现兼容桥时，`IPC_INVENTORY.md` 就是 `window.desktop` 的行为规格；
   每个 Tauri 命令实现后在「Tauri 对等」列或迁移 PR 中记录证据。
2. `PARITY_CHECKLIST.md` 的每个 ☐ 在通过对应的 Windows 验收后勾选。
3. 任何无法对等的行为：在文档里记录确切差异并请求产品决策，不静默修改。
