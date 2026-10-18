import { main } from './mail-retry-harness'

void main(process).catch(() => { process.exitCode = 1; if (process.connected) { process.send?.({ type: 'fatal' }); process.disconnect?.() } })
