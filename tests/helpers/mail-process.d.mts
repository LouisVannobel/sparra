export const MAIL_CLEANUP_CODES: readonly string[]
export function classifyMailCleanup(error: unknown): string[]

interface MailCleanupDiagnostic {
  type: 'fixture-mail-cleanup'
  outcome: 'FULFILLED' | 'REJECTED'
  codes: string[]
}
interface MailCleanupClient<Value> {
  dispose(...args: never[]): Promise<Value>
}
interface MailCleanupFactory<Value> {
  init(...args: never[]): MailCleanupClient<Value>
}
export function installMailCleanupObserver<Value>(factory: MailCleanupFactory<Value>, emit: (event: MailCleanupDiagnostic) => void): void
