/**
 * mihomo reports `connections[].chains` from the selected exit back toward the
 * outer policy group. User-facing routing paths read naturally in the opposite
 * direction: policy group -> nested group -> exit node.
 */
export function connectionChainHops(chains: readonly string[]): string[] {
  return [...chains].reverse()
}

export function formatConnectionChain(chains: readonly string[]): string {
  const hops = connectionChainHops(chains)
  return hops.length ? hops.join(' → ') : 'DIRECT'
}
