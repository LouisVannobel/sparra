// UI-contract doubles only. This mounts the real panel, not a native auth/session consumer.
import { createRoot } from 'react-dom/client'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { FirstGooglePasskeyPanel } from '../../src/ui/auth/first-google-passkey-panel'
import type { FirstGoogleStatus } from '../../src/modules/auth/first-google-passkey.server'
import '../../src/ui/auth/auth.css'

const mode = new URL(location.href).searchParams.get('mode')
if (!['read', 'finish', 'cancel'].includes(mode ?? '')) throw new Error('Invalid owned panel case')
const intentId = 'f1307f5a-34b8-48e4-a62e-9b86d38746e0', expiresAt = new Date(Date.now() + 300000).toISOString()
const calls = { read: 0, prepare: 0, finish: 0, cancel: 0, refresh: 0 }
let added = mode === 'read'
let confirmedSignal: AbortSignal | undefined, refreshSignalMatches = false, refreshSignalLive = false
const status = (): FirstGoogleStatus => ({ intentId, state: added ? 'added' : 'authorized', expiresAt, reason: null })
Reflect.set(window, '__firstPanelFixture', () => ({ ...calls, added, refreshSignalMatches, refreshSignalLive }))
const node = document.getElementById('root')
if (!node) throw new Error('Owned panel root missing')
createRoot(node).render(<Theme theme={neutralTheme} mode="light"><FirstGooglePasskeyPanel locale="en" userId="mounted-ui-fixture" available intentId={intentId}
  onBegin={async () => { throw new Error('This fixture never begins OAuth') }}
  onRead={async (_input, signal) => { calls.read++; confirmedSignal = signal; return status() }}
  onPrepare={async () => {
    calls.prepare++
    return { intentId, expiresAt, options: { challenge: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA', rp: { id: 'localhost', name: 'Mounted UI fixture' },
      user: { id: 'AQID', name: 'UI fixture', displayName: 'UI fixture' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, attestation: 'none' } }
  }}
  onFinish={async (_input, signal) => { calls.finish++; added = true; confirmedSignal = signal; return { added: true } }}
  onCancel={async (_input, signal) => { calls.cancel++; added = true; confirmedSignal = signal; return status() }}
  onAdded={async signal => { calls.refresh++; refreshSignalMatches = signal === confirmedSignal; refreshSignalLive = signal instanceof AbortSignal && !signal.aborted; throw new Error('Controlled ancillary refresh rejection') }}
/></Theme>)
