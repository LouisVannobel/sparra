"""Owned native client driver. Only generated fixture connection material on stdin."""
import asyncio
import base64
import dataclasses
import importlib.metadata
import json
import sys
import traceback
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from uuid import UUID

incoming = json.loads(sys.stdin.readline())
if incoming.get("audio_candidate"):
    print(json.dumps({"phase": "driver-input"}), flush=True)
if "source_root" in incoming:
    selected_source = Path(incoming["source_root"])
    assert selected_source.is_absolute() and selected_source.resolve() == selected_source
    assert Path(sys.prefix).resolve() == selected_source.parent / ".venv"
    sys.path.insert(0, str(selected_source))

import psycopg
from psycopg_pool import AsyncConnectionPool
from projetv0_voice.models import RoutingV1, TurnUpsertPayloadV1, VoiceOperationV1
from projetv0_voice.persistence.postgres_sink import PsycopgOperationSink


class LostCommitReplyPool(AsyncConnectionPool):
    """Test fault after a real successful native COMMIT, never a fake SQL result."""
    @asynccontextmanager
    async def connection(self, *args, **kwargs):
        async with super().connection(*args, **kwargs) as connection:
            yield connection
        raise psycopg.OperationalError("owned fixture lost commit reply")


async def main():
    assert sys.version_info[:3] == (3, 13, 15)
    for name, version in {"cryptography": "50.0.0", "pipecat-ai": "1.12.0", "psycopg": "3.3.4"}.items():
        assert importlib.metadata.version(name) == version
    request = incoming
    if request["action"] == "connected":
        if request.get("audio_candidate"):
            print(json.dumps({"phase": "driver-models"}), flush=True)
        sys.path.insert(0, str(Path(__file__).parents[1]))
        voice_tests = Path(__import__("projetv0_voice").__file__).parents[2] / "tests" / "integration"
        sys.path.insert(0, str(voice_tests))
        from sparra_connected_scenario import connected
        if request.get("audio_candidate"):
            print(json.dumps({"phase": "scenario-imported"}), flush=True)
        if request.get("audio_candidate"):
            from sparra_connected_scenario import Scenario
            # Feature RED must fail before the historical Qualified fixture setup.
            if not hasattr(Scenario, "audio_admit"):
                print(json.dumps({"error": "audio_candidate_missing"}), flush=True)
                sys.exit(1)
        return await connected(request)
    if request["action"] == "aggregate_size":
        return {"bytes": len(json.dumps(request["turns"], ensure_ascii=False, separators=(", ", ": "), allow_nan=False).encode("utf-8"))}
    if request["action"] == "turn":
        from projetv0_voice.crypto import CryptoKeyring
        # Owned generated keys feed the actual native crypto object. The separate
        # key-file decoder suite covers production key-file parsing; this SQL
        # fixture does not import unrelated provider/audio initialization.
        value = json.loads(Path(request["keyring_path"]).read_text(encoding="utf-8"))
        keyring = CryptoKeyring([(key["version"], bytes.fromhex(key["aes256_key_hex"])) for key in value["keys"]], active_version=value["active_version"])
        encrypted = keyring.encrypt("Rappelez-moi".encode(), aad=("turn:" + request["turn_id"]).encode("ascii"))
        return TurnUpsertPayloadV1(turn_id=request["turn_id"], turn_no=1, role="user", source="stt_final", crypto_version=1, key_version=encrypted.key_version, nonce_b64=base64.b64encode(encrypted.nonce).decode(), ciphertext_b64=base64.b64encode(encrypted.ciphertext).decode(), started_at=request["at"], ended_at=request["at"], interrupted=False).model_dump(mode="json")
    if request["action"] == "identity":
        async with await psycopg.AsyncConnection.connect(request["url"], prepare_threshold=None) as connection:
            row = await (await connection.execute("SELECT session_user, current_user")).fetchone()
            return {"login": row[0], "role": row[1]}
    sink = PsycopgOperationSink(request["url"], pool_factory=LostCommitReplyPool) if request["action"] == "begin_unknown_commit" else PsycopgOperationSink(request["url"])
    await sink.open()
    try:
        action = request["action"]
        if action in {"begin", "begin_unknown_commit"}:
            value = await sink.begin_call(request["deployment"], UUID(request["call_id"]), RoutingV1.model_validate(request["routing"]))
            return value.model_dump(mode="json")
        if action == "ingest":
            await sink.ingest(VoiceOperationV1.model_validate(request["operation"]))
            return {"ack": True}
        if action == "lease_call":
            return [dataclasses.asdict(item) for item in await sink.lease_call_erasures("fixture", 30, 100)]
        if action == "lease_recording":
            return [dataclasses.asdict(item) for item in await sink.lease_recording_purges("fixture", 30, 100)]
        if action == "ack_call":
            await sink.ack_call_erasure(UUID(request["id"]), UUID(request["token"]), datetime.fromisoformat(request["at"]))
            return {"ack": True}
        if action == "ack_recording":
            await sink.ack_recording_purge(UUID(request["id"]), UUID(request["token"]), request["outcome"], datetime.fromisoformat(request["at"]))
            return {"ack": True}
        raise ValueError("unknown fixture action")
    finally:
        await sink.close()


try:
    print(json.dumps({"ok": asyncio.run(main(), loop_factory=asyncio.SelectorEventLoop)}, default=str))
except Exception as error:
    frame = traceback.extract_tb(error.__traceback__)[-1]
    filename = Path(frame.filename).name
    allowed_files = {"sparra-voice-driver.py", "sparra_connected_scenario.py"}
    allowed_functions = {"main", "connected", "setup", "event", "observed_asgi", "audio_admit", "attach_media", "open_call", "close"}
    where = (filename + ":" + (frame.name if frame.name in allowed_functions else "native-code")
             + ":" + str(frame.lineno)) if filename in allowed_files else "native-code"
    if incoming.get("action") == "connected":
        print(json.dumps({"error": type(error).__name__, "where": where}))
        sys.exit(1)
    # The single-operation RPC fixture retains its existing error DTO contract.
    print(json.dumps({"error": type(error).__name__}))
