# mihomo controller API contract

Primary references:

- Official API documentation: https://wiki.metacubex.one/en/api/
- Official configuration documentation: https://wiki.metacubex.one/en/config/
- Kernel branch and license: https://github.com/MetaCubeX/mihomo/tree/Meta

This file is an implementation map, not a replacement for upstream documentation. Re-check upstream before release because fields and endpoints can evolve.

## Connection setup

Recommended generated configuration:

```yaml
external-controller: 127.0.0.1:9090
secret: <random-per-install-secret>
```

Every REST request and WebSocket upgrade sends:

```http
Authorization: Bearer <secret>
```

Never expose the secret to the renderer. Main process owns the base URL, secret and sockets.

## Required endpoints by milestone

| Priority | Method | Path | Purpose |
|---|---|---|---|
| P0 | GET | `/version` | Controller readiness and displayed kernel version |
| P0 | GET | `/configs` | Runtime mode, ports, LAN, IPv6 and TUN state |
| P0 | PATCH | `/configs` | Change supported live configuration fields |
| P0 | GET/WS | `/traffic` | Current up/down rate and cumulative totals |
| P0 | GET/WS | `/connections` | Active connections, process metadata and totals |
| P0 | DELETE | `/connections/:id` | Close one connection |
| P0 | DELETE | `/connections` | Close all connections |
| P0 | GET/WS | `/logs` | Live logs |
| P1 | GET | `/proxies` | Nodes and policy groups |
| P1 | PUT | `/proxies/:group` | Select a group member |
| P1 | GET | `/proxies/:name/delay` | Test one node |
| P1 | GET | `/group/:name/delay` | Test members of a group |
| P1 | GET | `/rules` | Rule list and counters |
| P1 | GET | `/providers/proxies` | Subscription/provider metadata |
| P1 | PUT | `/providers/proxies/:name` | Update one proxy provider |
| P1 | GET | `/providers/proxies/:name/healthcheck` | Health-check a provider |
| P1 | GET | `/providers/rules` | Rule-provider metadata |
| P1 | PUT | `/providers/rules/:name` | Update one rule provider |
| P2 | GET | `/dns/query?name=&type=` | Diagnostic DNS query |
| P2 | POST | `/cache/dns/flush` | Flush DNS cache |
| P2 | POST | `/cache/fakeip/flush` | Flush fake-IP cache |
| P2 | GET/WS | `/memory` | Kernel memory telemetry |
| P2 | PUT | `/configs?force=true` | Reload full configuration |

Kernel and UI update endpoints must remain disabled until release signing, checksum verification and rollback are designed.

## Message shapes

### Traffic

`GET` or `WS /traffic`, approximately once per second:

```ts
interface TrafficMessage {
  up: number       // bytes per second
  down: number     // bytes per second
  upTotal: number  // cumulative bytes
  downTotal: number
}
```

Map directly to the two speed cards. Do not derive per-process rankings from this stream.

### Connections

`GET` or `WS /connections?interval=1000`:

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

Aggregations:

- Active connections: `connections.length`.
- Processes: normalized non-empty `metadata.process` or `processPath`.
- Domains: normalized `metadata.host`; fall back to destination IP only in the detail view.
- Policy: final/visible chain label according to a documented chain convention.
- Per-item usage: sum connection `upload + download` within the snapshot. This is active-connection volume, not permanent historical accounting.

Persistent daily/monthly totals require the application to store sampled deltas or consume another durable source. Do not label a non-durable snapshot as historical truth.

### Proxies and groups

`GET /proxies` returns an object keyed by proxy or group name. Common fields include `name`, `type`, `alive`, `history`, and capability flags. Groups additionally include `now`, `all`, `testUrl`, `hidden`, `icon`, and sometimes `fixed`.

Select a member:

```http
PUT /proxies/<percent-encoded-group-name>
Content-Type: application/json

{"name":"member name"}
```

Success is HTTP 204. Refetch that group or update optimistically and roll back on error.

Latency test:

```http
GET /proxies/<name>/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=5000&expected=204
```

Response: `{ "delay": 73 }`. Treat timeouts, zero and missing delay distinctly.

Group latency testing uses `GET /group/<name>/delay?...` and returns a map keyed by member name (`{ "香港 01": 42, "DIRECT": 6 }`). Members that failed or were not measured are omitted from the map (they are not written with a sentinel), so a missing key means "no latency available" and must be surfaced as unavailable — it is not a timeout. A whole-group timeout/probe failure returns HTTP 504/503 for the request itself.

### Running configuration

`GET /configs` returns a flexible object containing fields such as:

- `port`, `socks-port`, `mixed-port`
- `mode`: `rule`, `global`, or `direct`
- `log-level`
- `allow-lan`
- `ipv6`
- `tun`

Change only allowlisted fields through `PATCH /configs`. Full profile activation uses `PUT /configs?force=true` with `{ path, payload }` and must stay in main process. Paths outside the working directory may require upstream `SAFE_PATHS`; prefer keeping managed profiles inside the kernel working directory.

### Rules

`GET /rules` returns:

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

Temporary rule disabling exists through `PATCH /rules/disable`, keyed by rule index. It resets after restart; the UI must label it temporary.

### Logs

Use `WS /logs?level=info&format=structured` when supported. Structured messages contain `time`, `level`, `message`, and `fields`. Standard mode uses `type` and `payload`. The parser must accept both and cap the renderer buffer.

## WebSocket lifecycle

1. Connect only after `/version` health succeeds.
2. Include the bearer header in the upgrade request from Electron main.
3. Parse one JSON object per message.
4. Publish normalized samples to renderer subscribers through one IPC event per stream.
5. Keep one upstream socket regardless of the number of Vue components.
6. Retry network failures with jittered backoff: 250 ms, 500 ms, 1 s, 2 s, maximum 5 s.
7. Reset backoff after a stable 10-second connection.
8. Stop immediately on intentional kernel shutdown.

## Error mapping

| Condition | UI state |
|---|---|
| Connection refused | Kernel/controller unavailable |
| HTTP 401 | Controller secret mismatch; never display secret |
| HTTP 404 | Unsupported endpoint/version capability |
| HTTP 400/422 | Invalid requested config or node operation |
| HTTP 503 (delay test) | Node unreachable / unavailable |
| HTTP 504 (delay test) | Node latency timeout |
| WebSocket close during stop | Normal stopped state |
| Malformed JSON | Protocol error with redacted diagnostic log |
| Repeated crash/reconnect | Failed state with explicit retry action |

## Capability detection

At startup:

1. Read `/version`.
2. Read `/configs`.
3. Probe only optional endpoints needed for the visible page.
4. Cache capabilities for the current PID/version.
5. Hide or disable unsupported UI with an explanation; never assume every release has every documented field.
