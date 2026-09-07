const SENSITIVE_KEY = /(access[_-]?token|api[_-]?key|authorization|cookie|password|secret|token)/i

/** Best-effort credential masking shared by renderer exports and disk logs. */
export function redactLogText(input: string): string {
  let text = input
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
  text = text.replace(/([?&])([^=&\s]+)=([^&\s]*)/g, (match, separator: string, key: string) =>
    SENSITIVE_KEY.test(key) ? `${separator}${key}=[REDACTED]` : match
  )
  text = text.replace(/\b((?:authorization|cookie)|[\w-]*(?:token|secret|password|api[_-]?key)[\w-]*)\s*[:=]\s*([^&\s,;]+)/gi, '$1=[REDACTED]')
  text = text.replace(/\b(https?:\/\/)([^/@\s]+)@/gi, '$1[REDACTED]@')
  // Generated mihomo controller secrets are fixed-width lowercase hex. Mask
  // them even when an upstream error omitted the key name.
  text = text.replace(/\b[0-9a-f]{64}\b/gi, '[REDACTED]')
  return text
}
