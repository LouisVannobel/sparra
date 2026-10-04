"""Owned fictional archive bytes -> actual Voice writer/relay -> disposable PostgreSQL.

The historical pin/input gate is controlled fixture data. This never opens the
production ON capability and never qualifies France or Windows directory sync.
Generated connection material arrives only on stdin; errors expose classes only.
"""
from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import importlib.metadata
import json
import os
import sqlite3
import struct
import sys
import tomllib
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

source = Path(sys.argv[1])
scope = Path(sys.argv[2])
assert source.resolve() == source and source.name == "src"
assert scope.resolve() == scope and scope.is_dir()
assert Path(sys.prefix).resolve() == source.parent / ".venv"
assert sys.prefix != sys.base_prefix
assert tuple(map(int, (source.parent / ".python-version").read_text().strip().split("."))) == sys.version_info[:3]
project = tomllib.loads((source.parent / "pyproject.toml").read_text())
for dependency in project["project"]["dependencies"]:
    if "==" in dependency:
        name, version = dependency.split("==", 1)
        assert importlib.metadata.version(name.split("[", 1)[0]) == version
sys.path.insert(0, str(source))

import httpx
import psycopg
from pydantic import SecretStr
from psycopg_pool import AsyncConnectionPool
from projetv0_voice import crypto, models, recording_archive
from projetv0_voice.admission import CallGenerationHandle, ProcessLeaseClaim
from projetv0_voice.persistence import commands, postgres_sink, relay, writer as writer_module
from projetv0_voice.session import CallIdentity
from projetv0_voice.telnyx import recordings
from projetv0_voice.telnyx.webhooks import VerifiedWebhook

for module, relative in [
    (crypto, "crypto.py"), (models, "models.py"), (recording_archive, "recording_archive.py"),
    (commands, "persistence/commands.py"), (postgres_sink, "persistence/postgres_sink.py"),
    (relay, "persistence/relay.py"), (writer_module, "persistence/writer.py"),
    (recordings, "telnyx/recordings.py"),
]:
    assert Path(module.__file__).resolve() == source / "projetv0_voice" / relative


class LostCommitReplyPool(AsyncConnectionPool):
    @asynccontextmanager
    async def connection(self, *args, **kwargs):
        async with super().connection(*args, **kwargs) as connection:
            yield connection
        raise psycopg.OperationalError("owned fixture lost commit reply")


def instant(value: str) -> datetime:
    return datetime.fromisoformat(value).astimezone(UTC)


def wav() -> bytes:
    samples = b"\x01\x00\x02\x00" * 32
    return b"RIFF" + struct.pack("<I", 36 + len(samples)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 2, 8000, 32000, 4, 16
    ) + b"data" + struct.pack("<I", len(samples)) + samples


async def no_effect(*_args):
    return None


class FictionalDownload:
    def __init__(self, context):
        self.context = context

    async def retrieve_recording_download(self, recording_id: str, *, timeout_seconds: float):
        c = self.context
        assert recording_id == c["provider"] and 0 < timeout_seconds <= 1
        route, admitted = c["route"], c["admitted"]
        return recording_archive.ProviderRecordingDownloadV1(
            recording=recordings.ProviderRecordingV1(
                recording_id, route["telnyx_call_control_id"], route["telnyx_call_leg_id"],
                route["telnyx_call_session_id"], "dual", "completed", "call",
                "StartCallRecordingAPI", admitted, admitted + timedelta(seconds=1),
            ),
            wav_url=SecretStr("https://recordings.example.invalid/fictional.wav"),
            retrieved_at=c["now"],
        )


async def prepare(request, contexts):
    call_id = UUID(request["snapshot"]["call_id"])
    assert str(call_id) not in contexts
    route = request["routing"]
    admitted = instant(route["admitted_at"])
    snapshot = models.BeginCallSnapshotV1.model_validate(request["snapshot"])
    assert snapshot.recording_enabled is True
    assert snapshot.retention_until == admitted + timedelta(seconds=2592000)
    directory = scope / str(call_id)
    directory.mkdir(mode=0o700)
    audio = directory / "audio"
    audio.mkdir(mode=0o700)
    generation = uuid4()
    keyring = crypto.CryptoKeyring({1: os.urandom(32)}, active_version=1)
    c = {"route": route, "admitted": admitted, "now": admitted + timedelta(seconds=3),
         "provider": "fixture-" + str(call_id), "audio": audio, "url": request["url"]}
    writer = writer_module.PersistenceWriter(directory / "voice.sqlite", keyring=keyring, utcnow=lambda: c["now"])
    task = asyncio.create_task(writer.run())
    c.update(writer=writer, task=task)
    contexts[str(call_id)] = c  # Cleanup owns partial preparation too.
    assert await writer.wait_ready()
    consumer = recording_archive.RecordingArchive(
        directory=audio, keyring=keyring, writer=writer, telnyx=FictionalDownload(c),
        allowed_origins=("https://recordings.example.invalid",),
        download_transport=httpx.MockTransport(lambda _request: httpx.Response(200, content=wav())),
        directory_sync=(lambda: None) if os.name == "nt" else None,
        utcnow=lambda: c["now"],
    )
    c["consumer"] = consumer
    identity = CallIdentity(
        call_id=call_id, generation=CallGenerationHandle(route["telnyx_call_control_id"], generation),
        lease_claim=ProcessLeaseClaim(route["telnyx_call_control_id"], call_id, generation, b"d" * 32, admitted),
        deployment_id=request["deployment"], telnyx_call_control_id=route["telnyx_call_control_id"],
        telnyx_call_leg_id=route["telnyx_call_leg_id"], telnyx_call_session_id=route["telnyx_call_session_id"],
        stream_id="fixture-stream", started_at=admitted, retention_until=snapshot.retention_until,
        begin_snapshot=snapshot,
    )
    pending = models.VoiceOperationV1(
        schema_version=1, operation_id=uuid4(), deployment_id=request["deployment"],
        call_id=call_id, occurred_at=admitted, kind="call.upsert",
        payload=models.CallUpsertPayloadV1(
            telnyx_call_control_id=route["telnyx_call_control_id"], telnyx_call_leg_id=route["telnyx_call_leg_id"],
            telnyx_call_session_id=route["telnyx_call_session_id"], status="pending", disclosure_state="pending",
            started_at=None, ended_at=None, end_reason=None, retention_until=snapshot.retention_until,
        ),
    )
    ticket = writer.submit_webhook(
        receipt={"event_id": "fixture-admitted-" + str(call_id), "event_type": "call.initiated",
                 "call_control_id": route["telnyx_call_control_id"], "occurred_at": admitted,
                 "received_at": admitted, "semantic_fingerprint_sha256": b"a" * 32},
        lease={"action": "upsert", "call_control_id": route["telnyx_call_control_id"], "call_id": call_id,
               "tenant_id": "fixture-tenant", "agent_id": "fixture-agent", "state": "pending",
               "token_hash": b"d" * 32, "created_at": admitted, "expires_at": admitted + timedelta(hours=1), "closed_at": None},
        operation=pending,
        admission_facts=writer_module.LocalCallAdmissionFacts(
            call_id, admitted, snapshot.retention_until, route["telnyx_call_leg_id"],
            route["telnyx_call_session_id"], admission_generation=generation,
        ),
    )
    await ticket.wait()
    # Controlled historical facts, consumed by the real writer. No capability flag.
    await writer.bind_recording_policy(snapshot, generation=generation)
    await writer.reserve_recording_audio(call_id, generation=generation)
    active = models.VoiceOperationV1.model_validate({
        **pending.model_dump(mode="json"), "operation_id": str(uuid4()),
        "occurred_at": admitted + timedelta(seconds=2),
        "payload": {**pending.payload.model_dump(mode="json"), "status": "active", "disclosure_state": "completed",
                    "started_at": admitted, "disclosure_evidence": {"schema_version": 1, "started_at": admitted,
                    "completed_at": admitted + timedelta(seconds=1), "failed_at": None,
                    "input_gate_opened_at": admitted + timedelta(seconds=2)}},
    })
    await writer.commit_control(commands.PersistenceCommand("outbox", {"operation": active}, None))
    correlation = recordings.build_recording_correlation(identity, retention_days=30, required=True)
    event = VerifiedWebhook(
        event_id="fixture-saved-" + str(call_id), event_type="call.recording.saved", occurred_at=c["now"],
        call_control_id=route["telnyx_call_control_id"], call_leg_id=route["telnyx_call_leg_id"],
        call_session_id=route["telnyx_call_session_id"], recording_id=c["provider"], stream_id=None,
        client_state=recordings.encode_recording_correlation(correlation), recording_started_at=admitted,
        recording_ended_at=admitted + timedelta(seconds=1), recording_channels="dual", semantic_fingerprint_sha256=b"f" * 32,
    )
    effect = recordings.resolve_recording_webhook(event)
    disposition = await recordings.after_recording_webhook_commit(
        event, effect, telnyx=FictionalDownload(c), writer=writer, local_drain=no_effect,
        monotonic=lambda: 0.0, timeout_seconds=30, utcnow=lambda: c["now"],
    )
    assert disposition.status_code == 200
    rid = effect.operation.payload.recording_id
    c["recording_id"] = rid
    result = await consumer.archive_recording_once(rid)
    assert result.outcome == "archived" and result.native_acknowledged is False
    job = await writer.read_recording_archive(rid)
    ciphertext = (audio / str(rid)).read_bytes()
    assert keyring.decrypt(crypto.EncryptedValue(job.receipt.key_version, job.nonce, ciphertext),
                           aad=f"recording:{call_id}:{rid}".encode()) == wav()
    assert hashlib.sha256(ciphertext).hexdigest() == job.receipt.ciphertext_sha256
    assert len(ciphertext) == job.receipt.encrypted_bytes == 188
    items = await writer.read_relay_batch(batch_size=10, now=c["now"], lease_seconds=30)
    operations = [commands.canonical_operation_bytes(item.operation).decode("utf-8") for item in items]
    receipt_operations = [value for value in operations if "archive_receipt" in json.loads(value)["payload"]]
    assert len(receipt_operations) == 1
    c["now"] += timedelta(seconds=31)  # Owned claim clock: original bytes stay unchanged.
    return {"call_id": str(call_id), "recording_id": str(rid), "operations": operations,
            "receipt_operation": receipt_operations[0], "ledger_state": job.state,
            "ciphertext_bytes": len(ciphertext), "ciphertext_sha256": hashlib.sha256(ciphertext).hexdigest()}


async def use_sink(request, contexts):
    c = contexts[request["call_id"]]
    if request["action"] == "witness":
        job = await c["writer"].read_recording_archive(c["recording_id"])
        database = c["audio"].parent / "voice.sqlite"
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
            head = connection.execute("SELECT kind,op_id FROM outbox ORDER BY queue_id LIMIT 1").fetchone()
            count = connection.execute("SELECT count(*) FROM outbox WHERE call_id=? AND kind='recording.upsert'", (request["call_id"],)).fetchone()[0]
        return {"ledger_state": job.state, "outbox_head_kind": None if head is None else head[0],
                "outbox_head_operation_id": None if head is None else head[1], "recording_outbox_rows": count}
    sink = postgres_sink.PsycopgOperationSink(c["url"], pool_factory=LostCommitReplyPool) if request.get("lost_commit") else postgres_sink.PsycopgOperationSink(c["url"])
    await sink.open()
    try:
        if request["action"] == "ingest":
            await sink.ingest(models.VoiceOperationV1.model_validate_json(request["operation"]))
            return {"ack": True}
        if request["action"] == "erase":
            cleaned = await c["writer"].erase_call_content(UUID(request["call_id"]), lease_token=UUID(request["token"]), now=c["now"])
            assert cleaned is not None
            assert not list(c["audio"].iterdir())
            await sink.ack_call_erasure(UUID(request["call_id"]), UUID(request["token"]), cleaned)
            await c["writer"].finish_erasure_ack(UUID(request["call_id"]), UUID(request["token"]), acknowledged=True)
            return {"files_removed": True, "ack": True}
        actual_relay = relay.OutboxRelay(c["writer"], sink, utcnow=lambda: c["now"], random=lambda: 0.0,
                                        on_degraded=no_effect, drain=no_effect, claim_lease_seconds=30)
        result = await actual_relay.run_once(batch_size=10)
        job = await c["writer"].read_recording_archive(c["recording_id"])
        return {"relay": dataclasses.asdict(result), "ledger_state": job.state}
    finally:
        await sink.close()


async def cleanup(contexts):
    failures = []
    for c in contexts.values():
        try:
            if "consumer" in c:
                await c["consumer"].aclose()
            await c["writer"].drain(2)
            await asyncio.wait_for(c["task"], timeout=2)
        except Exception as error:
            failures.append(type(error).__name__)
    if failures:
        raise RuntimeError("owned fixture cleanup failed")


async def main():
    contexts = {}
    try:
        print(json.dumps({"ready": True}), flush=True)
        while line := await asyncio.to_thread(sys.stdin.readline):
            try:
                request = json.loads(line)
                if request["action"] == "close":
                    await cleanup(contexts)
                    contexts.clear()
                    print(json.dumps({"ok": {"retired": True}}), flush=True)
                    return
                result = await prepare(request, contexts) if request["action"] == "prepare" else await use_sink(request, contexts)
                print(json.dumps({"ok": result}), flush=True)
            except Exception as error:
                print(json.dumps({"error": type(error).__name__}), flush=True)
    finally:
        await cleanup(contexts)


asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop) if os.name == "nt" else asyncio.run(main())
