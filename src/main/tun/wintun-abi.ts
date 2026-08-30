/**
 * Pinned Wintun release record + symbol-name contract.
 *
 * IMPORTANT — this module is NOT a verbatim ABI transcription. Where the ABI is
 * expressible purely as *names* (the pinned version, the DLL file name, the
 * exported-symbol set, the forbidden-symbol set) it is recorded here. Where the
 * ABI is *shape* (pointer-sized handles, `NET_LUID*` out-params, `BYTE*`
 * receive buffers, `GUID`, `BOOL`, `DWORD`, the `WINAPI`/`__stdcall` convention)
 * it is deliberately NOT re-declared as TypeScript function types. A hand-written
 * TS signature is a lossy guess and would be a false "verbatim ABI" contract.
 *
 * The ABI is owned by the NATIVE binding, not by TS:
 *
 * 1. The native seam (a future C/C++/Rust binding) `#include`s the pinned,
 *    official `wintun.h` verbatim — that single header is the only source of
 *    truth for the function signatures, the `WINAPI` calling convention, `GUID`
 *    layout, `NET_LUID`, `BOOL`/`DWORD` and the `HANDLE`/pointer sizes.
 * 2. Compile-time checks pin the layout to the header:
 *    - `static_assert(sizeof(NET_LUID) == 8)`
 *    - `static_assert(sizeof(GUID) == 16)` and the `Data4` byte-array layout
 *    - `static_assert(sizeof(WINTUN_ADAPTER_HANDLE) == sizeof(void*))` (pointer-sized)
 *    - `static_assert(sizeof(WINTUN_SESSION_HANDLE) == sizeof(void*))`
 *    - on x86, assert the functions are `__stdcall` (`WINAPI`); on amd64/arm64 the
 *      calling convention is unified and `WINAPI` is a no-op.
 * 3. A build-time export check loads the shipped per-arch `wintun.dll` and asserts
 *    (via the Windows module export table) that the exported names are EXACTLY
 *    `WINTUN_EXPORTED_SYMBOLS` — a missing or extra export fails the build. This is
 *    the non-negotiable signature identity of the pinned release.
 * 4. TS only ever talks to the native seam through the high-level, opaque
 *    `G1ProbeDriver` interface (`createAdapter(): OpaqueHandle`,
 *    `getCanonicalLuid(handle): string`, …) so no `GUID`/`NET_LUID`/pointer size
 *    is ever re-derived in JS.
 *
 * Until such a native binding exists, `g1-driver.ts` fails closed to
 * `unsupported`; the G1 gate remains UNEXECUTED / UNPROVEN.
 *
 * No value here performs I/O, loads a DLL or spawns a process. Nothing here runs
 * on the Linux/Mac dev host. @see docs/helper-design.md §3.0, §13
 */

/** The pinned Wintun release (drives the manifest hash + integrity check). */
export const WINTUN_PINNED_VERSION = '0.14.1' as const

/** The official per-arch DLL file name (bundled as wintun-<arch>.dll). */
export const WINTUN_DLL_NAME = 'wintun.dll' as const

/** The tunnel-type string Wintun accepts on all supported platforms. */
export const WINTUN_TUNNEL_TYPE = 'WireGuard' as const

export const WINTUN_VALID_TUNNEL_TYPES = [WINTUN_TUNNEL_TYPE] as const

/** A brand only — the real handle is an opaque native pointer carried by the binding. */
export type WintunOpaqueHandle = { readonly __wintunHandle: 'opaque' }

/**
 * The complete exported-symbol set of the pinned `wintun.dll` (0.14.1) that the
 * build-time export check asserts, exactly as the export table lists them. There
 * is **no `WintunDeleteAdapter`** and **no `WintunFreeSendPacket`** in 0.14.1.
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
 * Symbols that must never be referenced. `deleteDriver` is exported but FORBIDDEN
 * by D5 (a shared resource); `deleteAdapter` and `freeSendPacket` do not exist in
 * 0.14.1. A static check asserts neither is ever bound or invoked as a call site.
 */
export const WINTUN_FORBIDDEN_SYMBOLS = {
  deleteAdapter: 'WintunDeleteAdapter' as const,
  deleteDriver: 'WintunDeleteDriver' as const,
  freeSendPacket: 'WintunFreeSendPacket' as const
} as const
