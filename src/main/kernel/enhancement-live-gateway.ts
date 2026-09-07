import type { DnsEnhancement, DnsSnapshot } from '@shared/dns'
import type { SnifferEnhancement, SnifferSnapshot } from '@shared/sniffer'
import type { GeodataSettings } from '@shared/geodata'
import type { DnsEnhancementGateway, GeodataSettingsGateway, SnifferEnhancementGateway } from '@shared/gateways'

type EnhancementSnapshot<T> = { enhancement: T }

interface PersistedEnhancementGateway<T, S extends EnhancementSnapshot<T>> {
  get(): S | Promise<S>
  set(input: T): S | Promise<S>
}

/**
 * One shared transaction boundary for DNS, sniffer and geodata mutations. Persist, apply
 * and rollback stay serialized with TUN/kernel transitions supplied by the
 * composition root, so the UI never reports a setting that the live core
 * rejected.
 */
export class EnhancementApplyCoordinator {
  constructor(
    private readonly runExclusive: <T>(operation: () => Promise<T>) => Promise<T>,
    private readonly apply: () => Promise<void>
  ) {}

  update<T, S extends EnhancementSnapshot<T>>(
    gateway: PersistedEnhancementGateway<T, S>,
    input: T
  ): Promise<S> {
    return this.runExclusive(async () => {
      const previous = await gateway.get()
      const next = await gateway.set(input)
      try {
        await this.apply()
        return next
      } catch (error) {
        await gateway.set(previous.enhancement)
        // The failed candidate is normally rejected before application. Still
        // re-apply the restored model so partial controller failures cannot leave
        // persistence and the running core divergent.
        await this.apply().catch(() => undefined)
        throw error
      }
    })
  }

  replace<T>(
    read: () => T | Promise<T>,
    write: (input: T) => T | Promise<T>,
    input: T
  ): Promise<T> {
    return this.runExclusive(async () => {
      const previous = await read()
      const next = await write(input)
      try {
        await this.apply()
        return next
      } catch (error) {
        await write(previous)
        await this.apply().catch(() => undefined)
        throw error
      }
    })
  }
}

export class LiveDnsEnhancementGateway implements DnsEnhancementGateway {
  constructor(
    private readonly inner: DnsEnhancementGateway,
    private readonly coordinator: EnhancementApplyCoordinator
  ) {}

  get(): DnsSnapshot | Promise<DnsSnapshot> { return this.inner.get() }
  set(input: DnsEnhancement): Promise<DnsSnapshot> { return this.coordinator.update(this.inner, input) }
  preview(input: DnsEnhancement): string | Promise<string> { return this.inner.preview(input) }
}

export class LiveSnifferEnhancementGateway implements SnifferEnhancementGateway {
  constructor(
    private readonly inner: SnifferEnhancementGateway,
    private readonly coordinator: EnhancementApplyCoordinator
  ) {}

  get(): SnifferSnapshot | Promise<SnifferSnapshot> { return this.inner.get() }
  set(input: SnifferEnhancement): Promise<SnifferSnapshot> { return this.coordinator.update(this.inner, input) }
  preview(input: SnifferEnhancement): string | Promise<string> { return this.inner.preview(input) }
}

/** Apply geodata changes immediately and roll persistence back if mihomo rejects them. */
export class LiveGeodataSettingsGateway implements GeodataSettingsGateway {
  constructor(
    private readonly inner: GeodataSettingsGateway,
    private readonly coordinator: EnhancementApplyCoordinator
  ) {}

  get(): GeodataSettings | Promise<GeodataSettings> { return this.inner.get() }
  set(input: GeodataSettings): Promise<GeodataSettings> {
    return this.coordinator.replace(
      () => this.inner.get(),
      (value) => this.inner.set(value),
      input
    )
  }
  preview(input: GeodataSettings): string | Promise<string> { return this.inner.preview(input) }
}
