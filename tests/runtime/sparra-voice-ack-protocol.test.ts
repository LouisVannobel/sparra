// Observer transport only: a real Node child emits controlled protocol messages.
// This does not construct a Voice graph or manufacture a PostgreSQL ACK.
import { expect, test, vi } from 'vitest'

vi.mock('node:child_process', async importOriginal => {
  const native = await importOriginal<typeof import('node:child_process')>()
  return { ...native, spawn: () => native.spawn(process.execPath, ['--input-type=module', '-e', `
    import { createInterface } from 'node:readline';
    const lines = createInterface({ input: process.stdin });
    const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
    let fixtures = [];
    lines.on('line', line => {
      const { action, recovery_case } = JSON.parse(line);
      if (action === 'connected') {
        fixtures = recovery_case ? JSON.parse(recovery_case) : [];
        emit({ ready: true, candidate: true });
      }
      if (action === 'fixture-events') {
        for (const value of fixtures) emit(value);
        setImmediate(() => emit({ revision: 7, unknown_slot: 'preserved' }));
      }
      if (action === 'audio-erasure-held') {
        emit({ audio_ack_refusal: {
          condition: 'native_capture_event_joined_before_ack', error_class: 'AssertionError'
        } });
        // Cleanup/retry success arrives after the refusal, in another event-loop turn.
        setImmediate(() => emit({ writer_cleaned: true, ack_held: true }));
      }
      if (action === 'audio-release-ack') emit({ cleaned: true, ack_before_scrub: false });
      if (action === 'stop') emit({ stopped: true });
    });
  `], { windowsHide: true }) }
})

const terminal = { outbox_empty: true, terminal_present: true, terminal_bounded: true,
  terminal_known_acked: true, terminal_cipher_present: false, terminal_metadata_only: true,
  terminal_identity_exact: true, retention_original_30d: true }
const admission = { same_call_id: true, generation_present: true, same_admitted_created: true, retention_30d: true }
const transferFacts = { admission_closed: true, event_joined: true, receipt_joined: true,
  tail_committed: true, submitted_committed: true, finish_transfer_committed: true, original_retention: true }
const transfer = { before_intent: transferFacts, sdk_entry: { ...transferFacts, intent_committed: true, fixed_target: true } }
const serverJoin = { connections: 1, tasks: 1, owner_present: true, owner_closed: false,
  owner_task_done: false, owner_phase: 'finishing',
  stacks: [{ done: false, frames: [{ file: 'native-code', function: 'native-code', line: 0 }] }],
  connection_states: [{ protocol: 'WebSocketProtocol', closing: false, write_buffer_bytes: 0, tls: false }] }

function protocol(events: unknown[], audio = true, transferFixture = true) {
  return startConnectedVoice({ url: 'fixture-only', keyring_path: 'fixture-only',
    evidence_path: 'fixture-only', state_path: 'fixture-only', recovery_case: JSON.stringify(events),
    ...(audio ? { audio_candidate: true as const } : {}),
    ...(transferFixture ? { audio_transfer_fixture: true as const } : {}) })
}

test('validated diagnostic categories leave response slots and native close observation intact (protocol only)', async () => {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
  const voice = protocol([{ transfer_boundary: transfer }, { server_join_guard: serverJoin },
    { audio_terminal_guard: terminal }, { admission_guard: admission },
    { phase: 'native-close-completed', peak_rss_kib: 0, elapsed_ms: 0 }])
  try {
    await voice.ready
    expect(await voice.command('fixture-events')).toMatchObject({ revision: 7, unknown_slot: 'preserved' })
    expect(voice.nativeCloseCompleted()).toBe(true)
    expect(logs.mock.calls.map(([line]) => line)).toEqual([
      'PAIRED_TRANSFER_BOUNDARY ' + JSON.stringify(transfer),
      'PAIRED_SERVER_JOIN_GUARD ' + JSON.stringify(serverJoin),
      'PAIRED_AUDIO_TERMINAL_GUARD ' + JSON.stringify(terminal),
      'PAIRED_ADMISSION_GUARD ' + JSON.stringify(admission),
      expect.stringMatching(/^PAIRED_VOICE_PHASE native-close-completed elapsed_ms=\d+ peak_rss_kib=0 python_elapsed_ms=0$/),
    ])
    expect(await voice.stop()).toEqual({ code: 0, signal: null })
  } finally { await voice.cleanup(); logs.mockRestore() }
})

test.each([
  ['transfer extra slot', { transfer_boundary: { ...transfer, unknown: true } }],
  ['transfer missing fact', { transfer_boundary: { ...transfer, before_intent: {} } }],
  ['transfer nonboolean fact', { transfer_boundary: { ...transfer, sdk_entry: { ...transfer.sdk_entry, fixed_target: 'private-marker' } } }],
  ['server unknown owner phase', { server_join_guard: { ...serverJoin, owner_phase: 'private-marker' } }],
  ['server counter over bound', { server_join_guard: { ...serverJoin, connections: 65536 } }],
  ['server counter negative', { server_join_guard: { ...serverJoin, tasks: -1 } }],
  ['server counter fractional', { server_join_guard: { ...serverJoin, tasks: 0.5 } }],
  ['server owner nonboolean', { server_join_guard: { ...serverJoin, owner_closed: 'private-marker' } }],
  ['server unknown connection protocol', { server_join_guard: { ...serverJoin, connection_states: [{ ...serverJoin.connection_states[0], protocol: 'private-marker' }] } }],
  ['server connection negative bytes', { server_join_guard: { ...serverJoin, connection_states: [{ ...serverJoin.connection_states[0], write_buffer_bytes: -1 }] } }],
  ['server stack nonboolean completion', { server_join_guard: { ...serverJoin, stacks: [{ done: 1, frames: [] }] } }],
  ['server private filename', { server_join_guard: { ...serverJoin, stacks: [{ done: false, frames: [{ file: '/private-marker.py', function: 'safe', line: 1 }] }] } }],
  ['server private function', { server_join_guard: { ...serverJoin, stacks: [{ done: false, frames: [{ file: 'safe.py', function: 'private-marker()', line: 1 }] }] } }],
  ['server negative frame line', { server_join_guard: { ...serverJoin, stacks: [{ done: false, frames: [{ file: 'safe.py', function: 'safe', line: -1 }] }] } }],
  ['terminal unknown slot', { audio_terminal_guard: { ...terminal, unknown: true } }],
  ['terminal nonboolean fact', { audio_terminal_guard: { ...terminal, terminal_present: 'private-marker' } }],
  ['admission missing fact', { admission_guard: { same_call_id: true } }],
  ['admission nonboolean fact', { admission_guard: { ...admission, retention_30d: 'private-marker' } }],
  ['ACK unknown condition', { audio_ack_refusal: { condition: 'private-marker', error_class: 'AssertionError' } }],
  ['ACK unknown class', { audio_ack_refusal: { condition: 'native_ack_failure', error_class: 'private-marker' } }],
  ['ACK extra slot', { audio_ack_refusal: { condition: 'native_ack_failure', error_class: 'AssertionError', unknown: true } }],
  ['phase unknown', { phase: 'private-marker' }],
  ['phase negative memory', { phase: 'graph-build', peak_rss_kib: -1 }],
  ['phase noninteger elapsed', { phase: 'graph-build', elapsed_ms: 0.5 }],
])('%s is rejected before unvalidated content reaches logs (protocol only)', async (_name, event) => {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
  const voice = protocol([event])
  try {
    await voice.ready
    await expect(voice.command('fixture-events')).rejects.toThrow('Connected Voice invalid fixture output')
    expect(logs).not.toHaveBeenCalled()
  } finally { await voice.cleanup(); logs.mockRestore() }
})

test.each([
  [{ phase: 'graph-build' }], [{ transfer_boundary: transfer }], [{ server_join_guard: serverJoin }],
  [{ audio_terminal_guard: terminal }], [{ admission_guard: admission }],
  [{ audio_ack_refusal: { condition: 'native_ack_failure', error_class: 'AssertionError' } }],
])('audio diagnostics require the audio candidate (%j, protocol only)', async event => {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
  const voice = protocol([event], false)
  try {
    await voice.ready
    await expect(voice.command('fixture-events')).rejects.toThrow('Connected Voice invalid fixture output')
    expect(logs).not.toHaveBeenCalled()
  } finally { await voice.cleanup(); logs.mockRestore() }
})

test('transfer boundary requires its separately admitted fixture (protocol only)', async () => {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
  const voice = protocol([{ transfer_boundary: transfer }], true, false)
  try {
    await voice.ready
    await expect(voice.command('fixture-events')).rejects.toThrow('Connected Voice invalid fixture output')
    expect(logs).not.toHaveBeenCalled()
  } finally { await voice.cleanup(); logs.mockRestore() }
})

import { startConnectedVoice } from '../helpers/sparra-voice-driver'

test('ACK observer refusal remains fatal after controlled cleanup retry and physical stopped success (protocol only)', async () => {
  const voice = startConnectedVoice({ url: 'fixture-only', keyring_path: 'fixture-only',
    evidence_path: 'fixture-only', state_path: 'fixture-only', audio_candidate: true })
  try {
    expect(await voice.ready).toMatchObject({ ready: true, candidate: true })
    const held = await Promise.allSettled([voice.command('audio-erasure-held')])
    const retried = await Promise.allSettled([voice.command('audio-release-ack')])
    const stopped = await Promise.allSettled([voice.stop()])
    // The process really exited normally; failure must be the sticky refusal,
    // rather than a forced kill, missing stopped message or process failure.
    expect(await voice.cleanup()).toEqual({ code: 0, signal: null })
    for (const [outcome] of [held, retried, stopped]) {
      expect(outcome.status).toBe('rejected')
      if (outcome.status !== 'rejected') throw new Error('Observer refusal was discarded')
      expect(outcome.reason).toBeInstanceOf(Error)
      expect(outcome.reason.message).toContain('Connected Voice ACK invariant refused')
    }
  } finally { await voice.cleanup() }
})
