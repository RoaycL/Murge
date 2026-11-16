# 自定义界面样式

设置 → 外观 → 「样式」和「自定义 CSS」。

## 保存位置

- 应用数据目录下的 `ui-style.json`，属于配置备份的一部分（本地备份和 WebDAV 都会带上）。
- 渲染进程在 localStorage（`ui-style.v1`）里留一份缓存，只用来让启动时第一帧就是用户的样式。
- 校验规则在 `src/shared/ui-style.ts`，主进程 `src-tauri/src/ui_style.rs` 逐字段做同样的校验：
  - `accent`：`#rrggbb`（`#rgb` 会展开），否则视为默认。
  - `fontFamily`：最多 200 字符，不能包含 `; { } < > \` 或 `url(`，引号必须成对，所以无法借字体名注入 CSS。
  - `fontScale`：`small | default | large | larger`，按 0.93 / 1 / 1.07 / 1.14 缩放全部 `--font-size-*`。
  - `customCss`：最多 64 KB。

## 生效方式

head 末尾依次插入三个 `<style>`，顺序保证同特异性时后者胜出：

1. `#ui-style-variables`：强调色、字体、字号对应的变量覆盖（`html:root { … }`）。
2. `#ui-style-custom`：用户自定义 CSS。
3. `#ui-style-guard`：只在试用期间存在，保证确认条可见。

强调色同时覆盖 `--app-blue` 与 `--app-accent`（大部分组件仍直接引用 `--app-blue`），并按亮度自动选择 `--app-on-accent` 的黑白字色。运行状态色（`--runtime-*`）和页面小标题色（`--app-pink`）不跟随强调色。

## 安全兜底

- **先试用再保存**：点「应用」后 CSS 立即生效，底部出现确认条，15 秒内点「保留」才写盘；否则或按 Esc 自动还原。重新打开「启用自定义 CSS」开关也会走一遍试用。
- **快捷键 `Ctrl+Alt+Shift+C`**：在本次运行内临时停用自定义 CSS（不改保存内容），再按一次恢复。界面被 CSS 弄得无法操作时使用。
- **CSP**：`style-src` 允许内联样式，但 `font-src` / `img-src` 只允许本地与 `data:`，CSS 里的远程字体、图片、`@import` 不会加载。字体请使用本机已安装的字体名。
- 「恢复默认」清除全部样式设置。

## 稳定的样式接口

以下变量视为对外接口，改名或删除需要在更新日志里注明（完整列表见 `UI_STYLE_VARIABLES`，测试会核对它们确实存在于 `tokens.css`）：

| 变量 | 用途 |
| --- | --- |
| `--app-font` | 全局字体 |
| `--app-accent` / `--app-on-accent` | 强调色 / 强调色上的文字 |
| `--app-text` / `--app-muted` | 正文 / 次要文字 |
| `--app-pink` | 页面小标题 |
| `--app-danger` / `--app-warning` | 错误 / 警告 |
| `--app-background-start` / `--app-background-end` | 窗口渐变背景 |
| `--content-panel` | 右侧内容面板 |
| `--app-surface` | 卡片 |
| `--app-divider` | 分隔线 |
| `--app-sidebar-selected` | 侧边栏选中项 |
| `--glass-bg` | 右键菜单、弹窗玻璃底 |
| `--radius-card` / `--radius-control` | 卡片 / 控件圆角 |
| `--font-size-*` | 字号阶梯（`2xs` … `hero`） |

根元素属性：`data-theme="light|dark"`、`data-frosted="true|false"`、`data-contrast="normal|high"`、`data-reduce-motion`。例如只改深色模式：

```css
:root[data-theme="dark"] {
  --app-background-start: #10131a;
  --content-panel: rgba(22, 25, 33, 0.9);
}
```
