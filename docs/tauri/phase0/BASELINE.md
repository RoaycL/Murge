# Phase 0 — 基线（测试 + 性能测量方案）

> 迁移计划 Phase 0 交付物：*"Preserve a passing baseline"* + *"Record installer
> size, installed size, idle memory, cold start … on x64 and arm64"*。
>
> 本仓库当前开发环境是 Linux ARM64 容器：TypeScript/Go 测试可真实运行；
> Windows 运行时测量（安装包体积/内存/冷启动/真实 mihomo/系统代理/TUN/交互
> GUI smoke）只能在 Windows CI 或真机上取得，本文记录**测量方法与占位**，
> 数值由 `package-win` / `windows-gui-smoke` 工作流补齐并回填。

## 1. 测试基线（真实执行结果）

执行环境：Linux ARM64 容器，tauri 分支 `6dbc1b6`，2025-09-08。

### TypeScript（`npm test`，vitest）

```
Test Files  173 passed | 4 skipped (177)
     Tests  1883 passed | 7 skipped (1890)
  Duration  ~49s
Exit code 0
```

- 跳过的 4 个文件是 Windows 运行时集成测试（`system-proxy-real.integration`、
  `mihomo-kernel.integration`、`mihomo-kernel-cleanup-fault.integration`、
  `electron-redirect-runtime`），在 Windows CI 上执行。
- 结论：**基线绿色**。迁移过程中任何阶段该套件必须保持全绿。

### Go TUN 服务（`native/tun-service`，`go test ./...`）

```
go version go1.26.5 linux/arm64
ok  example.invalid/proxy-desktop-tun-service  1.202s
Exit code 0
```

- 结论：**基线绿色**（Go 1.26.5，位于 `/usr/local/go/bin`，需手动加入 PATH）。

### 尚未在本环境取得的基线（Windows 专属，记录占位）

| 门 | 工作流/命令 | 基线数值 | 状态 |
|---|---|---|---|
| Windows 打包（x64 + arm64 NSIS） | `npm run package:win` | 安装包体积 / 安装后体积 | ☐ 待 Windows CI |
| 真实 mihomo 启动与控制器就绪 | `--kernel-smoke` 探针 | 冷启动 → mixed port 就绪耗时 | ☐ |
| 系统代理 enable/guard/restore | `--system-proxy-enable` + 卸载恢复 | 注册表快照通过 | ☐ |
| TUN install/start/hot-switch/stop/uninstall | `windows-tun` 工作流 | 全链路通过 | ☐ |
| 交互 GUI / 托盘 smoke | `--ui-smoke` `--hidden-smoke` | 通过 | ☐ |
| Electron→升级矩阵 | `rc-upgrade-matrix-static`（静态部分已绿） | 安装级升级通过 | ☐ |

## 2. 性能基线测量方案（Phase 0 定义的六个指标）

> 每项给出测量方法与记录格式。所有测量在 **x64 与 arm64 两套 Windows** 上、
> 安装版（非 dev）、干净账户下进行，重复 3 次取中位数。

| 指标 | 方法 | 记录 |
|---|---|---|
| 安装包体积 | CI 产物 `*.exe` 文件大小 | x64: ☐ MB / arm64: ☐ MB |
| 安装后体积 | 安装目录（含 `resources/`）递归大小 | x64: ☐ MB / arm64: ☐ MB |
| 空闲内存 | 启动后静置 60 s，主进程+renderer+GPU+utility 进程 WorkingSet 之和（PowerShell `Get-Process`） | x64: ☐ MB / arm64: ☐ MB |
| 冷启动 → 可见窗口 | 进程创建到 `ready-to-show`+窗口可见（`--ui-smoke` 增强打点或 ETW） | x64: ☐ ms / arm64: ☐ ms |
| 冷启动 → 托盘就绪 | 进程创建到 `trayController.isReady()`（`--hidden-smoke` 打点） | x64: ☐ ms / arm64: ☐ ms |
| 冷启动 → mixed port 就绪 | 进程创建到控制器 `/version` 200 + 端口归属校验通过（`--kernel-smoke` 打点） | x64: ☐ ms / arm64: ☐ ms |

Tauri 侧（Phase 5 出包后）用**相同方法**重测并在迁移 PR 里对照本表。

## 3. CI 基线

- 仓库工作流以 Windows CI 为准（GitHub Actions，自托管 runner 承载交互 smoke）。
- 本环境（Linux 容器）取得的 TS/Go 基线是**可重现的本地对照**；CI 链接在
  Windows CI 上补录到下表：

| 工作流 | 最近绿色运行 | 备注 |
|---|---|---|
| lint/typecheck/test（Linux, 本地复现） | 本次会话（vitest 1883 通过） | 等价于 CI `test` job |
| windows-package (`package:win`) | ☐ 待补 CI 链接 | x64+arm64 |
| windows-gui-smoke | ☐ 待补 CI 链接 | 交互探针 |

## 4. 行为不变声明（退出门第 3 条）

Phase 0 只新增文档（`docs/tauri/phase0/*`）与进度表更新；**未修改任何产品代码、
构建脚本或测试**。对 `main` 的 diff 经 `git diff main --stat` 验证仅含文档。
