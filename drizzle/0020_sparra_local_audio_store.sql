CREATE TABLE "sparra_audio_chunk" (
	"workspace_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"deployment_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"configuration_revision" integer NOT NULL,
	"retention_until" timestamp (3) with time zone NOT NULL,
	"sample_count" integer NOT NULL,
	"sample_rate" integer NOT NULL,
	"channels" integer NOT NULL,
	"sample_format" text NOT NULL,
	"crypto_version" integer NOT NULL,
	"key_version" bigint NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"charged_bytes" integer NOT NULL,
	CONSTRAINT "sparra_audio_chunk_workspace_id_call_id_recording_id_sequence_pk" PRIMARY KEY("workspace_id","call_id","recording_id","sequence"),
	CONSTRAINT "sparra_audio_chunk_sequence" CHECK (sequence between 0 and 599),
	CONSTRAINT "sparra_audio_chunk_samples" CHECK (sample_count between 1 and 8000 and sample_rate = 8000 and channels = 2 and sample_format = 's16le'),
	CONSTRAINT "sparra_audio_chunk_crypto" CHECK (crypto_version = 1 and key_version between 1 and 9007199254740991 and octet_length(nonce) = 12 and octet_length(ciphertext) = sample_count * 4 + 16),
	CONSTRAINT "sparra_audio_chunk_charge" CHECK (charged_bytes - octet_length(nonce) - octet_length(ciphertext) between 0 and 2048),
	CONSTRAINT "sparra_audio_chunk_pin" CHECK (configuration_revision > 0 and isfinite(retention_until) and length(deployment_id) between 1 and 256 and deployment_id !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "sparra_audio_chunk" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sparra_audio_quota" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"reserved_bytes" integer DEFAULT 0 NOT NULL,
	"charged_bytes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sparra_audio_quota_budget" CHECK (reserved_bytes >= 0 and charged_bytes >= 0 and reserved_bytes + charged_bytes <= 536870912)
);
--> statement-breakpoint
ALTER TABLE "sparra_audio_quota" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "recording_id" uuid;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "audio_state" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "audio_reserved_bytes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "audio_charged_bytes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "audio_denied_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "audio_total_samples" integer;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "audio_last_sequence" integer;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "audio_finish_reason" text;--> statement-breakpoint
ALTER TABLE "sparra_audio_chunk" ADD CONSTRAINT "sparra_audio_chunk_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sparra_audio_chunk" ADD CONSTRAINT "sparra_audio_chunk_call_id_sparra_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."sparra_call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sparra_audio_quota" ADD CONSTRAINT "sparra_audio_quota_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD CONSTRAINT "sparra_call_audio_state" CHECK (audio_state in ('off','unavailable','pending','recording','ready','partial','declined','expired','deletion_pending','deleted'));--> statement-breakpoint
ALTER TABLE "sparra_call" ADD CONSTRAINT "sparra_call_audio_budget" CHECK (audio_reserved_bytes >= 0 and audio_charged_bytes >= 0 and audio_reserved_bytes + audio_charged_bytes <= 20447648);--> statement-breakpoint
ALTER TABLE "sparra_call" ADD CONSTRAINT "sparra_call_audio_identity" CHECK (recording_id is not null or (audio_reserved_bytes = 0 and audio_charged_bytes = 0 and audio_state in ('off','unavailable')));--> statement-breakpoint
ALTER TABLE "sparra_call" ADD CONSTRAINT "sparra_call_audio_denied" CHECK (audio_denied_at is null or isfinite(audio_denied_at));--> statement-breakpoint
ALTER TABLE "sparra_call" ADD CONSTRAINT "sparra_call_audio_finish" CHECK ((audio_finish_reason is null and audio_total_samples is null and audio_last_sequence is null) or (audio_finish_reason is not null and audio_finish_reason in ('complete','transfer','interrupted','limit','failure') and audio_total_samples is not null and audio_total_samples between 0 and 4800000 and ((audio_total_samples = 0 and audio_last_sequence is null) or (audio_total_samples > 0 and audio_last_sequence is not null and audio_last_sequence between 0 and 599 and audio_total_samples between audio_last_sequence + 1 and (audio_last_sequence + 1) * 8000))));--> statement-breakpoint
CREATE POLICY "sparra_audio_chunk_voice" ON "sparra_audio_chunk" AS PERMISSIVE FOR ALL TO "sparra_voice_definer" USING (workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment()) WITH CHECK (workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment());--> statement-breakpoint
CREATE POLICY "sparra_audio_chunk_erase_read" ON "sparra_audio_chunk" AS PERMISSIVE FOR SELECT TO "workspace_owner" USING ("sparra_audio_chunk"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "sparra_audio_chunk_erase_delete" ON "sparra_audio_chunk" AS PERMISSIVE FOR DELETE TO "workspace_owner" USING ("sparra_audio_chunk"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "sparra_audio_quota_voice" ON "sparra_audio_quota" AS PERMISSIVE FOR ALL TO "sparra_voice_definer" USING (workspace_id = voice_private.bound_workspace()) WITH CHECK (workspace_id = voice_private.bound_workspace());--> statement-breakpoint
CREATE POLICY "sparra_audio_quota_owner_read" ON "sparra_audio_quota" AS PERMISSIVE FOR SELECT TO "workspace_owner" USING ("sparra_audio_quota"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "sparra_audio_quota_owner_update" ON "sparra_audio_quota" AS PERMISSIVE FOR UPDATE TO "workspace_owner" USING ("sparra_audio_quota"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000') WITH CHECK ("sparra_audio_quota"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000');
--> statement-breakpoint
-- Tables remain behind the existing machine binding and owner erase authority.
ALTER TABLE public.sparra_audio_chunk OWNER TO workspace_owner;
ALTER TABLE public.sparra_audio_quota OWNER TO workspace_owner;
ALTER TABLE public.sparra_audio_chunk FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sparra_audio_quota FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sparra_audio_chunk,public.sparra_audio_quota FROM PUBLIC,runtime,workspace_bootstrap;
GRANT SELECT,INSERT,DELETE ON public.sparra_audio_chunk TO sparra_voice_definer;
GRANT SELECT,INSERT,UPDATE ON public.sparra_audio_quota TO sparra_voice_definer;
GRANT UPDATE(recording_id,audio_state,audio_reserved_bytes,audio_charged_bytes,audio_denied_at,audio_total_samples,audio_last_sequence,audio_finish_reason) ON public.sparra_call TO sparra_voice_definer;
--> statement-breakpoint
CREATE FUNCTION voice_private.audio_control_bytes(c public.sparra_call) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN c.recording_id IS NULL THEN 0 ELSE octet_length(convert_to(jsonb_build_object(
  'workspace_id',c.workspace_id,'deployment_id',c.deployment_id,'call_id',c.id,'recording_id',c.recording_id,
  'configuration_revision',c.configuration_revision,'retention_until',voice_private.iso(c.retention_until),
  'audio_state',c.audio_state,'denied_at',CASE WHEN c.audio_denied_at IS NULL THEN NULL ELSE voice_private.iso(c.audio_denied_at) END,
  'total_samples',c.audio_total_samples,'last_sequence',c.audio_last_sequence,'finish_reason',c.audio_finish_reason
 )::text,'UTF8')) END
$$;
ALTER FUNCTION voice_private.audio_control_bytes(public.sparra_call) OWNER TO sparra_voice_definer;
REVOKE ALL ON FUNCTION voice_private.audio_control_bytes(public.sparra_call) FROM PUBLIC,runtime,workspace_bootstrap;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION voice.begin_call_v2(deployment text,call_id uuid,routing jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE b voice_private.deployment_binding; c public.sparra_call; k public.sparra_knowledge_revision;
 q public.sparra_audio_quota; admitted timestamptz; provider text; leg text; session_id text; caller text;
 fresh boolean; metadata_bytes integer;
BEGIN
 IF deployment IS NULL OR call_id IS NULL OR routing IS NULL THEN RAISE EXCEPTION 'Voice begin contract' USING ERRCODE='PV202';END IF;
 b=voice_private.lock_binding();
 IF b.contract_version<>2 OR deployment<>b.deployment_id OR NOT b.admission_enabled
 OR NOT EXISTS(SELECT 1 FROM public.workspace WHERE id=b.workspace_id AND kind='personal' AND lifecycle='active' AND auth_organization_id IS NULL)
 THEN RAISE EXCEPTION 'Voice admission unavailable' USING ERRCODE='PV202';END IF;
 PERFORM voice_private.object_keys(routing,ARRAY['schema_version','direction','connection_id','to_e164','from_e164','telnyx_call_control_id','telnyx_call_leg_id','telnyx_call_session_id','admitted_at']);
 PERFORM voice_private.integer_value(routing->'schema_version',1,1);
 provider=voice_private.string_value(routing->'telnyx_call_control_id',1024);
 leg=voice_private.string_value(routing->'telnyx_call_leg_id',1024,true);
 session_id=voice_private.string_value(routing->'telnyx_call_session_id',1024,true);
 caller=voice_private.string_value(routing->'from_e164',16,true);
 admitted=voice_private.instant(routing->'admitted_at');
 IF octet_length(routing::text)>8192 OR voice_private.string_value(routing->'direction',16)<>'incoming'
 OR voice_private.string_value(routing->'connection_id',256)<>b.connection_id OR voice_private.string_value(routing->'to_e164',16)<>b.to_e164
 OR (caller IS NOT NULL AND caller !~ '^\+[1-9][0-9]{1,14}$') OR routing->>'admitted_at'<>voice_private.iso(admitted)
 THEN RAISE EXCEPTION 'Voice routing contract' USING ERRCODE='PV202';END IF;
 IF clock_timestamp()-admitted>interval '300 seconds' OR admitted-clock_timestamp()>interval '30 seconds'
 THEN RAISE EXCEPTION 'Voice admission expired' USING ERRCODE='PV202';END IF;
 IF EXISTS(SELECT 1 FROM public.sparra_erasure e WHERE e.call_id=begin_call_v2.call_id OR e.provider_call_control_id=provider)
 THEN RAISE EXCEPTION 'Voice admission erased' USING ERRCODE='PV202';END IF;
 SELECT * INTO c FROM public.sparra_call x WHERE x.id=begin_call_v2.call_id OR x.provider_call_control_id=provider FOR UPDATE;
 IF FOUND AND (c.id<>call_id OR c.provider_call_control_id<>provider OR c.provider_call_leg_id IS DISTINCT FROM leg
 OR c.provider_call_session_id IS DISTINCT FROM session_id OR c.admitted_at<>admitted OR c.retention_until<=clock_timestamp()
 OR c.status IN ('failed','closed') OR c.erasure_requested_at IS NOT NULL
 OR (c.connection_id IS NOT NULL AND ROW(c.connection_id,c.to_e164,c.from_e164) IS DISTINCT FROM ROW(b.connection_id,b.to_e164,caller)))
 THEN RAISE EXCEPTION 'Voice admission conflict' USING ERRCODE='PV202';END IF;
 fresh=c.configuration_revision IS NULL;
 SELECT * INTO k FROM public.sparra_knowledge_revision x
 WHERE x.workspace_id=b.workspace_id AND (c.configuration_revision IS NULL OR x.revision=c.configuration_revision)
 ORDER BY revision DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'Voice configuration unavailable' USING ERRCODE='PV202';END IF;
 IF k.recording_policy='local_30d' AND (k.recording_contact_phone IS NULL
 OR voice_private.string_value(to_jsonb(k.recording_contact_phone),16) !~ '^\+[1-9][0-9]{1,14}$')
 THEN RAISE EXCEPTION 'Voice audio contact unavailable' USING ERRCODE='PV202';END IF;
 IF c.id IS NULL THEN
  INSERT INTO public.sparra_call(id,workspace_id,configuration_revision,deployment_id,provider_call_control_id,provider_call_leg_id,provider_call_session_id,admitted_at,retention_until,connection_id,to_e164,from_e164)
  VALUES(call_id,b.workspace_id,k.revision,b.deployment_id,provider,leg,session_id,admitted,admitted+interval '2592000 seconds',b.connection_id,b.to_e164,caller)
  RETURNING * INTO c;
 ELSE
  UPDATE public.sparra_call SET configuration_revision=k.revision,connection_id=b.connection_id,to_e164=b.to_e164,from_e164=caller
  WHERE id=c.id RETURNING * INTO c;
 END IF;
 IF fresh THEN
  IF k.recording_policy='local_30d' AND b.local_audio_enabled THEN
   INSERT INTO public.sparra_audio_quota(workspace_id) VALUES(b.workspace_id) ON CONFLICT DO NOTHING;
   SELECT * INTO q FROM public.sparra_audio_quota WHERE workspace_id=b.workspace_id FOR UPDATE;
   IF q.reserved_bytes+q.charged_bytes <= 536870912-20447648 THEN
    UPDATE public.sparra_call SET recording_id=gen_random_uuid(),audio_state='pending' WHERE id=c.id RETURNING * INTO c;
    metadata_bytes=voice_private.audio_control_bytes(c);
    IF metadata_bytes>2048 THEN RAISE EXCEPTION 'Voice audio metadata bound' USING ERRCODE='PV202';END IF;
    UPDATE public.sparra_call SET audio_reserved_bytes=20447648-metadata_bytes,audio_charged_bytes=metadata_bytes
    WHERE id=c.id RETURNING * INTO c;
    UPDATE public.sparra_audio_quota SET reserved_bytes=reserved_bytes+20447648-metadata_bytes,charged_bytes=charged_bytes+metadata_bytes
    WHERE workspace_id=b.workspace_id;
   ELSE
    UPDATE public.sparra_call SET audio_state='unavailable' WHERE id=c.id RETURNING * INTO c;
   END IF;
  ELSE
   UPDATE public.sparra_call SET audio_state=CASE WHEN k.recording_policy='local_30d' THEN 'unavailable' ELSE 'off' END
   WHERE id=c.id RETURNING * INTO c;
  END IF;
 END IF;
 -- Availability is the original admission reservation, never caller consent.
 RETURN jsonb_build_object('schema_version',2,'workspace_id',b.workspace_id,'call_id',call_id,'configuration_revision',k.revision,
 'knowledge',jsonb_build_object('business_name',k.business_name,'sector',k.sector,'opening_hours',k.opening_hours,'services',k.services,'prices',k.prices,'faq',k.faq,'instructions',k.instructions),
 'transfer_destination',k.transfer_destination,'retention_until',voice_private.iso(c.retention_until),
 'recording_policy',k.recording_policy,'recording_contact_phone',k.recording_contact_phone,
 'audio_available',c.recording_id IS NOT NULL,'recording_id',c.recording_id);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Voice admission conflict' USING ERRCODE='PV202';
END $$;

ALTER FUNCTION voice.begin_call_v2(text,uuid,jsonb) OWNER TO sparra_voice_definer;
REVOKE ALL ON FUNCTION voice.begin_call_v2(text,uuid,jsonb) FROM PUBLIC,runtime,workspace_bootstrap;
-- Operator provisioning selects fixed V2 wrappers plus the unchanged four
-- cleanup RPCs only after the whole capture/store/reader contract is qualified.
--> statement-breakpoint
CREATE FUNCTION voice_private.validate_audio_operation(op jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE p jsonb; k text; total bigint; last_seq bigint; n text; ct text; nb bytea; cb bytea;
BEGIN
 PERFORM voice_private.object_keys(op,ARRAY['schema_version','operation_id','deployment_id','call_id','occurred_at','kind','payload']);
 PERFORM voice_private.integer_value(op->'schema_version',2,2);
 PERFORM voice_private.uuid_value(op->'operation_id');PERFORM voice_private.uuid_value(op->'call_id');
 IF length(voice_private.string_value(op->'deployment_id',1024))>256 THEN RAISE EXCEPTION 'Voice deployment contract' USING ERRCODE='PV202';END IF;
 PERFORM voice_private.instant(op->'occurred_at');k=voice_private.string_value(op->'kind',32);p=op->'payload';
 IF k IN ('call.upsert','turn.upsert','recording.upsert') THEN
  -- Validation-only header view reuses the unchanged V1 payload contracts.
  -- The original V2 operation is still the ingested/digested/receipted object.
  PERFORM voice_private.validate_operation(jsonb_set(op,'{schema_version}','1'::jsonb,false));RETURN;
 END IF;
 IF k='audio.chunk' THEN
  PERFORM voice_private.object_keys(p,ARRAY['schema_version','workspace_id','recording_id','configuration_revision','retention_until','sequence','sample_count','sample_rate','channels','sample_format','crypto_version','key_version','nonce_b64','ciphertext_b64']);
  PERFORM voice_private.integer_value(p->'sequence',0,599);PERFORM voice_private.integer_value(p->'sample_count',1,8000);
  PERFORM voice_private.integer_value(p->'sample_rate',8000,8000);PERFORM voice_private.integer_value(p->'channels',2,2);
  IF voice_private.string_value(p->'sample_format',8)<>'s16le' THEN RAISE EXCEPTION 'Voice audio format' USING ERRCODE='PV202';END IF;
  PERFORM voice_private.integer_value(p->'crypto_version',1,1);PERFORM voice_private.integer_value(p->'key_version',1,9007199254740991);
  n=voice_private.string_value(p->'nonce_b64',16);ct=voice_private.string_value(p->'ciphertext_b64',42688);
  BEGIN nb=decode(n,'base64');cb=decode(ct,'base64');
  EXCEPTION WHEN invalid_parameter_value THEN RAISE EXCEPTION 'Voice audio envelope' USING ERRCODE='PV202';END;
  IF octet_length(nb)<>12 OR octet_length(cb)<>voice_private.integer_value(p->'sample_count',1,8000)*4+16
  OR replace(encode(nb,'base64'),chr(10),'')<>n OR replace(encode(cb,'base64'),chr(10),'')<>ct
  THEN RAISE EXCEPTION 'Voice audio envelope' USING ERRCODE='PV202';END IF;
 ELSIF k='audio.finish' THEN
  PERFORM voice_private.object_keys(p,ARRAY['schema_version','workspace_id','recording_id','configuration_revision','retention_until','last_sequence','total_samples','reason']);
  total=voice_private.integer_value(p->'total_samples',0,4800000);
  IF p->'last_sequence'='null'::jsonb THEN
   IF total<>0 THEN RAISE EXCEPTION 'Voice audio finish' USING ERRCODE='PV202';END IF;
  ELSE
   last_seq=voice_private.integer_value(p->'last_sequence',0,599);
   IF total NOT BETWEEN last_seq+1 AND (last_seq+1)*8000 THEN RAISE EXCEPTION 'Voice audio finish' USING ERRCODE='PV202';END IF;
  END IF;
  IF voice_private.string_value(p->'reason',16) NOT IN ('complete','transfer','interrupted','limit','failure') THEN RAISE EXCEPTION 'Voice audio finish' USING ERRCODE='PV202';END IF;
 ELSIF k='audio.revoke' THEN
  PERFORM voice_private.object_keys(p,ARRAY['schema_version','workspace_id','recording_id','configuration_revision','retention_until','reason']);
  IF voice_private.string_value(p->'reason',16)<>'caller_declined' THEN RAISE EXCEPTION 'Voice audio denial' USING ERRCODE='PV202';END IF;
 ELSE RAISE EXCEPTION 'Voice operation kind' USING ERRCODE='PV202';
 END IF;
 PERFORM voice_private.integer_value(p->'schema_version',2,2);
 PERFORM voice_private.uuid_value(p->'workspace_id');PERFORM voice_private.uuid_value(p->'recording_id');
 PERFORM voice_private.integer_value(p->'configuration_revision',1,2147483647);
 IF p->>'retention_until'<>voice_private.iso(voice_private.instant(p->'retention_until')) OR octet_length(op::text)>65536
 THEN RAISE EXCEPTION 'Voice audio contract' USING ERRCODE='PV202';END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION voice_private.audio_account(old_call public.sparra_call,next_reserved integer,next_charged integer) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF next_reserved IS NULL OR next_charged IS NULL OR next_reserved<0 OR next_charged<0 OR next_reserved+next_charged>20447648
 THEN RAISE EXCEPTION 'Voice audio budget' USING ERRCODE='PV202';END IF;
 UPDATE public.sparra_audio_quota SET reserved_bytes=reserved_bytes-old_call.audio_reserved_bytes+next_reserved,
 charged_bytes=charged_bytes-old_call.audio_charged_bytes+next_charged
 WHERE workspace_id=old_call.workspace_id AND reserved_bytes>=old_call.audio_reserved_bytes AND charged_bytes>=old_call.audio_charged_bytes;
 IF NOT FOUND THEN RAISE EXCEPTION 'Voice audio quota unavailable' USING ERRCODE='PV202';END IF;
 UPDATE public.sparra_call SET audio_reserved_bytes=next_reserved,audio_charged_bytes=next_charged WHERE id=old_call.id;
END $$;
--> statement-breakpoint
CREATE FUNCTION voice_private.ingest_audio(op jsonb,c public.sparra_call) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE p jsonb=op->'payload'; kind text=op->>'kind'; previous public.sparra_audio_chunk; updated public.sparra_call;
 packet_charge integer=0; metadata_bytes integer; old_control integer; next_control integer; next_charged integer; next_reserved integer;
 chunk_rows integer; stored_samples bigint; first_seq integer; last_seq integer; settled boolean=false; expected_seq integer;
BEGIN
 old_control=voice_private.audio_control_bytes(c);
 IF kind='audio.chunk' THEN
  IF c.input_gate_opened_at IS NULL OR c.disclosure_completed_at IS NULL THEN RAISE EXCEPTION 'Voice audio gate unavailable' USING ERRCODE='PV202';END IF;
  -- This gate is trusted machine evidence, not a SQL proof of caller choice.
  -- Task2 must durably accept caller1 before emitting any audio operation.
  IF c.audio_finish_reason IS NOT NULL AND ((p->>'sequence')::integer>coalesce(c.audio_last_sequence,-1))
  THEN RAISE EXCEPTION 'Voice audio tail outside finish' USING ERRCODE='PV202';END IF;
  SELECT * INTO previous FROM public.sparra_audio_chunk WHERE workspace_id=c.workspace_id AND call_id=c.id AND recording_id=c.recording_id AND sequence=(p->>'sequence')::integer;
  IF FOUND THEN
   IF ROW(previous.configuration_revision,previous.retention_until,previous.sample_count,previous.sample_rate,previous.channels,previous.sample_format,previous.crypto_version,previous.key_version,previous.nonce,previous.ciphertext)
   IS DISTINCT FROM ROW(c.configuration_revision,c.retention_until,(p->>'sample_count')::integer,8000,2,'s16le',(p->>'crypto_version')::integer,(p->>'key_version')::bigint,decode(p->>'nonce_b64','base64'),decode(p->>'ciphertext_b64','base64'))
   THEN RETURN 'conflict';END IF;
   RETURN 'applied';
  END IF;
  metadata_bytes=octet_length(convert_to(((op-'payload')||(p-'nonce_b64'-'ciphertext_b64'))::text,'UTF8'));
  IF metadata_bytes>2048 THEN RAISE EXCEPTION 'Voice audio metadata bound' USING ERRCODE='PV202';END IF;
  packet_charge=12+octet_length(decode(p->>'ciphertext_b64','base64'))+metadata_bytes;
  IF c.audio_reserved_bytes<packet_charge THEN RAISE EXCEPTION 'Voice audio reservation exhausted' USING ERRCODE='PV202';END IF;
  INSERT INTO public.sparra_audio_chunk(workspace_id,call_id,recording_id,deployment_id,sequence,configuration_revision,retention_until,sample_count,sample_rate,channels,sample_format,crypto_version,key_version,nonce,ciphertext,charged_bytes)
  VALUES(c.workspace_id,c.id,c.recording_id,c.deployment_id,(p->>'sequence')::integer,c.configuration_revision,c.retention_until,(p->>'sample_count')::integer,8000,2,'s16le',1,(p->>'key_version')::bigint,decode(p->>'nonce_b64','base64'),decode(p->>'ciphertext_b64','base64'),packet_charge);
  IF c.audio_finish_reason IS NULL THEN UPDATE public.sparra_call SET audio_state='recording' WHERE id=c.id;END IF;
 ELSIF kind='audio.finish' THEN
  expected_seq=CASE WHEN p->'last_sequence'='null'::jsonb THEN NULL ELSE (p->>'last_sequence')::integer END;
  IF c.audio_finish_reason IS NOT NULL AND ROW(c.audio_last_sequence,c.audio_total_samples,c.audio_finish_reason)
  IS DISTINCT FROM ROW(expected_seq,(p->>'total_samples')::integer,p->>'reason') THEN RETURN 'conflict';END IF;
  UPDATE public.sparra_call SET audio_last_sequence=expected_seq,audio_total_samples=(p->>'total_samples')::integer,audio_finish_reason=p->>'reason' WHERE id=c.id;
 ELSE
  DELETE FROM public.sparra_audio_chunk WHERE workspace_id=c.workspace_id AND call_id=c.id AND recording_id=c.recording_id;
  UPDATE public.sparra_call SET audio_denied_at=coalesce(audio_denied_at,date_trunc('milliseconds',clock_timestamp())),audio_state='declined' WHERE id=c.id RETURNING * INTO updated;
  next_control=voice_private.audio_control_bytes(updated);
  IF next_control>2048 THEN RAISE EXCEPTION 'Voice audio metadata bound' USING ERRCODE='PV202';END IF;
  PERFORM voice_private.audio_account(c,0,next_control);RETURN 'applied';
 END IF;
 SELECT * INTO updated FROM public.sparra_call WHERE id=c.id;
 IF updated.audio_finish_reason IS NOT NULL THEN
  -- At most600 rows for this recording; never aggregate historic Workspaces.
  SELECT count(*)::integer,coalesce(sum(sample_count),0),min(sequence),max(sequence)
  INTO chunk_rows,stored_samples,first_seq,last_seq FROM public.sparra_audio_chunk
  WHERE workspace_id=c.workspace_id AND call_id=c.id AND recording_id=c.recording_id;
  settled=(updated.audio_total_samples=0 AND chunk_rows=0) OR
   (chunk_rows=updated.audio_last_sequence+1 AND first_seq=0 AND last_seq=updated.audio_last_sequence AND stored_samples=updated.audio_total_samples);
  UPDATE public.sparra_call SET audio_state=CASE WHEN chunk_rows=0 THEN 'unavailable'
   WHEN settled AND updated.audio_finish_reason='complete' THEN 'ready' ELSE 'partial' END WHERE id=c.id RETURNING * INTO updated;
 END IF;
 next_control=voice_private.audio_control_bytes(updated);
 IF next_control>2048 THEN RAISE EXCEPTION 'Voice audio metadata bound' USING ERRCODE='PV202';END IF;
 next_charged=c.audio_charged_bytes+packet_charge+next_control-old_control;
 next_reserved=CASE WHEN settled THEN 0 ELSE c.audio_reserved_bytes-packet_charge-(next_control-old_control) END;
 PERFORM voice_private.audio_account(c,next_reserved,next_charged);RETURN 'applied';
END $$;

--> statement-breakpoint
CREATE FUNCTION voice_private.ingest_contract(op jsonb,expected_version integer) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE b voice_private.deployment_binding; c public.sparra_call; fence public.sparra_erasure; rec voice_private.recording_purge; p jsonb; ev jsonb; cid uuid; oid uuid; occurred timestamptz; retention timestamptz; digest text; old_digest text; kind text; answer text='applied'; rank integer; reason_wins boolean; merged jsonb; actual_provider text; dead boolean; ar jsonb; archive_allowed boolean=false;
BEGIN
 b=voice_private.lock_binding();
 IF expected_version IS NULL OR expected_version NOT IN (1,2) OR b.contract_version<>expected_version THEN RAISE EXCEPTION 'Voice contract unavailable' USING ERRCODE='PV202';END IF;
 IF expected_version=1 THEN PERFORM voice_private.validate_operation(op);ELSE PERFORM voice_private.validate_audio_operation(op);END IF;
 IF op->>'deployment_id'<>b.deployment_id THEN RAISE EXCEPTION 'Voice deployment unavailable' USING ERRCODE='PV202';END IF;
 cid=(op->>'call_id')::uuid;oid=(op->>'operation_id')::uuid;p=op->'payload';kind=op->>'kind';occurred=voice_private.instant(op->'occurred_at');digest=encode(sha256(convert_to(op::text,'UTF8')),'hex');
 SELECT * INTO c FROM public.sparra_call WHERE id=cid FOR UPDATE;
 SELECT * INTO fence FROM public.sparra_erasure WHERE call_id=cid;
 actual_provider=CASE WHEN kind='recording.upsert' THEN p->>'telnyx_recording_id' ELSE NULL END;
 dead=fence.call_id IS NOT NULL OR (c.id IS NOT NULL AND (c.retention_until<=clock_timestamp() OR c.erasure_requested_at IS NOT NULL));
 -- Only a correlated real recording identity may bypass content admission.
 IF (actual_provider IS NULL AND NOT (kind='audio.revoke' AND (c.id IS NOT NULL OR fence.call_id IS NOT NULL))) OR (c.id IS NULL AND fence.call_id IS NULL) THEN
  IF NOT b.admission_enabled OR NOT EXISTS(SELECT 1 FROM public.workspace w WHERE w.id=b.workspace_id AND w.lifecycle='active' AND w.kind='personal' AND w.auth_organization_id IS NULL) THEN RAISE EXCEPTION 'Voice admission unavailable' USING ERRCODE='PV202';END IF;
 END IF;
 SELECT payload_sha256 INTO old_digest FROM voice_private.operation_receipt WHERE deployment_id=b.deployment_id AND operation_id=oid;
 IF FOUND AND old_digest<>digest THEN
  RETURN jsonb_build_object('schema_version',expected_version,'status','conflict','operation_id',oid,'payload_sha256',digest);
 END IF;
 IF dead AND actual_provider IS NULL AND kind<>'audio.revoke' THEN RAISE EXCEPTION 'Voice call erased' USING ERRCODE='PV301';END IF;
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
 IF kind IN ('audio.chunk','audio.finish','audio.revoke') THEN
  IF (p->>'workspace_id')::uuid<>b.workspace_id OR voice_private.instant(p->'retention_until')<>retention
  THEN RAISE EXCEPTION 'Voice audio pin conflict' USING ERRCODE='PV202';END IF;
  IF c.id IS NOT NULL THEN
   IF c.recording_id IS NULL OR c.configuration_revision IS DISTINCT FROM (p->>'configuration_revision')::integer OR c.recording_id<>(p->>'recording_id')::uuid
   OR occurred<c.admitted_at THEN RAISE EXCEPTION 'Voice audio pin conflict' USING ERRCODE='PV202';END IF;
   IF kind<>'audio.revoke' AND c.audio_denied_at IS NOT NULL THEN RAISE EXCEPTION 'Voice audio denied' USING ERRCODE='PV301';END IF;
  END IF;
 END IF;
 IF old_digest IS NOT NULL THEN
  RETURN jsonb_build_object('schema_version',expected_version,'status','duplicate','operation_id',oid,'payload_sha256',digest);
 END IF;
 IF kind IN ('audio.chunk','audio.finish','audio.revoke') THEN
  IF c.id IS NOT NULL THEN answer=voice_private.ingest_audio(op,c);END IF;
 ELSIF kind='call.upsert' THEN
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
 RETURN jsonb_build_object('schema_version',expected_version,'status',answer,'operation_id',oid,'payload_sha256',digest);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Voice identity conflict' USING ERRCODE='PV202';
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION voice.ingest_operation_v1(op jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT voice_private.ingest_contract(op,1) $$;
CREATE FUNCTION voice.ingest_operation_v2(op jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT voice_private.ingest_contract(op,2) $$;
ALTER FUNCTION voice.ingest_operation_v2(jsonb) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.validate_audio_operation(jsonb) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.audio_account(public.sparra_call,integer,integer) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.ingest_audio(jsonb,public.sparra_call) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.ingest_contract(jsonb,integer) OWNER TO sparra_voice_definer;
REVOKE ALL ON FUNCTION voice.ingest_operation_v2(jsonb),voice_private.validate_audio_operation(jsonb),
 voice_private.audio_account(public.sparra_call,integer,integer),voice_private.ingest_audio(jsonb,public.sparra_call),
 voice_private.ingest_contract(jsonb,integer) FROM PUBLIC,runtime,workspace_bootstrap;
--> statement-breakpoint
CREATE FUNCTION app_private.sparra_audio_before_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF OLD.audio_reserved_bytes=0 AND OLD.audio_charged_bytes=0 THEN RETURN OLD;END IF;
 -- Existing owner erase and voice maintenance hold the Workspace lock and
 -- supply the OLD-derived native tenant before this parent delete.
 IF current_setting('app.tenant_id',true) IS DISTINCT FROM OLD.workspace_id::text
 THEN RAISE EXCEPTION 'Audio cleanup authority unavailable' USING ERRCODE='23514';END IF;
 UPDATE public.sparra_audio_quota SET reserved_bytes=reserved_bytes-OLD.audio_reserved_bytes,
 charged_bytes=charged_bytes-OLD.audio_charged_bytes
 WHERE workspace_id=OLD.workspace_id AND reserved_bytes>=OLD.audio_reserved_bytes AND charged_bytes>=OLD.audio_charged_bytes;
 IF NOT FOUND THEN RAISE EXCEPTION 'Audio cleanup quota unavailable' USING ERRCODE='23514';END IF;
 DELETE FROM public.sparra_audio_chunk WHERE workspace_id=OLD.workspace_id AND call_id=OLD.id;
 RETURN OLD;
END $$;
ALTER FUNCTION app_private.sparra_audio_before_delete() OWNER TO workspace_owner;
REVOKE ALL ON FUNCTION app_private.sparra_audio_before_delete() FROM PUBLIC,runtime,workspace_bootstrap,sparra_voice_definer;
CREATE TRIGGER sparra_audio_before_delete BEFORE DELETE ON public.sparra_call
FOR EACH ROW EXECUTE FUNCTION app_private.sparra_audio_before_delete();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION voice_private.complete_erasure(cid uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 UPDATE public.sparra_erasure SET state='completed',completed_at=clock_timestamp()
 WHERE call_id=cid AND state='queued' AND local_cleanup_completed_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM public.sparra_audio_chunk WHERE call_id=cid)
 AND NOT EXISTS(SELECT 1 FROM public.sparra_call WHERE id=cid AND (audio_reserved_bytes<>0 OR audio_charged_bytes<>0))
 AND NOT EXISTS(SELECT 1 FROM voice_private.recording_purge WHERE call_id=cid AND coalesce(outcome,'') NOT IN ('deleted','not_found'));
 -- Local cleanup ACK keeps its existing authority. Task2 extends its real
 -- producer barrier to audio; Task3 must add reader-holder joins before any
 -- optional-audio runtime activation. This stage certifies PG cleanup only.
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION voice.begin_call_v1(deployment text,call_id uuid,routing jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE b voice_private.deployment_binding; c public.sparra_call; k public.sparra_knowledge_revision; admitted timestamptz; provider text; leg text; session_id text; caller text;
BEGIN
 IF deployment IS NULL OR call_id IS NULL OR routing IS NULL THEN RAISE EXCEPTION 'Voice begin contract' USING ERRCODE='PV202';END IF;
 b=voice_private.lock_binding();
 IF b.contract_version<>1 THEN RAISE EXCEPTION 'Voice contract unavailable' USING ERRCODE='PV202';END IF;
 IF deployment<>b.deployment_id OR NOT b.admission_enabled OR NOT EXISTS(SELECT 1 FROM public.workspace WHERE id=b.workspace_id AND kind='personal' AND lifecycle='active' AND auth_organization_id IS NULL) THEN RAISE EXCEPTION 'Voice admission unavailable' USING ERRCODE='PV202';END IF;
 PERFORM voice_private.object_keys(routing,ARRAY['schema_version','direction','connection_id','to_e164','from_e164','telnyx_call_control_id','telnyx_call_leg_id','telnyx_call_session_id','admitted_at']);PERFORM voice_private.integer_value(routing->'schema_version',1,1);
 provider=voice_private.string_value(routing->'telnyx_call_control_id',1024);leg=voice_private.string_value(routing->'telnyx_call_leg_id',1024,true);session_id=voice_private.string_value(routing->'telnyx_call_session_id',1024,true);caller=voice_private.string_value(routing->'from_e164',16,true);admitted=voice_private.instant(routing->'admitted_at');
 IF octet_length(routing::text)>8192 OR voice_private.string_value(routing->'direction',16)<>'incoming' OR voice_private.string_value(routing->'connection_id',256)<>b.connection_id OR voice_private.string_value(routing->'to_e164',16)<>b.to_e164 OR caller !~ '^\+[1-9][0-9]{1,14}$' OR routing->>'admitted_at'<>voice_private.iso(admitted) THEN RAISE EXCEPTION 'Voice routing contract' USING ERRCODE='PV202';END IF;
 IF clock_timestamp()-admitted>interval '300 seconds' OR admitted-clock_timestamp()>interval '30 seconds' THEN RAISE EXCEPTION 'Voice admission expired' USING ERRCODE='PV202';END IF;
 IF EXISTS(SELECT 1 FROM public.sparra_erasure e WHERE e.call_id=begin_call_v1.call_id OR e.provider_call_control_id=provider) THEN RAISE EXCEPTION 'Voice admission erased' USING ERRCODE='PV202';END IF;
 SELECT * INTO c FROM public.sparra_call x WHERE x.id=begin_call_v1.call_id OR x.provider_call_control_id=provider FOR UPDATE;
 IF FOUND THEN
  IF c.id<>call_id OR c.provider_call_control_id<>provider OR c.provider_call_leg_id IS DISTINCT FROM leg OR c.provider_call_session_id IS DISTINCT FROM session_id OR c.admitted_at<>admitted OR c.retention_until<=clock_timestamp() OR c.status IN ('failed','closed') OR c.erasure_requested_at IS NOT NULL OR (c.connection_id IS NOT NULL AND ROW(c.connection_id,c.to_e164,c.from_e164) IS DISTINCT FROM ROW(b.connection_id,b.to_e164,caller)) THEN RAISE EXCEPTION 'Voice admission conflict' USING ERRCODE='PV202';END IF;
 END IF;
 SELECT * INTO k FROM public.sparra_knowledge_revision x WHERE x.workspace_id=b.workspace_id AND (c.configuration_revision IS NULL OR x.revision=c.configuration_revision) ORDER BY revision DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'Voice configuration unavailable' USING ERRCODE='PV202';END IF;
 IF k.recording_enabled AND NOT b.audio_enabled THEN RAISE EXCEPTION 'Voice audio unavailable' USING ERRCODE='PV202';END IF;
 IF c.id IS NULL THEN
  INSERT INTO public.sparra_call(id,workspace_id,configuration_revision,deployment_id,provider_call_control_id,provider_call_leg_id,provider_call_session_id,admitted_at,retention_until,connection_id,to_e164,from_e164)
   VALUES(call_id,b.workspace_id,k.revision,b.deployment_id,provider,leg,session_id,admitted,admitted+interval '2592000 seconds',b.connection_id,b.to_e164,caller);
 ELSE
  UPDATE public.sparra_call SET configuration_revision=k.revision,connection_id=b.connection_id,to_e164=b.to_e164,from_e164=caller WHERE id=c.id;
 END IF;
 RETURN jsonb_build_object('schema_version',1,'call_id',call_id,'configuration_revision',k.revision,'recording_enabled',k.recording_enabled,'knowledge',jsonb_build_object('business_name',k.business_name,'sector',k.sector,'opening_hours',k.opening_hours,'services',k.services,'prices',k.prices,'faq',k.faq,'instructions',k.instructions),'transfer_destination',k.transfer_destination,'retention_until',voice_private.iso(admitted+interval '2592000 seconds'));
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Voice admission conflict' USING ERRCODE='PV202';
END $$;
