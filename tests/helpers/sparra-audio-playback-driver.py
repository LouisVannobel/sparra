"""Owned reader fixture: real Voice V2 codec and PostgreSQL RPCs, no provider I/O."""
import asyncio
import base64
import importlib.metadata
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4


async def produce(request):
    source = Path(request["source_root"])
    assert source.resolve() == source
    assert Path(sys.prefix).resolve() == source.parent / ".venv"
    assert sys.version_info[:3] == (3, 13, 15)
    sys.path.insert(0, str(source))
    for name, version in {"cryptography": "50.0.0", "pydantic": "2.13.4", "psycopg": "3.3.4"}.items():
        assert importlib.metadata.version(name) == version
    from projetv0_voice.audio_contract import (
        AUDIO_CHUNK_AAD_DOMAIN, VoiceOperationV2, canonical_audio_chunk_aad,
    )
    from projetv0_voice.models import RoutingV1
    from projetv0_voice.persistence.postgres_sink import PsycopgOperationSink
    from projetv0_voice.crypto import CryptoKeyring

    # Only the owned generated fixture shape is parsed here. Key versions,
    # duplicates and AES256 material are validated by the real public constructor.
    material = Path(request["keyring_path"]).read_bytes()
    assert len(material) <= 16384
    value = json.loads(material)
    assert set(value) == {"schema_version", "active_version", "keys"}
    assert type(value["schema_version"]) is int and value["schema_version"] == 1
    assert isinstance(value["keys"], list)
    pairs = []
    for item in value["keys"]:
        assert set(item) == {"version", "aes256_key_hex"}
        pairs.append((item["version"], bytes.fromhex(item["aes256_key_hex"])))
    keys = CryptoKeyring(pairs, active_version=value["active_version"])
    now = datetime.now(UTC)
    now = now.replace(microsecond=now.microsecond // 1000 * 1000)
    call_id = UUID(request["call_id"])
    deployment = request["deployment_id"]
    routing = RoutingV1(schema_version=1, direction="incoming", connection_id="playback-connection",
                        to_e164="+33123456789", from_e164=None,
                        telnyx_call_control_id="playback-" + str(call_id), telnyx_call_leg_id=None,
                        telnyx_call_session_id=None, admitted_at=now)
    sink = PsycopgOperationSink(request["url"])
    await sink.open()
    try:
        if request.get("revoke") is not None:
            original = request["revoke"]
            revoke = VoiceOperationV2.model_validate({
                "schema_version": 2, "operation_id": uuid4(), "deployment_id": deployment,
                "call_id": call_id, "occurred_at": now, "kind": "audio.revoke",
                "payload": {"schema_version": 2, "workspace_id": original["workspace_id"],
                            "recording_id": original["recording_id"],
                            "configuration_revision": original["configuration_revision"],
                            "retention_until": original["retention_until"], "reason": "caller_declined"},
            })
            await sink.ingest_v2(revoke)
            return original
        snapshot = await sink.begin_call_v2(deployment, call_id, routing)
        assert snapshot.audio_available and snapshot.recording_id is not None

        def operation(kind, payload):
            return VoiceOperationV2.model_validate({
                "schema_version": 2, "operation_id": uuid4(), "deployment_id": deployment,
                "call_id": call_id, "occurred_at": now, "kind": kind, "payload": payload,
            })

        # Synthetic fixture disclosure/PCM is supplied to real native consumers;
        # this does not prove a caller's choice or Pipecat acoustic capture.
        await sink.ingest_v2(operation("call.upsert", {
            "telnyx_call_control_id": routing.telnyx_call_control_id,
            "telnyx_call_leg_id": None, "telnyx_call_session_id": None,
            "status": "active", "disclosure_state": "completed", "started_at": now,
            "ended_at": None, "end_reason": None, "retention_until": snapshot.retention_until,
            "disclosure_evidence": {"schema_version": 1, "started_at": now,
                                    "completed_at": now, "failed_at": None,
                                    "input_gate_opened_at": now},
        }))
        pcm = base64.b64decode(request["pcm_b64"], validate=True)
        assert 0 < len(pcm) <= 2_048_000 and len(pcm) % 4 == 0
        metadata = {
            "schema_version": 2, "workspace_id": str(snapshot.workspace_id),
            "deployment_id": deployment, "call_id": str(call_id),
            "recording_id": str(snapshot.recording_id), "sequence": 0,
            "sample_count": len(pcm) // 4, "sample_rate": 8000, "channels": 2,
            "sample_format": "s16le", "configuration_revision": snapshot.configuration_revision,
            "retention_until": snapshot.retention_until.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "crypto_version": 1, "key_version": keys.active_version,
        }
        for sequence, offset in enumerate(range(0, len(pcm), 32000)):
            packet = pcm[offset:offset + 32000]
            metadata.update(sequence=sequence, sample_count=len(packet) // 4)
            aad = AUDIO_CHUNK_AAD_DOMAIN + json.dumps(metadata, ensure_ascii=False, sort_keys=True,
                                                     separators=(",", ":"), allow_nan=False).encode()
            encrypted = keys.encrypt(packet, aad=aad)
            payload = {key: value for key, value in metadata.items() if key not in {"deployment_id", "call_id"}}
            payload.update(nonce_b64=base64.b64encode(encrypted.nonce).decode(),
                           ciphertext_b64=base64.b64encode(encrypted.ciphertext).decode())
            chunk = operation("audio.chunk", payload)
            assert canonical_audio_chunk_aad(chunk) == aad
            await sink.ingest_v2(chunk)
        finish = operation("audio.finish", {
            "schema_version": 2, "workspace_id": snapshot.workspace_id,
            "recording_id": snapshot.recording_id,
            "configuration_revision": snapshot.configuration_revision,
            "retention_until": snapshot.retention_until, "last_sequence": sequence,
            "total_samples": len(pcm) // 4, "reason": "complete",
        })
        await sink.ingest_v2(finish)
        return {"call_id": str(call_id), "recording_id": str(snapshot.recording_id),
                "retention_until": metadata["retention_until"], "workspace_id": str(snapshot.workspace_id),
                "configuration_revision": snapshot.configuration_revision}
    finally:
        await sink.close()


try:
    incoming = json.loads(sys.stdin.readline())
    print(json.dumps({"ok": asyncio.run(produce(incoming), loop_factory=asyncio.SelectorEventLoop)}))
except BaseException:
    # Native private RPC/DSN/keyring exception data never crosses this fixture boundary.
    print(json.dumps({"error": "audio_playback_fixture_refused"}))
    sys.exit(1)
