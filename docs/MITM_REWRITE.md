# HTTPS 解密（MITM）与重写 设计方案

状态：M1 已实现（2026-11-02），M2 已实现（2026-11-03，CA 二维码除外）。本文是功能规划，也是后续实现的约束。

## 1. 目标与非目标

目标：提供与 Surge「HTTPS 解密 / 重写」相近的体验。

- 用户生成并信任一张本机专属根证书（CA），对**明确列出的主机名**做 HTTPS 解密。
- 对经过解密（或明文 HTTP）的请求按规则重写：URL 重定向 / 拒绝、请求与响应头增删改、请求与响应体正则替换、本地映射（Map Local）。
- 能直接导入 Surge 模块（`.sgmodule`），URL 订阅可更新。

非目标（M1 不做）：

- 脚本（`$request` / `$response` / `$done`），放在 M3。
- HTTP 抓包 / 请求记录详情页（Surge 的「最近请求」完整版）。
- 对 LAN 网关模式下的其它设备做解密（它们不信任本机 CA，只会证书报错）。
- HTTP/3（QUIC）解密：改为对解密主机拒绝 UDP 443，迫使客户端回落 TCP。

## 2. Surge 的做法（参照行为）

| Surge 段 | 含义 | Murge M1 |
| --- | --- | --- |
| `[MITM] hostname = a.com, *.b.com, -c.b.com` | 只解密列出的主机，`-` 排除，`:port` 指定非 443 端口 | 支持（含 `%APPEND%` / `%INSERT%`） |
| `skip-server-cert-verify` | 解密后连接源站时不校验证书 | 支持（默认关闭） |
| `ca-p12` / `ca-passphrase` | 根证书 | 不导入外部 CA，只用 Murge 生成的 |
| `[URL Rewrite]` `regex 替换 302/307/reject/header` | 重定向、拒绝、透明改写 | 支持 |
| `[Header Rewrite]` `http-request/http-response regex header-add/del/replace/replace-regex` | 改头 | 支持（含旧语法） |
| `[Body Rewrite]` `http-request/http-response regex 正则 替换 ...` | 改体 | 支持文本体，大小上限 8 MB |
| `[Map Local]` `regex data-type=... data=... status-code=... header=...` | 直接返回本地内容 | 支持内联 `text/json/base64/tiny-gif` |
| `[Script]` | JS 脚本 | M3 |
| `[Rule]` | 规则 | M2：转为 mihomo 规则，只允许 DIRECT / REJECT 系策略；`RULE-SET` / `DOMAIN-SET` 链接转成 `rule-providers`；`URL-REGEX` + REJECT 交给解密引擎 |

`reject` 一族的返回：`reject` → 404 空体；`reject-200` → 200 空体；`reject-img` → 1×1 GIF；`reject-dict` → `{}`；`reject-array` → `[]`。

## 3. 和现有架构怎么接

### 3.1 现状

- 内核是 Mihomo，Murge 生成最终配置：`live_config::resolve_enhanced_document` 依次叠加「配置 → 覆写 → DNS → 嗅探」，再交给安全构建器（`inspection::build_profile_kernel_config` / `tun_profile::generate_proxied_tun_config`）。启动、热重载、提权服务配置都走这一条。
- 安全构建器会删掉 `listeners`，TUN 提权服务（Go）也禁止 `listeners`，所以**不能**给 Mihomo 额外加入站监听。
- 系统代理指向 `mixed-port`；TUN 模式下由 Mihomo 接管全部流量。

### 3.2 选型：MITM 作为 Mihomo 的一个「出站」，放在规则之后

```
应用 ──(系统代理 / TUN)──▶ Mihomo ──规则命中解密主机──▶ Murge-MITM（127.0.0.1:随机端口，Rust 进程内）
                                                             │ 解 TLS、执行重写
                                                             ▼
                                   Mihomo mixed-port ◀── 源地址 127.0.0.2 发起 CONNECT
                                        │ 正常规则（跳过解密规则）
                                        ▼
                                     代理 / 直连 ──▶ 源站
```

1. Murge 进程内跑一个 MITM 引擎，监听 `127.0.0.1:<随机端口>`，只接受带随机口令的 HTTP CONNECT。
2. 组合配置时（`resolve_enhanced_document` 最后一步）注入：
   - 代理 `Murge-MITM`：`type: http, server: 127.0.0.1, port: <端口>, username/password: <随机口令>`。
   - 规则，**插在最前面**，每个解密主机一组：
     - `AND,((NETWORK,UDP),(DST-PORT,443),(DOMAIN-SUFFIX,x)),REJECT`（禁 QUIC，迫使回落 TCP）
     - `AND,((NETWORK,TCP),(DOMAIN-SUFFIX,x),(NOT,((SRC-IP-CIDR,127.0.0.2/32)))),Murge-MITM`
3. 引擎解密后，从源地址 **127.0.0.2** 连回 Mihomo 的 `mixed-port` 发 CONNECT。`SRC-IP-CIDR,127.0.0.2/32` 让这条回流跳过解密规则，继续走用户原本的规则和策略组。这就是**防回环**的关键，而且不需要额外 listener，提权服务也不用改。
4. Mihomo 有时会把已解析的 IP 而不是域名放进 CONNECT（例如命中 `hosts`）。这时引擎改用 TLS ClientHello 里的 SNI（明文 HTTP 用 Host 头）判断是否解密。
5. Mihomo 规则只做「粗筛」（`DOMAIN` / `DOMAIN-SUFFIX`），精确的通配、排除（`-host`）、端口判断在引擎里做；不需要解密的连接引擎直接原样转发（透传）。

为什么不放在 Mihomo 前面（系统代理先指向 MITM）：TUN 流量根本不经过系统代理，前置方案在 TUN 下失效；而且所有流量都要多绕一跳。放在规则后面，系统代理与 TUN 两种模式行为一致，只有解密主机多一跳。

已知限制：
- 只在「规则模式」生效；全局 / 直连模式下 Mihomo 不走规则，解密不生效（页面上会提示）。
- 连接只有 IP、没有域名时无法命中（TUN 下依赖 fake-ip 或嗅探，Murge 默认已开）。
- 「连接」页里一次解密请求会出现两条连接：应用 → `Murge-MITM`，以及 127.0.0.2 → 真实策略。
- 引擎没在监听时不会注入规则（避免流量打到一个死端口）。

### 3.3 实现语言：Rust 进程内，不用 sidecar

- 依赖树里已有 `rustls 0.23 (ring)`、`tokio-rustls`、`hyper 1`、`hyper-util`、`webpki-roots`，只新增 `rcgen` 用于签发证书。
- 不用 `hudsucker`：它的依赖与 TLS 后端选择和现有树不一致，我们需要的「CONNECT + 可选解密 + 透传 + 回连 Mihomo」也需要定制。
- 不用 Go / Node sidecar：多一个进程、多一份签名和杀软风险。

### 3.4 协议细节

- M2 起客户端侧和源站侧 ALPN 都提供 `h2, http/1.1`，两侧各自协商：浏览器 h2 + 源站 h1、或反过来都能工作。源站 h2 连接在同一客户端连接的多个流之间共享；WebSocket 等 Upgrade 请求始终走 HTTP/1.1。「解密」页可以关闭 HTTP/2（设置项 `http2`，默认开）。
- WebSocket：`Upgrade` 请求照常改写请求头后转发，收到 101 后双向拷贝。
- 证书：CA 用 ECDSA P-256，有效期 10 年；叶子证书共享一把 P-256 密钥，按主机名签发并缓存（上限 1024 个），有效期 1 年，`SAN` 写入主机名。
- 源站证书校验：默认用 webpki 根证书校验；`skip-server-cert-verify` 打开时跳过。
- 响应体改写：命中 Body Rewrite 时把请求 `Accept-Encoding` 改为 `identity`；仍收到 gzip/deflate 时用 `flate2` 解压；超过 8 MB 或非文本（按 Content-Type）不改，原样透传。

## 4. 根证书（CA）

- 生成：首次在「解密」页点「生成证书」。
- 存储：证书（公开）存 `app-data/mitm/ca.crt`；私钥存 Windows 凭据管理器（`keyring`，现有依赖）。凭据管理器不可用时退回 `app-data/mitm/ca.key`（仅当前用户可读）。私钥永不发往渲染进程。
- 信任：默认装到**当前用户**的「受信任的根证书颁发机构」（`certutil -user -addstore Root`），不需要 UAC，Windows 会弹出一次确认框，用户必须点「是」。不装到本机（LocalMachine）存储，避免影响其它用户、也不需要提权。Firefox 需开启 `security.enterprise_roots.enabled`（页面提示）。
- 状态：通过证书指纹在当前用户 Root 存储中查询（`certutil -user -verifystore Root <thumbprint>`）。
- 移除：「移除信任」从存储中删除；「重新生成」先删旧信任再换新证书；「删除证书」同时删私钥。
- 导出：可导出 `.crt`（给手机等设备用，M2 再做二维码）。

## 5. 安全

- 默认关闭；必须同时满足：解密开关打开、CA 已生成、已被信任、至少一个主机名。
- 只解密列出的主机名，不支持裸 `*`（拒绝保存）；`*.com` 这类顶级后缀给出警告。
- 每台机器一张独立 CA，私钥不离开本机、永不进备份。M2 起配置备份包含 `mitm/mitm.json`（开关、主机名、本地规则、模块及其参数），不包含 `mitm/ca.json` 和私钥；恢复到另一台机器后需要重新生成并安装 CA。
- 引擎只监听回环地址，只接受带每次启动随机口令的 CONNECT。
- 证书钉扎的应用（银行、部分游戏、Windows Update、Microsoft 登录等）解密会失败：页面提示「只添加需要的主机」，出错主机可一键加入排除。
- 关闭解密时立刻撤下注入的规则（热重载），引擎停止接受新连接。

## 6. 配置格式

全部按 Surge 模块语法存储，便于直接导入社区模块：

- 本地模块：一个文本编辑框，内容就是一个 `.sgmodule`（可写 `[MITM]`、`[URL Rewrite]`、`[Header Rewrite]`、`[Body Rewrite]`、`[Map Local]`）。
- 远程模块：URL 订阅，记录名称（`#!name`）、描述（`#!desc`）、启用状态、更新时间；可手动更新。
- 设置文件 `app-data/mitm/mitm.json`：`enabled`、`rewriteEnabled`、`skipServerCertVerify`、`hostnames`（解密页里直接维护的主机名）、`modules[]`。
- 解析后的不支持行（如 `[Script]`、`#!arguments`）显示为警告，不阻断其它规则。
- M2 兼容 Loon 插件 `[Rewrite]`（`正则 动作 参数`）和 QX `[rewrite_local]`（`正则 url 动作 参数`）：reject 系、30x、header、header-add/del/replace（含 request-/response- 前缀）、request/response-body-replace-regex、QX `response-body A response-body B`、Loon mock-response-body；script 和 echo-response 提示不支持。`[filter_local]` 按 `[Rule]` 处理，`[Argument]` / `[Plugin]` / `[general_local]` 忽略。
- jq 正文改写：Surge `http-request-jq` / `http-response-jq`（内联表达式，单引号或双引号包住）和 Loon `request/response-body-json-jq`，用纯 Rust 的 jaq 执行，只对 JSON 正文生效，取第一个输出；解析失败、运行出错或没有输出时保留原文。`jq-path=` 外部文件暂不支持。jaq 删除键后可能改变键的顺序，不影响 JSON 语义。表达式由模块作者提供，死循环表达式会占住一个工作线程，这一点和 Surge 一样依赖模块可信。
- 模块参数 `#!arguments=key:默认值,...`：正文里的 `{{{key}}}` 在解析前替换；「重写」页每个模块可以编辑参数，只保存模块声明过的键。

## 7. 界面

现有「覆写」页是 Mihomo YAML/JS 覆写，和 Surge 的「重写」不是一回事，保持不动。侧边栏新增一组「HTTP」：

- **解密**（`/mitm`）：总开关；证书卡片（状态、生成、信任、移除、导出）；主机名列表（增删、启用）；跳过源站证书校验开关；最近解密的请求（引擎环形缓冲，200 条，方法 / URL / 状态 / 命中的重写）。
- **重写**（`/rewrite`）：总开关；模块列表（本地 + 远程，启用 / 更新 / 删除 / 从 URL 添加）；本地模块编辑器；当前生效规则统计与解析警告。

## 8. 里程碑

- **M1（本 PR）**：CA 生成 / 信任 / 移除；MITM 引擎（HTTP/1.1、WebSocket、透传、回连防回环）；规则注入与热重载；URL / Header / Body Rewrite、Map Local（内联）；Surge 模块导入（本地 + URL）；两个页面；最近请求列表；单元测试。
- **M2（已完成，CA 二维码待做）**：HTTP/2；`[Rule]` 段转 mihomo 规则；Loon / QX 语法；「连接」页标记「已解密」；导出 CA 二维码；模块参数 `#!arguments`。
- **M3**：脚本（复用现有 `boa_engine` 沙箱，兼容 `$request/$response/$done/$httpClient` 子集）。

## 9. 测试

- 单元：模块解析（各段、旧语法、引号参数、警告）；主机名匹配（通配、排除、端口）；重写执行（302/307/reject 族、header 各操作、body 多组替换、Map Local）；配置注入（规则顺序、口令、无 CA / 关闭时不注入）；CA 生成与叶子签发（用 rustls 校验链）。
- 集成（Rust tokio 测试，Linux CI 可跑）：起一个本地 TLS 源站 + 假的上游 CONNECT 代理，经引擎请求，校验解密、重写、透传、WebSocket，以及所有回流都来自 127.0.0.2。
- 真实内核（手动）：`MURGE_E2E_MIHOMO=/path/to/mihomo cargo test --lib mitm::engine::e2e`，用注入后的配置启动 Mihomo，确认规则命中 `Murge-MITM`、回流命中原有规则（不回环）、响应体被改写。M1、M2 已用 Mihomo v1.19.30 跑通。
- Windows 实机（Roayc）：证书安装弹窗与信任状态；Edge / Chrome 访问被解密站点无证书警告；系统代理与 TUN 两种模式；关闭后规则撤除。

## 10. 待 Roayc 确认的问题

1. 侧边栏是否新增「HTTP」分组放「解密」「重写」两页（本方案），还是合并成一页？
2. 证书只装「当前用户」存储（无 UAC，推荐），是否还需要「装到本机」选项？
3. 默认引擎端口用随机端口（推荐），还是固定端口方便手机 / 其它设备手动配置？
4. 全局 / 直连模式下是否也要强制解密（需要另想办法，M1 不做）？
5. M2 里优先做 HTTP/2、`[Rule]` 段，还是 Loon / QX 兼容？
