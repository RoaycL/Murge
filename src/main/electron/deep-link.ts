import { brand } from '@shared/brand'

/**
 * Deep-link (murge://...) plumbing for the Electron shell — pure, Electron-free
 * logic split out of the window adapter so the registration/delivery contract
 * is unit-testable (Phase 1 boundary).
 */

/**
 * Extract the `murge://...` deep link (or any `brand.protocolScheme` link)
 * from a launch argv. Extracted verbatim from the former monolithic
 * `src/main/index.ts`.
 */
export function extractDeepLink(argv: readonly string[]): string | null {
  const prefix = `${brand.protocolScheme}://`
  return argv.find((arg) => arg.startsWith(prefix)) ?? null
}

export interface DeepLinkQueue {
  /** Deep links that arrived before the window existed; flushed by the UI later. */
  readonly pending: string[]
  /** Extract + queue a link from an argv array. Returns the link when found. */
  pushFromArgv(argv: readonly string[]): string | null
}

/**
 * Deep links that arrive before the window exists, or while a second instance
 * hands its argv over, are queued here and flushed once the renderer is up.
 * The Phase 7 milestone decides how the UI reacts; this phase only guarantees
 * the registration and delivery plumbing never loses a link.
 */
export function createDeepLinkQueue(): DeepLinkQueue {
  const pending: string[] = []
  return {
    pending,
    pushFromArgv(argv: readonly string[]): string | null {
      const link = extractDeepLink(argv)
      if (link) pending.push(link)
      return link
    }
  }
}
