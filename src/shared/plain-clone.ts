/**
 * Renderer→main IPC payloads must survive Electron's structured clone, which
 * rejects Vue reactivity Proxies with "An object could not be cloned". A model
 * that passes through Pinia or `reactive()` carries Proxies even after a
 * shallow spread, so every model argument handed to `window.desktop` goes
 * through this JSON round-trip first. Model payloads are JSON-shaped plain
 * data by contract (strings, numbers, booleans, arrays, plain objects), which
 * makes the round-trip lossless for them; do not use it for binary payloads.
 */
export function plainJsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
