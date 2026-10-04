ALTER TABLE "voice_private"."recording_purge" ADD COLUMN "archive_ciphertext_sha256" text;--> statement-breakpoint
ALTER TABLE "voice_private"."recording_purge" ADD COLUMN "archive_encrypted_bytes" integer;--> statement-breakpoint
ALTER TABLE "voice_private"."recording_purge" ADD COLUMN "archive_key_version" bigint;--> statement-breakpoint
ALTER TABLE "voice_private"."recording_purge" ADD CONSTRAINT "voice_recording_archive_receipt" CHECK (("voice_private"."recording_purge"."archive_ciphertext_sha256" is null and "voice_private"."recording_purge"."archive_encrypted_bytes" is null and "voice_private"."recording_purge"."archive_key_version" is null) or ("voice_private"."recording_purge"."archive_ciphertext_sha256" is not null and "voice_private"."recording_purge"."archive_ciphertext_sha256" ~ '^[0-9a-f]{64}$' and "voice_private"."recording_purge"."archive_encrypted_bytes" is not null and "voice_private"."recording_purge"."archive_encrypted_bytes" between 17 and 33554448 and "voice_private"."recording_purge"."archive_key_version" is not null and "voice_private"."recording_purge"."archive_key_version" between 1 and 9007199254740991));
--> statement-breakpoint
GRANT UPDATE(archive_ciphertext_sha256,archive_encrypted_bytes,archive_key_version) ON voice_private.recording_purge TO sparra_voice_definer;
--> statement-breakpoint
CREATE FUNCTION voice_private.recording_archive_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF OLD.archive_ciphertext_sha256 IS NOT NULL AND ROW(NEW.recording_id,NEW.workspace_id,NEW.deployment_id,NEW.call_id,NEW.provider_recording_id,NEW.original_retention_until,NEW.archive_ciphertext_sha256,NEW.archive_encrypted_bytes,NEW.archive_key_version) IS DISTINCT FROM ROW(OLD.recording_id,OLD.workspace_id,OLD.deployment_id,OLD.call_id,OLD.provider_recording_id,OLD.original_retention_until,OLD.archive_ciphertext_sha256,OLD.archive_encrypted_bytes,OLD.archive_key_version) THEN RAISE EXCEPTION 'Voice archive receipt is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION voice_private.recording_archive_guard() OWNER TO sparra_voice_definer;
REVOKE ALL ON FUNCTION voice_private.recording_archive_guard() FROM PUBLIC,runtime,workspace_bootstrap;
CREATE TRIGGER voice_recording_archive_immutable BEFORE UPDATE ON voice_private.recording_purge FOR EACH ROW EXECUTE FUNCTION voice_private.recording_archive_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION voice_private.validate_operation(op jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE p jsonb; k text; status text; started timestamptz; ended timestamptz; retention timestamptz; occurred timestamptz; ev jsonb; a timestamptz; b timestamptz; gate timestamptz; provider text; ar jsonb;
BEGIN
 PERFORM voice_private.object_keys(op,ARRAY['schema_version','operation_id','deployment_id','call_id','occurred_at','kind','payload']);
 PERFORM voice_private.integer_value(op->'schema_version',1,1);PERFORM voice_private.uuid_value(op->'operation_id');PERFORM voice_private.uuid_value(op->'call_id');
 IF length(voice_private.string_value(op->'deployment_id',1024))>256 THEN RAISE EXCEPTION 'Voice deployment contract' USING ERRCODE='PV202'; END IF;
 occurred=voice_private.instant(op->'occurred_at');k=voice_private.string_value(op->'kind',32);p=op->'payload';
 IF k='call.upsert' THEN
  PERFORM voice_private.object_keys(p,ARRAY['telnyx_call_control_id','telnyx_call_leg_id','telnyx_call_session_id','status','disclosure_state','started_at','ended_at','end_reason','retention_until'],ARRAY['message_result','disclosure_evidence','transcript_loss_count']);
  PERFORM voice_private.string_value(p->'telnyx_call_control_id',1024);PERFORM voice_private.string_value(p->'telnyx_call_leg_id',1024,true);PERFORM voice_private.string_value(p->'telnyx_call_session_id',1024,true);
  status=voice_private.string_value(p->'status',16);PERFORM voice_private.string_value(p->'end_reason',4096,true);
  IF status NOT IN ('pending','active','closing','failed','closed') OR voice_private.string_value(p->'disclosure_state',16) NOT IN ('pending','completed','failed') THEN RAISE EXCEPTION 'Voice state contract' USING ERRCODE='PV202'; END IF;
  started=voice_private.instant(p->'started_at',true);ended=voice_private.instant(p->'ended_at',true);retention=voice_private.instant(p->'retention_until');
  IF (status='pending' AND (started IS NOT NULL OR ended IS NOT NULL OR p->>'end_reason' IS NOT NULL))
  OR (status IN ('active','closing') AND (started IS NULL OR ended IS NOT NULL)) OR (status='active' AND p->>'end_reason' IS NOT NULL)
  OR (status='closed' AND (started IS NULL OR ended IS NULL OR p->>'end_reason' IS NULL)) OR (status='failed' AND (ended IS NULL OR p->>'end_reason' IS NULL))
  OR retention<=coalesce(ended,started) THEN RAISE EXCEPTION 'Voice timeline contract' USING ERRCODE='PV202'; END IF;
  IF p ? 'transcript_loss_count' THEN PERFORM voice_private.integer_value(p->'transcript_loss_count',0,2147483647);END IF;
  IF p ? 'message_result' THEN
   IF status NOT IN ('failed','closed') THEN RAISE EXCEPTION 'Voice result requires terminal' USING ERRCODE='PV202'; END IF;
   PERFORM voice_private.object_keys(p->'message_result',ARRAY['schema_version','crypto_version','key_version','nonce_b64','ciphertext_b64']);PERFORM voice_private.integer_value(p->'message_result'->'schema_version',1,1);PERFORM voice_private.envelope(p->'message_result','result');
  END IF;
  IF p ? 'disclosure_evidence' THEN
   ev=p->'disclosure_evidence';PERFORM voice_private.object_keys(ev,ARRAY['schema_version','started_at','completed_at','failed_at','input_gate_opened_at']);PERFORM voice_private.integer_value(ev->'schema_version',1,1);
   a=voice_private.instant(ev->'started_at',true);b=voice_private.instant(ev->'completed_at',true);gate=voice_private.instant(ev->'input_gate_opened_at',true);PERFORM voice_private.instant(ev->'failed_at',true);
   IF b<a OR gate<b OR (gate IS NOT NULL AND b IS NULL) THEN RAISE EXCEPTION 'Voice disclosure chronology' USING ERRCODE='PV202';END IF;
  END IF;
 ELSIF k='turn.upsert' THEN
  PERFORM voice_private.object_keys(p,ARRAY['turn_id','turn_no','role','source','crypto_version','key_version','nonce_b64','ciphertext_b64','started_at','ended_at','interrupted']);
  PERFORM voice_private.uuid_value(p->'turn_id');PERFORM voice_private.integer_value(p->'turn_no',1,9007199254740991);PERFORM voice_private.envelope(p,'turn');
  IF voice_private.string_value(p->'role',16) NOT IN ('user','assistant') OR voice_private.string_value(p->'source',32)<>(CASE WHEN p->>'role'='user' THEN 'stt_final' ELSE 'pipecat_assistant' END) OR jsonb_typeof(p->'interrupted')<>'boolean' THEN RAISE EXCEPTION 'Voice turn contract' USING ERRCODE='PV202';END IF;
  started=voice_private.instant(p->'started_at');ended=voice_private.instant(p->'ended_at');
 ELSIF k='recording.upsert' THEN
  PERFORM voice_private.object_keys(p,ARRAY['recording_id','status','telnyx_recording_id','channels','format','started_at','ended_at','retention_until'],ARRAY['archive_receipt']);
  PERFORM voice_private.uuid_value(p->'recording_id');status=voice_private.string_value(p->'status',16);provider=voice_private.string_value(p->'telnyx_recording_id',256,true);
  IF provider IS NOT NULL AND (provider !~ '^[A-Za-z0-9._~-]+$' OR provider IN ('.','..')) THEN RAISE EXCEPTION 'Voice recording identity' USING ERRCODE='PV202';END IF;
  started=voice_private.instant(p->'started_at',true);ended=voice_private.instant(p->'ended_at',true);retention=voice_private.instant(p->'retention_until',true);
  IF status NOT IN ('off','pending','active','saved','failed','purged') OR (status='off' AND (p-'recording_id'-'status')<>jsonb_build_object('telnyx_recording_id',NULL,'channels',NULL,'format',NULL,'started_at',NULL,'ended_at',NULL,'retention_until',NULL))
   OR (status<>'off' AND (p->>'channels' IS DISTINCT FROM 'dual' OR p->>'format' IS DISTINCT FROM 'wav'))
   OR ((started IS NULL)<>(ended IS NULL)) OR (status IN ('pending','active') AND (provider IS NOT NULL OR started IS NOT NULL OR ended IS NOT NULL OR retention IS NOT NULL))
   OR (status='failed' AND retention IS NOT NULL) OR (status IN ('saved','purged') AND (started IS NULL OR ended IS NULL OR retention IS NULL))
   OR (status='purged' AND provider IS NULL) OR retention<=coalesce(ended,started) THEN RAISE EXCEPTION 'Voice recording contract' USING ERRCODE='PV202';END IF;
  IF p ? 'archive_receipt' THEN
   ar=p->'archive_receipt';PERFORM voice_private.object_keys(ar,ARRAY['recording_id','ciphertext_sha256','encrypted_bytes','key_version','retention_until']);
   PERFORM voice_private.integer_value(ar->'encrypted_bytes',17,33554448);PERFORM voice_private.integer_value(ar->'key_version',1,9007199254740991);
   IF voice_private.uuid_value(ar->'recording_id')<>(p->>'recording_id')::uuid OR status NOT IN ('saved','purged') OR provider IS NULL
    OR voice_private.string_value(ar->'ciphertext_sha256',64) !~ '^[0-9a-f]{64}$'
    OR ar->>'retention_until'<>voice_private.iso(voice_private.instant(ar->'retention_until'))
    OR voice_private.instant(ar->'retention_until')<>retention THEN RAISE EXCEPTION 'Voice archive receipt contract' USING ERRCODE='PV202';END IF;
  END IF;
 ELSE RAISE EXCEPTION 'Voice operation kind' USING ERRCODE='PV202';
 END IF;
 IF ended<started OR occurred<coalesce(ended,started) THEN RAISE EXCEPTION 'Voice operation chronology' USING ERRCODE='PV202';END IF;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION voice.ingest_operation_v1(op jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE b voice_private.deployment_binding; c public.sparra_call; fence public.sparra_erasure; rec voice_private.recording_purge; p jsonb; ev jsonb; cid uuid; oid uuid; occurred timestamptz; retention timestamptz; digest text; old_digest text; kind text; answer text='applied'; rank integer; reason_wins boolean; merged jsonb; actual_provider text; dead boolean; ar jsonb; archive_allowed boolean=false;
BEGIN
 b=voice_private.lock_binding();PERFORM voice_private.validate_operation(op);
 IF op->>'deployment_id'<>b.deployment_id THEN RAISE EXCEPTION 'Voice deployment unavailable' USING ERRCODE='PV202';END IF;
 cid=(op->>'call_id')::uuid;oid=(op->>'operation_id')::uuid;p=op->'payload';kind=op->>'kind';occurred=voice_private.instant(op->'occurred_at');digest=encode(sha256(convert_to(op::text,'UTF8')),'hex');
 SELECT * INTO c FROM public.sparra_call WHERE id=cid FOR UPDATE;
 SELECT * INTO fence FROM public.sparra_erasure WHERE call_id=cid;
 actual_provider=CASE WHEN kind='recording.upsert' THEN p->>'telnyx_recording_id' ELSE NULL END;
 dead=fence.call_id IS NOT NULL OR (c.id IS NOT NULL AND (c.retention_until<=clock_timestamp() OR c.erasure_requested_at IS NOT NULL));
 -- Only a correlated real recording identity may bypass content admission.
 IF actual_provider IS NULL OR (c.id IS NULL AND fence.call_id IS NULL) THEN
  IF NOT b.admission_enabled OR NOT EXISTS(SELECT 1 FROM public.workspace w WHERE w.id=b.workspace_id AND w.lifecycle='active' AND w.kind='personal' AND w.auth_organization_id IS NULL) THEN RAISE EXCEPTION 'Voice admission unavailable' USING ERRCODE='PV202';END IF;
 END IF;
 SELECT payload_sha256 INTO old_digest FROM voice_private.operation_receipt WHERE deployment_id=b.deployment_id AND operation_id=oid;
 IF FOUND AND old_digest<>digest THEN
  RETURN jsonb_build_object('schema_version',1,'status','conflict','operation_id',oid,'payload_sha256',digest);
 END IF;
 IF dead AND actual_provider IS NULL THEN RAISE EXCEPTION 'Voice call erased' USING ERRCODE='PV301';END IF;
 IF c.id IS NULL AND fence.call_id IS NULL THEN
  IF kind<>'call.upsert' OR p->>'status'<>'pending' THEN RAISE EXCEPTION 'Voice parent unavailable' USING ERRCODE='PV202';END IF;
  retention=voice_private.instant(p->'retention_until');
  IF occurred<>date_trunc('milliseconds',occurred) OR retention<>occurred+interval '2592000 seconds' OR occurred-clock_timestamp()>interval '30 seconds' THEN RAISE EXCEPTION 'Voice admission contract' USING ERRCODE='PV202';END IF;
  IF clock_timestamp()-occurred>interval '300 seconds' THEN RAISE EXCEPTION 'Voice admission expired' USING ERRCODE='PV301';END IF;
  IF EXISTS(SELECT 1 FROM public.sparra_erasure WHERE provider_call_control_id=p->>'telnyx_call_control_id') THEN RAISE EXCEPTION 'Voice call erased' USING ERRCODE='PV301';END IF;
  IF EXISTS(SELECT 1 FROM public.sparra_call WHERE provider_call_control_id=p->>'telnyx_call_control_id') THEN RAISE EXCEPTION 'Voice provider conflict' USING ERRCODE='PV202';END IF;
 END IF;
 IF c.id IS NOT NULL THEN retention=c.retention_until;ELSIF fence.call_id IS NOT NULL THEN retention=fence.original_retention_until;END IF;
 IF kind='recording.upsert' AND p ? 'archive_receipt' THEN
  ar=p->'archive_receipt';
  IF voice_private.instant(ar->'retention_until')<>retention OR (c.id IS NOT NULL AND c.retention_until<>c.admitted_at+interval '2592000 seconds') THEN RAISE EXCEPTION 'Voice archive admission deadline' USING ERRCODE='PV202';END IF;
  IF NOT dead THEN
   IF c.id IS NULL OR c.configuration_revision IS NULL OR NOT EXISTS(SELECT 1 FROM public.sparra_knowledge_revision k WHERE k.workspace_id=b.workspace_id AND k.revision=c.configuration_revision AND k.recording_enabled) THEN RAISE EXCEPTION 'Voice archive policy unavailable' USING ERRCODE='PV202';END IF;
   archive_allowed=true;
  END IF;
 END IF;
 IF old_digest IS NOT NULL THEN
  RETURN jsonb_build_object('schema_version',1,'status','duplicate','operation_id',oid,'payload_sha256',digest);
 END IF;
 IF kind='call.upsert' THEN
  IF c.id IS NULL THEN
   INSERT INTO public.sparra_call(id,workspace_id,deployment_id,provider_call_control_id,provider_call_leg_id,provider_call_session_id,admitted_at,retention_until)
    VALUES(cid,b.workspace_id,b.deployment_id,p->>'telnyx_call_control_id',p->>'telnyx_call_leg_id',p->>'telnyx_call_session_id',occurred,retention) RETURNING * INTO c;
  END IF;
  IF ROW(c.provider_call_control_id,c.provider_call_leg_id,c.provider_call_session_id) IS DISTINCT FROM ROW(p->>'telnyx_call_control_id',p->>'telnyx_call_leg_id',p->>'telnyx_call_session_id') OR retention<>voice_private.instant(p->'retention_until') OR (p->>'status'='pending' AND occurred<>c.admitted_at) THEN RAISE EXCEPTION 'Voice call identity conflict' USING ERRCODE='PV202';END IF;
  IF c.encrypted_message_result IS NOT NULL AND p ? 'message_result' AND c.encrypted_message_result<>p->'message_result' THEN answer='conflict';
  ELSE
   rank=array_position(ARRAY['pending','active','closing','failed','closed'],p->>'status');
   reason_wins=p->>'end_reason' IS NOT NULL AND (c.end_reason_rank IS NULL OR ROW(rank,occurred,oid)>ROW(c.end_reason_rank,c.end_reason_occurred_at,c.end_reason_operation_id));
   ev=p->'disclosure_evidence';
   UPDATE public.sparra_call SET
    status=CASE WHEN rank>array_position(ARRAY['pending','active','closing','failed','closed'],c.status) THEN p->>'status' ELSE c.status END,
    started_at=least(c.started_at,voice_private.instant(p->'started_at',true)),ended_at=greatest(c.ended_at,voice_private.instant(p->'ended_at',true)),
    end_reason=CASE WHEN reason_wins THEN p->>'end_reason' ELSE c.end_reason END,end_reason_rank=CASE WHEN reason_wins THEN rank ELSE c.end_reason_rank END,end_reason_occurred_at=CASE WHEN reason_wins THEN occurred ELSE c.end_reason_occurred_at END,end_reason_operation_id=CASE WHEN reason_wins THEN oid ELSE c.end_reason_operation_id END,
    disclosure_state=CASE WHEN c.disclosure_state='completed' OR p->>'disclosure_state'='completed' THEN 'completed' WHEN c.disclosure_state='failed' OR p->>'disclosure_state'='failed' THEN 'failed' ELSE 'pending' END,
    disclosure_started_at=least(c.disclosure_started_at,CASE WHEN ev IS NOT NULL THEN voice_private.instant(ev->'started_at',true) END),disclosure_completed_at=least(c.disclosure_completed_at,CASE WHEN ev IS NOT NULL THEN voice_private.instant(ev->'completed_at',true) END),disclosure_failed_at=greatest(c.disclosure_failed_at,CASE WHEN ev IS NOT NULL THEN voice_private.instant(ev->'failed_at',true) END),input_gate_opened_at=least(c.input_gate_opened_at,CASE WHEN ev IS NOT NULL THEN voice_private.instant(ev->'input_gate_opened_at',true) END),
    encrypted_message_result=coalesce(c.encrypted_message_result,p->'message_result'),transcript_loss_count=greatest(c.transcript_loss_count,coalesce((p->>'transcript_loss_count')::integer,0)) WHERE id=cid;
  END IF;
 ELSIF kind='turn.upsert' THEN
  IF c.configuration_revision IS NULL THEN RAISE EXCEPTION 'Voice call unpinned' USING ERRCODE='PV202';END IF;
  IF (c.encrypted_turns ? (p->>'turn_id') AND c.encrypted_turns->(p->>'turn_id')<>p) OR EXISTS(SELECT 1 FROM jsonb_each(c.encrypted_turns) t WHERE t.key<>p->>'turn_id' AND t.value->'turn_no'=p->'turn_no') THEN answer='conflict';
  ELSE
   merged=c.encrypted_turns||jsonb_build_object(p->>'turn_id',p);
   IF octet_length(merged::text)>524288 THEN RAISE EXCEPTION 'Voice aggregate bound' USING ERRCODE='PV202';END IF;
   UPDATE public.sparra_call SET encrypted_turns=merged WHERE id=cid;
  END IF;
 ELSE
  -- Off/reserved facts need no remote obligation; actual IDs always do, even
  -- when the provider labels the recording purged. Only worker ack proves it.
  IF c.id IS NULL AND fence.call_id IS NULL THEN RAISE EXCEPTION 'Voice recording parent unavailable' USING ERRCODE='PV202';END IF;
  IF actual_provider IS NOT NULL THEN
   SELECT * INTO rec FROM voice_private.recording_purge WHERE recording_id=(p->>'recording_id')::uuid OR provider_recording_id=actual_provider;
   IF FOUND AND ROW(rec.recording_id,rec.call_id,rec.provider_recording_id) IS DISTINCT FROM ROW((p->>'recording_id')::uuid,cid,actual_provider) THEN answer='conflict';
   ELSIF rec.recording_id IS NULL THEN
    INSERT INTO voice_private.recording_purge(recording_id,workspace_id,deployment_id,call_id,provider_recording_id,original_retention_until,archive_ciphertext_sha256,archive_encrypted_bytes,archive_key_version)
     VALUES((p->>'recording_id')::uuid,b.workspace_id,b.deployment_id,cid,actual_provider,retention,CASE WHEN archive_allowed THEN ar->>'ciphertext_sha256' END,CASE WHEN archive_allowed THEN (ar->>'encrypted_bytes')::integer END,CASE WHEN archive_allowed THEN (ar->>'key_version')::bigint END);
    UPDATE public.sparra_erasure SET state='queued',completed_at=NULL WHERE call_id=cid AND state='completed';
   ELSIF ar IS NOT NULL THEN
    IF rec.original_retention_until<>retention THEN RAISE EXCEPTION 'Voice archive admission deadline' USING ERRCODE='PV202';END IF;
    IF rec.archive_ciphertext_sha256 IS NOT NULL AND ROW(rec.archive_ciphertext_sha256,rec.archive_encrypted_bytes,rec.archive_key_version) IS DISTINCT FROM ROW(ar->>'ciphertext_sha256',(ar->>'encrypted_bytes')::integer,(ar->>'key_version')::bigint) THEN answer='conflict';
    ELSE
     UPDATE voice_private.recording_purge SET
      archive_ciphertext_sha256=coalesce(archive_ciphertext_sha256,CASE WHEN archive_allowed THEN ar->>'ciphertext_sha256' END),
      archive_encrypted_bytes=coalesce(archive_encrypted_bytes,CASE WHEN archive_allowed THEN (ar->>'encrypted_bytes')::integer END),
      archive_key_version=coalesce(archive_key_version,CASE WHEN archive_allowed THEN (ar->>'key_version')::bigint END),
      retry_at=least(retry_at,clock_timestamp()) WHERE recording_id=rec.recording_id;
    END IF;
   END IF;
  END IF;
 END IF;
 IF answer='applied' THEN INSERT INTO voice_private.operation_receipt(deployment_id,operation_id,workspace_id,call_id,payload_sha256,occurred_at,original_retention_until) VALUES(b.deployment_id,oid,b.workspace_id,cid,digest,occurred,retention);END IF;
 RETURN jsonb_build_object('schema_version',1,'status',answer,'operation_id',oid,'payload_sha256',digest);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Voice identity conflict' USING ERRCODE='PV202';
END $$;
