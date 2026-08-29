/**
 * Pinned Wintun ABI — the single source of record.
 *
 * The function-pointer `typedef`s, calling convention, handle types and
 * exported-symbol set below are copied verbatim from the official `wintun.h` of
 * the pinned release (Wintun **0.14.1**; wintun.net / git.zx2c4.com/wintun).
 * See docs/helper-design.md §3.0. Per design policy we DO NOT hand-declare any
 * symbol: this file mirrors the official header and the build-time ABI check
 * (§3.0 / §13) resolves each exported `Wintun*` symbol in the shipped
 * `wintun.dll` and asserts its name set matches `WINTUN_EXPORTED_SYMBOLS`
 * exactly (a mismatch fails the build — no runtime fallback).
 *
 * No value in this file performs I/O, loads a DLL, or spawns a process. The
 * actual cross-process/Windows binding is injected by the G1 driver
 * (`g1-driver.ts`). Nothing here ever runs on the Linux/Mac dev host.
 */

/** The pinned Wintun release (drives the manifest hash + integrity check). */
export const WINTUN_PINNED_VERSION = '0.14.1' as const

/** The official per-arch DLL file name (bundled as wintun-<arch>.dll). */
export const WINTUN_DLL_NAME = 'wintun.dll' as const

/** The tunnel-type string Wintun accepts on all supported platforms. */
export const WINTUN_TUNNEL_TYPE = 'WireGuard' as const

/** Opaque adapter handle. Do not reinterpret; treat as an opaque pointer. */
export type WintunAdapterHandle = number
/** Opaque packet session handle. Do not reinterpret; treat as an opaque pointer. */
export type WintunSessionHandle = number
/** `NET_LUID` is a 64-bit value. We carry it as a bigint (never a float). */
export type WintunNetLuid = bigint
/** `BOOL` return. */
export type WintunBool = boolean
/** `DWORD` return. */
export type WintunDword = number
/** A Win32 `HANDLE` (wait event). */
export type WintunHandle = number

/**
 * `GUID` as a 16-byte structure. We model it as the four `DWORD`/`WORD` fields
 * the header lays out so the conversion to/from a canonical GUID string stays
 * explicit and endianness-aware. `null` = "system-assigned GUID".
 */
export interface WintunGuid {
  data1: number
  data2: number
  data3: number
  data4: [number, number, number, number, number, number, number, number]
}

/**
 * `WINTUN_LOGGER_CALLBACK` — the logger Wintun invokes with a level prefix and
 * a null-terminated message. Captured only for the ABI record; the G1 probe
 * installs nothing (logging is a product, not a probe, concern).
 */
export type WintunLoggerCallback = (level: number, message: string) => void

// ---------------------------------------------------------------------------
// Function-pointer typedefs (verbatim from the official 0.14.1 wintun.h).
// The `WINAPI` (__stdcall) calling convention is a runtime/binding concern; the
// exported DLL symbols are resolved by name via GetProcAddress. We type each as
// a plain function signature whose shape matches the header.
// ---------------------------------------------------------------------------

/** Creates a new Wintun adapter. Returns a handle or NULL; release with WintunCloseAdapter. */
export type WintunCreateAdapterFn = (
  name: string,
  tunnelType: string,
  requestedGuid: WintunGuid | null
) => WintunAdapterHandle

/** Opens an existing Wintun adapter by name. Returns a handle or NULL. */
export type WintunOpenAdapterFn = (name: string) => WintunAdapterHandle

/** Releases adapter resources; for a CreateAdapter-created adapter, also removes it. */
export type WintunCloseAdapterFn = (adapter: WintunAdapterHandle) => void

/**
 * Deletes the Wintun driver if no adapters are in use. Exported — but the
 * production policy FORBIDS calling it (D5): a shared system resource other
 * Wintun consumers may rely on. This type exists only so the ABI record is
 * complete; the built driver never binds it and never invokes it.
 */
export type WintunDeleteDriverFn = () => WintunBool

/** Writes the adapter's NET_LUID. */
export type WintunGetAdapterLuidFn = (adapter: WintunAdapterHandle, luid: WintunNetLuid) => void

/** Returns the running Wintun driver version as a DWORD. */
export type WintunGetRunningDriverVersionFn = () => WintunDword

/** Installs a logger callback. */
export type WintunSetLoggerFn = (callback: WintunLoggerCallback) => void

/** Starts a packet session with the given packet capacity. */
export type WintunStartSessionFn = (adapter: WintunAdapterHandle, capacity: number) => WintunSessionHandle

/** Ends a packet session. */
export type WintunEndSessionFn = (session: WintunSessionHandle) => void

/** Returns the read-wait HANDLE for a session. */
export type WintunGetReadWaitEventFn = (session: WintunSessionHandle) => WintunHandle

/** Receives a packet. */
export type WintunReceivePacketFn = (session: WintunSessionHandle, packetSize: number) => [number, number]

/** Releases a received packet. */
export type WintunReleaseReceivePacketFn = (session: WintunSessionHandle, packet: number) => void

/** Allocates a send packet. */
export type WintunAllocateSendPacketFn = (session: WintunSessionHandle, packetSize: number) => number

/** Sends a packet. */
export type WintunSendPacketFn = (session: WintunSessionHandle, packet: number) => void

/**
 * The complete exported-symbol set of the pinned `wintun.dll` (0.14.1) that the
 * build-time ABI check asserts, exactly as the export table lists them. There is
 * **no `WintunDeleteAdapter`** and **no `WintunFreeSendPacket`** in 0.14.1 —
 * either must never appear in our code, ABI record or call sites.
 */
export const WINTUN_EXPORTED_SYMBOLS = [
  'WintunCreateAdapter',
  'WintunOpenAdapter',
  'WintunCloseAdapter',
  'WintunDeleteDriver',
  'WintunGetAdapterLUID',
  'WintunGetRunningDriverVersion',
  'WintunSetLogger',
  'WintunStartSession',
  'WintunEndSession',
  'WintunGetReadWaitEvent',
  'WintunReceivePacket',
  'WintunReleaseReceivePacket',
  'WintunAllocateSendPacket',
  'WintunSendPacket'
] as const

/**
 * Symbols that must never be referenced (they do not exist in 0.14.1, or are
 * exported but forbidden). A static check asserts the probe/driver never binds
 * nor invokes `WintunDeleteDriver`, and that `WintunDeleteAdapter` never even
 * appears as an identifier anywhere in the repository.
 */
export const WINTUN_FORBIDDEN_SYMBOLS = {
  deleteAdapter: 'WintunDeleteAdapter' as const,
  deleteDriver: 'WintunDeleteDriver' as const,
  freeSendPacket: 'WintunFreeSendPacket' as const
} as const

/**
 * The product adapter name and fixed RequestedGUID are supplied at runtime
 * (never hard-coded here). The operating adapter identity is
 * `RequestedGUID + Name`, and the wire identity is the associated `NET_LUID`.
 */
export const WINTUN_VALID_TUNNEL_TYPES = [WINTUN_TUNNEL_TYPE] as const
