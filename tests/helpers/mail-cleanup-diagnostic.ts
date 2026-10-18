export interface MailCleanupDiagnostic {
  outcome: 'FULFILLED' | 'REJECTED'
  codes: string[]
}

export function decodeMailCleanupDiagnostic(message: unknown, allowedCodes: readonly string[]): MailCleanupDiagnostic | null {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'fixture-mail-cleanup' ||
    !('outcome' in message) || message.outcome !== 'FULFILLED' && message.outcome !== 'REJECTED' ||
    !('codes' in message) || !Array.isArray(message.codes) || message.codes.length > allowedCodes.length) return null
  const codes: string[] = []
  for (const code of message.codes) {
    if (typeof code !== 'string' || !allowedCodes.includes(code)) return null
    codes.push(code)
  }
  return { outcome: message.outcome, codes }
}
