# Sparra presentation audio candidate — 2 October 2026

Ready for Root's independent artifact review and external presentation integration. This task changed only this owned directory; it did not change App or Voice source, provider profiles, the current website, account privacy settings, browser state or deployment. The original fictional scenarios, disclosure, labels, contact disclaimers and illustrative receipts are unchanged byte-for-byte at the source and unchanged in the generated module. `integration-proof.json` confirms the exact existing exported type schema and two-file public directory.

The candidate uses `microsoft/mai-voice-2.1-flash`, with Sparra as stock native French `fr-FR-Soleil:MAI-Voice-2.1-Flash` and the fictional client as `fr-FR-Marc:MAI-Voice-2.1-Flash`. Current catalog discovery and the public ZDR endpoint list identify this exact model and Azure endpoint. No provider flags were sent, and the existing key-specific ZDR/no-training guardrail remained unchanged. No real caller audio or personal data was sent. [Speech catalog](https://openrouter.ai/api/v1/models?output_modalities=speech), [ZDR endpoint catalog](https://openrouter.ai/api/v1/endpoints/zdr), [TTS API](https://openrouter.ai/docs/guides/overview/multimodal/tts), [Guardrail ZDR semantics](https://openrouter.ai/docs/guides/features/zdr).

Exactly **10 TTS requests** succeeded once: HTTP200, audio/mpeg, bounded complete bodies, SHA256/time/size/content-type receipts and immutable success fences retained. The first exact Garage greeting returned146880bytes in1101ms; the other nine total HTTP observations ranged462–954ms. These are single request observations, not conversational or telephone latency measurements. The unchanged ten inputs total1010characters, so the current listed rate0.000015USD/character yields a theoretical TTS cost of **USD0.01515**. This is not an observed invoice; ASR costs were not measured. No Telnyx call or spend occurred. [Current model price](https://openrouter.ai/microsoft/mai-voice-2.1-flash).

| Final artifact | Duration | Bytes | SHA256 |
| --- | ---: | ---: | --- |
| `public/demos/garage-revision.mp3` |35.432s|284204|`76d6b25524b01b7512fe6797af8f07a8f83e8fa20e32d4d43337363e12839ca4`|
| `public/demos/controle-technique.mp3` |38.816s|311276|`ede5fc183311448da34ce3ca1b994e1e947523dd5e7fecb6346d577c0b20d49d`|

All ten admitted raw responses decoded as mono MP3, and all final outputs decoded completely. The producer converted each admitted turn to mono24kHz PCM, inserted measured0.35s silences, encoded MP3 mono24kHz/64kbps and removed metadata. No time stretching or speech-speed change was applied. `assemble-demos.ps1` exited0; the last cue ends agree exactly with the probed final durations. Heavy preflight recorded4.624GiB available physical memory and12.857GiB virtual memory. No concurrent build or browser test was run by this task.

| Scenario | Speaker | Start s | End s |
| --- | --- | ---: | ---: |
|Garage|Sparra|0|7.344|
|Garage|Client|7.694|12.878|
|Garage|Sparra|13.228|17.740|
|Garage|Client|18.090|24.810|
|Garage|Sparra|25.160|35.432|
|Contrôle technique|Sparra|0|6.744|
|Contrôle technique|Client|7.094|11.318|
|Contrôle technique|Sparra|11.668|18.364|
|Contrôle technique|Client|18.714|24.426|
|Contrôle technique|Sparra|24.776|38.816|

The whole final dialogues were converted to bounded mono16kHz PCM WAVs and submitted through the actual pinned Pipecat1.7 `OpenAISTTService._transcribe` and its AsyncOpenAI client serializer: French setting, normal TLS, trust_env=False, retries0, credential supplied only via process stdin. All **four deliberately identified ASR requests** received a transcript and their child processes exited0. The first two observations took4935/6157ms but their non-ASCII Python JSON was decoded lossily in the local Windows pipe. Those original successful receipts are retained with replacement characters; this was a local evidence transport defect, not a provider failure. Original raw output bytes were not retained and could not be recovered. Root authorized exactly two additional corrected-output witnesses, `unicode-readback-v2`, with prior receipt references and explicit new-request rationale. ASCII-escaped JSON preserved intact French text, taking4098/4430ms. No unknown attempt was retried or reclassified.

The intact transcripts contain the AI-agent disclosure, both fictional client names and number disclaimers, tomorrow morning as a Garage callback preference, Friday afternoon as a CT preference, team confirmation, and the no-confirmed/no-reserved appointment clauses. They are not exact verbatim listening evidence: the recognizer spells Sparra as Spara and Centre Clair as Centre Claire, includes an extra “Merci” and a repeated client sentence in Garage, and inserts punctuation in CT. The source scripts were never rewritten to fit the recognizer. These artifacts provide content evidence and distinguish the two supplied French voice IDs; **human perception of near-human naturalness remains unverified**, and this task does not certify real calls, PCMU8k, interruptions or provider/carrier integration.

Root integration inputs are the root-level `demo-scenarios.generated.ts` and this directory's `public/` containing only the two MP3s. Root can narrowly alias the existing demo module import in the external presentation wrapper; no widget or App source change is needed. Current live demo payload and rollback remain untouched by this task. Browser playback, Vite build, deployment and independent review are Root's subsequent gates.

Audit inputs: `catalog-model.json`, `zdr-endpoints.json`, `scenario-source.json`, `generation-summary.json`, `audio-provenance.json`, `integration-proof.json`, `final-receipt.json`, `unicode-recovery-assessment.json`, the ten `segments/*.json` plus ten immutable `known-successes/*.json`, and the four separately named `*content-proof*.json` receipts. All scripts and reports contain no credential values or raw credential-bearing errors.
