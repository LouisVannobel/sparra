// Observer transport only: a real Node child emits controlled protocol messages.
// This does not construct a Voice graph or manufacture a PostgreSQL ACK.
import { expect, test, vi } from 'vitest'

vi.mock('node:child_process', async importOriginal => {
  const native = await importOriginal<typeof import('node:child_process')>()
  return { ...native, spawn: () => native.spawn(process.execPath, ['--input-type=module', '-e', `
    import { createInterface } from 'node:readline';
    const lines = createInterface({ input: process.stdin });
    const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
    lines.on('line', line => {
      const { action } = JSON.parse(line);
      if (action === 'connected') emit({ ready: true, candidate: true });
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
