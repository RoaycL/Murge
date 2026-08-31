import type { AppInfo } from '@shared/app-info'
import type { BrandConfig } from '@shared/brand'
import type { KernelStatus } from '@shared/runtime'
import type { StartupStatus } from '@shared/startup'
import type { SystemProxyStatus } from '@shared/system-proxy'
import type { TunStatus } from '@shared/tun'

export interface DiagnosticInput {
  brand: BrandConfig
  app: AppInfo
  kernel: KernelStatus | null
  systemProxy: SystemProxyStatus | null
  startup: StartupStatus | null
  tun: TunStatus | null
  kernelVersion: string | null
}

/** Explicit allowlist: never include controller URLs, paths, profile names, logs, secrets or raw errors. */
export function serializeDiagnosticBundle(input: DiagnosticInput, now = new Date()): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    product: { name: input.brand.productName, appId: input.brand.appId, version: input.app.version },
    environment: { platform: input.app.platform, arch: input.app.arch },
    kernel: { phase: input.kernel?.phase ?? 'unavailable', version: input.kernelVersion ?? input.kernel?.version ?? null },
    systemProxy: { supported: input.systemProxy?.supported ?? false, phase: input.systemProxy?.phase ?? 'unavailable' },
    startup: { supported: input.startup?.supported ?? false, enabled: input.startup?.enabled ?? false, phase: input.startup?.phase ?? 'unavailable' },
    tun: { supported: input.tun?.supported ?? false, phase: input.tun?.phase ?? 'unavailable' }
  }, null, 2) + '\n'
}
