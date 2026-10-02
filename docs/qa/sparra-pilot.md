# Sparra pilot qualification

The connected fixture exercises the adopted application and Voice runtime with
fictional caller data and generated keys. It runs the compiled TanStack server
and browser, native Google protocol flow, owned PostgreSQL/PgBouncer stores,
signed Telnyx webhooks, loopback TLS/WSS and pinned Pipecat services. Controlled
HTTP peers supply provider responses; this does not qualify live speech or a
public telephone deployment.

## Reproduce the connected gate

Use the adopted Voice checkout at
`C:/Users/louis/Documents/ChatGPT/.worktrees/sparra-voice-pilot`, with its frozen
Python environment. Build this application with `pnpm build`, then run:

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/sparra-voice-connected.test.ts --maxWorkers=1
```

Only one heavy worker may run. Before starting, verify at least 2 GiB available
physical memory and 6 GiB available virtual memory. The fixture owns and removes
its containers, network, browser, child processes and temporary key/state
directory. The strict before/after inventory equality guard must pass; a test
assertion pass with a failed cleanup guard remains a failed gate. Its diagnostic
emits only resource IDs, categories, changed field names and ownership.

The helper preserves existing single-request bridge consumers and adds a bounded
newline transport for this connected scenario. The Voice scenario is test-only;
native auth, SQL functions, writer, cryptography, call ownership and service
consumers remain authoritative.

## Required observations

- Actual captured, individually valid turns reach the encrypted-map limit with
  fewer than 200 turns. PostgreSQL JSONB bytes agree with the native budget;
  exact fit, one-more loss and compact-versus-spaced overhead are distinguished.
  Restart/replay preserves retained IDs, ciphertext, loss and the first result.
  Authenticated EN/FR detail displays result quality and captured-turn loss
  separately; another native principal cannot read or treat the call.
- The original configuration revision remains pinned through owner edits. A
  real Workspace lock serializes begin and save before the provider answer.
- Erasure removes local content before the actual local ACK. Genuine signed
  recording callbacks retain correlation validation and replay behavior; actual
  recording deletion and both SQL NULL acknowledgments precede the joined
  owner completion receipt. Late content returns PV301 and unrelated FIFO
  delivery continues.
- In-flight begin holders are scrubbed before ACK. Held erasure leases and a
  backlog larger than the native batch preserve unknown disposition, original
  generation and telephone capacity across restart, with no new AI or original
  hangup. A real PV301 callback cannot bypass a replacement queue claim.
- Untrusted tool arguments cannot choose the transfer destination. A committed
  target initiation and duplicate acknowledge without another AI admission.
  Command acknowledgment and wrong-leg bridge do not imply connection; the
  correlated bridge stops new AI/capture without inventing a telephone end.
  Only actual original hangup releases its capacity.
- Expired content is unavailable to its owner and discarded before the stale
  FIFO age gate without degrading an unrelated frozen native operation.

The expiry witness advances only the native relay FIFO clock after real SQL
expiry and owner denial. It checks actual queue ages and unchanged frozen
payload bytes. Readiness keeps its real clock, 900-second threshold and loops;
this does not prove availability for an aged live queue. An expired fence may
be absent before the sweep or collected after its original retention plus
900-second replay boundary. Its browser may therefore show unavailable or a
factual receipt. The ordinary owner-erasure witness separately requires joined
completion after both actual acknowledgments.

Non-sensitive JSON and browser screenshots are written outside `.output`, under
the Voice ignored Task5 workspace's `task-5-evidence` directory. The report and
terminal logs there distinguish failed attempts from the final covering gate.

## Operator acceptance still required

Before a real pilot, qualify the dedicated France application/state/backup and
public TLS/WSS ingress, exact images/roles/secret delivery, real Google account,
provider privacy configuration, French DID forwarding and the USD 5 pilot cap.
Use fictional audio first to verify native STT/TTS format, French disclosure,
latency, interruption and qualified-line transfer behavior. Then verify a real
call appears in the correct Workspace after reload, can be treated, and reaches
honest joined erasure completion. Preserve operator evidence separately from
the controlled local fixture; prerecorded public demos do not satisfy this gate.
