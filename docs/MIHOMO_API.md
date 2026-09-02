# mihomo 控制器 API 契约

主要参考：

- 官方 API 文档：https://wiki.metacubex.one/en/api/
- 官方配置文档：https://wiki.metacubex.one/en/config/
- 内核分支与许可：https://github.com/MetaCubeX/mihomo/tree/Meta

本文件是一份实现映射表，并不替代上游文档。由于字段与端点会不断演进，在发布前请重新核对上游。

## 连接建立

推荐的生成配置：

```yaml
external-controller: 127.0.0.1:9090
secret: <random-per-install-secret>
```

每个 REST 请求与 WebSocket 升级都会发送：

```http
Authorization: Bearer <secret>
```

绝不要把 secret 暴露给渲染进程。主进程负责持有 base URL、secret 与套接字。

## 各里程碑所需端点

| 优先级 | 方法 | 路径 | 用途 |
|---|---|---|---|
| P0 | GET | `/version` | 控制器就绪状态与显示的内核版本 |
| P0 | GET | `/configs` | 运行时模式、端口、LAN、IPv6 与 TUN 状态 |
| P0 | PATCH | `/configs` | 更改受支持的动态配置字段 |
| P0 | GET/WS | `/traffic` | 当前上/下行速率与累计总量 |
| P0 | GET/WS | `/connections` | 活动连接、进程元数据与总计 |
| P0 | DELETE | `/connections/:id` | 关闭单个连接 |
| P0 | DELETE | `/connections` | 关闭全部连接 |
| P0 | GET/WS | `/logs` | 实时日志 |
| P1 | GET | `/proxies` | 节点与策略组 |
| P1 | PUT | `/proxies/:group` | 选择一个组内成员 |
| P1 | GET | `/proxies/:name/delay` | 测试单个节点 |
| P1 | GET | `/group/:name/delay` | 测试组内成员 |
| P1 | GET | `/rules` | 规则列表与计数器 |
| P1 | GET | `/providers/proxies` | 订阅/provider 元数据 |
| P1 | PUT | `/providers/proxies/:name` | 更新单个代理 provider |
| P1 | GET | `/providers/proxies/:name/healthcheck` | 对 provider 进行健康检查 |
| P1 | GET | `/providers/rules` | 规则 provider 元数据 |
| P1 | PUT | `/providers/rules/:name` | 更新单个规则 provider |
| P2 | GET | `/dns/query?name=&type=` | 诊断性 DNS 查询 |
| P2 | POST | `/cache/dns/flush` | 刷新 DNS 缓存 |
| P2 | POST | `/cache/fakeip/flush` | 刷新 fake-IP 缓存 |
| P2 | GET/WS | `/memory` | 内核内存遥测 |
| P2 | PUT | `/configs?force=true` | 重载完整配置 |

内核与 UI 更新端点必须在设计出发布签名、校验和验证与回滚机制之前保持禁用状态。

## 消息结构

### 流量

`GET` 或 `WS /traffic`，大约每秒一次：

```ts
interface TrafficMessage {
  up: number       // bytes per second
  down: number     // bytes per second
  upTotal: number  // cumulative bytes
  downTotal: number
}
```

直接映射到两张速率卡片。不要从该数据流推导每进程排行。

### 连接

`GET` 或 `WS /connections?interval=1000`：

```ts
interface ConnectionsSnapshot {
  downloadTotal: number
  uploadTotal: number
  memory: number
  connections: Array<{
    id: string
    metadata: {
      network?: string
      type?: string
      sourceIP?: string
      destinationIP?: string
      sourcePort?: string
      destinationPort?: string
      host?: string
      process?: string
      processPath?: string
    }
    upload: number
    download: number
    start: string
    chains: string[]
    providerChains?: string[]
    rule: string
    rulePayload: string
  }>
}
```

聚合方式：

- 活动连接数：`connections.length`。
- 进程：归一化后的非空 `metadata.process` 或 `processPath`。
- 域名：归一化后的 `metadata.host`；仅在详情视图中回退到目标 IP。
- 策略：按文档规定的链约定取最终/可见的链标签。
- 单项用量：在快照内对连接 `upload + download` 求和。这是活动连接的流量，而非持久的历史计数。

持久的日/月总计需要应用保存采样的增量值，或消费另一个持久数据源。不要把非持久的快照标注为历史真值。

### 代理与策略组

`GET /proxies` 返回一个以代理或策略组名称为键的对象。常见字段包括 `name`、`type`、`alive`、`history` 以及能力标志。策略组还会包含 `now`、`all`、`testUrl`、`hidden`、`icon`，有时还有 `fixed`。

选择成员：

```http
PUT /proxies/<percent-encoded-group-name>
Content-Type: application/json

{"name":"member name"}
```

成功时返回 HTTP 204。重新拉取该策略组，或乐观更新并在出错时回滚。

延迟测试：

```http
GET /proxies/<name>/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=5000&expected=204
```

响应：`{ "delay": 73 }`。请将超时、零值和缺失的 delay 区分处理。

策略组延迟测试使用 `GET /group/<name>/delay?...` 并返回一个以成员名称为键的映射（`{ "香港 01": 42, "DIRECT": 6 }`）。测试失败或未测量的成员不会出现在映射中（它们不会被写成哨兵值），因此缺失的键表示「无可用延迟」，必须呈现为不可用——它不是超时。整组超时/探测失败会使请求本身返回 HTTP 504/503。

### Provider

`GET /providers/proxies` 返回 `{ "providers": { <name>: {...} } }`。每个代理 provider 由上游编组为（已对照 `adapter/provider/provider.go` 验证）：

```ts
interface MihomoProxyProvider {
  name: string
  type: 'Proxy'
  vehicleType: string          // HTTP | File | Compatible | Inline
  proxies: MihomoProxy[]        // member OBJECTS, not names — there is NO count field
  testUrl?: string
  expectedStatus?: string       // e.g. "204"
  updatedAt?: string
  subscriptionInfo?: {          // only for a subscription-backed vehicle
    Upload: number              // bytes (int64), capitalised keys
    Download: number
    Total: number
    Expire: number              // Unix timestamp in SECONDS (0 = no expiry)
  }
}
```

从 `proxies.length` 推导节点数量；不要指望存在 `proxiesCount` 字段。
`GET /providers/proxies/<name>/healthcheck` 返回 **HTTP 204 且无响应体**（它会重新探测成员并在每个代理上记录新鲜的 `history` 条目）；之后请从 `/providers/proxies` 读回延迟值，而不是从 healthcheck 响应中读取。

`GET /providers/rules` 返回规则 provider，编组为（已对照 `rules/provider/provider.go` 验证）：

```ts
interface MihomoRuleProvider {
  name: string
  type: 'Rule'
  behavior: string              // Domain | IPCIDR | Classical
  format: string                // yaml | text | mrs
  vehicleType: string           // HTTP | File | Inline
  ruleCount: number
  updatedAt?: string
  payload?: string[]            // inline providers only
}
```

### 运行时配置

`GET /configs` 返回一个灵活的、包含如下字段的对象：

- `port`、`socks-port`、`mixed-port`
- `mode`：`rule`、`global` 或 `direct`
- `log-level`
- `allow-lan`
- `ipv6`
- `tun`

仅通过 `PATCH /configs` 更改白名单字段。完整 profile 激活使用 `PUT /configs?force=true` 并携带 `{ path, payload }`，且必须保持在主进程中。工作目录之外的路径可能需要上游配置 `SAFE_PATHS`；请优先将受管 profile 保留在内核工作目录内。

`GET /version` 与 `GET /configs` 也被 Windows 系统代理实时探针复用（`src/main/system-proxy/probe.ts`）：在启用每用户代理之前，它会先读取 `/version`（内核必须正在运行）和 `/configs` 中的 `mixed-port`，并且除非该 mixed-port 是有效的回环端口（`127.0.0.1`），否则拒绝启用。代理针对回环 mixed-port 进行注册；system-proxy 功能本身不会打开任何新的控制器或代理监听器。

### 规则

`GET /rules` 返回：

```ts
interface Rule {
  index: number
  type: string
  payload: string
  proxy: string
  size: number
  extra?: {
    disabled?: boolean
    hitCount?: number
    hitAt?: string
    missCount?: number
    missAt?: string
  }
}
```

临时禁用规则通过 `PATCH /rules/disable` 实现，以规则索引为键。重启后它会重置；UI 必须将其标注为临时。

### 日志

支持时使用 `WS /logs?level=info&format=structured`。结构化消息包含 `time`、`level`、`message` 与 `fields`。标准模式使用 `type` 与 `payload`。解析器必须同时接受这两种格式，并限制渲染进程缓冲区大小。

## WebSocket 生命周期

1. 仅在 `/version` 健康检查成功后连接。
2. 从 Electron 主进程在升级请求中包含 bearer 头。
3. 每条消息解析一个 JSON 对象。
4. 通过每个流一个 IPC 事件，将归一化后的样本发布给渲染进程订阅者。
5. 无论存在多少 Vue 组件，都保持单一上游套接字。
6. 使用带抖动的退避重试网络故障：250 ms、500 ms、1 s、2 s，最大 5 s。
7. 在稳定连接 10 秒后重置退避。
8. 在内核有意关停时立即停止。

## 错误映射

| 条件 | UI 状态 |
|---|---|
| 连接被拒绝 | 内核/控制器不可用 |
| HTTP 401 | 控制器 secret 不匹配；绝不显示 secret |
| HTTP 404 | 不支持的端点/版本能力 |
| HTTP 400/422 | 请求的配置或节点操作无效 |
| HTTP 503（延迟测试） | 节点不可达 / 不可用 |
| HTTP 504（延迟测试） | 节点延迟超时 |
| 停止期间 WebSocket 关闭 | 正常停止状态 |
| 格式错误的 JSON | 协议错误，并输出脱敏的诊断日志 |
| 反复崩溃/重连 | 失败状态，附带明确的重新连接操作 |

## 能力检测

在启动时：

1. 读取 `/version`。
2. 读取 `/configs`。
3. 仅探测当前可见页面所需的可选端点。
4. 为当前 PID/版本缓存能力。
5. 隐藏或禁用不支持的 UI 并给出解释；绝不假定每个版本都提供每个文档字段。
