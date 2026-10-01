-- Canonical procedural source. Operator creates roles; application never does.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='sparra_voice_definer'
    AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid OR r.oid=m.member WHERE r.rolname='sparra_voice_definer') THEN
    RAISE EXCEPTION 'Voice role prerequisites not satisfied';
  END IF;
END $$;
CREATE SCHEMA voice AUTHORIZATION workspace_owner;
CREATE SCHEMA voice_private AUTHORIZATION workspace_owner;
REVOKE ALL ON SCHEMA voice,voice_private FROM PUBLIC,runtime,workspace_bootstrap;
GRANT USAGE ON SCHEMA voice_private,public TO sparra_voice_definer;
--> statement-breakpoint
CREATE TABLE "voice_private"."deployment_binding" (
	"service_login" "name" PRIMARY KEY NOT NULL,
	"service_role_oid" "oid" NOT NULL,
	"deployment_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"to_e164" text NOT NULL,
	"admission_enabled" boolean DEFAULT false NOT NULL,
	"audio_enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "deployment_binding_service_role_oid_unique" UNIQUE("service_role_oid"),
	CONSTRAINT "deployment_binding_deployment_id_unique" UNIQUE("deployment_id"),
	CONSTRAINT "voice_binding_deployment" CHECK (length("voice_private"."deployment_binding"."deployment_id") between 1 and 256 and "voice_private"."deployment_binding"."deployment_id" !~ '[[:cntrl:]]'),
	CONSTRAINT "voice_binding_connection" CHECK (octet_length("voice_private"."deployment_binding"."connection_id") between 1 and 256 and "voice_private"."deployment_binding"."connection_id" !~ '[[:cntrl:]]'),
	CONSTRAINT "voice_binding_did" CHECK ("voice_private"."deployment_binding"."to_e164" ~ '^\+[1-9][0-9]{1,14}$'),
	CONSTRAINT "voice_binding_audio_off" CHECK (not "voice_private"."deployment_binding"."audio_enabled")
);
--> statement-breakpoint
ALTER TABLE "voice_private"."deployment_binding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "voice_private"."operation_receipt" (
	"deployment_id" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"payload_sha256" text NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"original_retention_until" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "operation_receipt_deployment_id_operation_id_pk" PRIMARY KEY("deployment_id","operation_id"),
	CONSTRAINT "voice_receipt_digest" CHECK ("voice_private"."operation_receipt"."payload_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "voice_private"."operation_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "voice_private"."recording_purge" (
	"recording_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"deployment_id" text NOT NULL,
	"call_id" uuid NOT NULL,
	"provider_recording_id" text NOT NULL,
	"original_retention_until" timestamp (3) with time zone NOT NULL,
	"purge_attempt" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp (3) with time zone,
	"retry_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"outcome" text,
	"ack_token" uuid,
	"ack_occurred_at" timestamp (6) with time zone,
	CONSTRAINT "voice_recording_provider" UNIQUE("deployment_id","provider_recording_id"),
	CONSTRAINT "voice_recording_id" CHECK (length("voice_private"."recording_purge"."provider_recording_id") between 1 and 256 and "voice_private"."recording_purge"."provider_recording_id" ~ '^[A-Za-z0-9._~-]+$' and "voice_private"."recording_purge"."provider_recording_id" not in ('.','..')),
	CONSTRAINT "voice_recording_attempt" CHECK ("voice_private"."recording_purge"."purge_attempt" between 0 and 1000000),
	CONSTRAINT "voice_recording_outcome" CHECK ("voice_private"."recording_purge"."outcome" is null or "voice_private"."recording_purge"."outcome" in ('deleted','not_found','retry','failed'))
);
--> statement-breakpoint
ALTER TABLE "voice_private"."recording_purge" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "to_e164" text;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "from_e164" text;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "started_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "end_reason" text;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "end_reason_rank" integer;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "end_reason_occurred_at" timestamp (6) with time zone;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "end_reason_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD COLUMN "transcript_loss_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sparra_erasure" ADD COLUMN "local_cleanup_completed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "sparra_erasure" ADD COLUMN "local_ack_occurred_at" timestamp (6) with time zone;--> statement-breakpoint
ALTER TABLE "voice_private"."deployment_binding" ADD CONSTRAINT "deployment_binding_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD CONSTRAINT "sparra_call_loss" CHECK ("sparra_call"."transcript_loss_count" >= 0);--> statement-breakpoint
-- These policy helpers only inspect binding, never Workspace (no RLS recursion).
CREATE FUNCTION voice_private.bound_workspace() RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT workspace_id FROM voice_private.deployment_binding WHERE service_login=session_user AND service_role_oid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user)
$$;
CREATE FUNCTION voice_private.bound_deployment() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT deployment_id FROM voice_private.deployment_binding WHERE service_login=session_user AND service_role_oid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user)
$$;
--> statement-breakpoint
CREATE POLICY "workspace_voice_read" ON "workspace" AS PERMISSIVE FOR SELECT TO "sparra_voice_definer" USING (id = voice_private.bound_workspace());--> statement-breakpoint
CREATE POLICY "workspace_voice_lock" ON "workspace" AS PERMISSIVE FOR UPDATE TO "sparra_voice_definer" USING (id = voice_private.bound_workspace()) WITH CHECK (id = voice_private.bound_workspace());--> statement-breakpoint
CREATE POLICY "sparra_call_voice" ON "sparra_call" AS PERMISSIVE FOR ALL TO "sparra_voice_definer" USING (workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment()) WITH CHECK (workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment());--> statement-breakpoint
CREATE POLICY "sparra_erasure_voice" ON "sparra_erasure" AS PERMISSIVE FOR ALL TO "sparra_voice_definer" USING (workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment()) WITH CHECK (workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment());--> statement-breakpoint
CREATE POLICY "sparra_revision_voice_read" ON "sparra_knowledge_revision" AS PERMISSIVE FOR SELECT TO "sparra_voice_definer" USING (workspace_id = voice_private.bound_workspace());--> statement-breakpoint
CREATE POLICY "sparra_revision_voice_delete" ON "sparra_knowledge_revision" AS PERMISSIVE FOR DELETE TO "sparra_voice_definer" USING (workspace_id = voice_private.bound_workspace());--> statement-breakpoint
CREATE POLICY "voice_binding_read" ON "voice_private"."deployment_binding" AS PERMISSIVE FOR SELECT TO "sparra_voice_definer" USING ("voice_private"."deployment_binding"."service_login" = session_user and "voice_private"."deployment_binding"."service_role_oid" = (select oid from pg_catalog.pg_roles where rolname = session_user));--> statement-breakpoint
CREATE POLICY "voice_receipt_scope" ON "voice_private"."operation_receipt" AS PERMISSIVE FOR ALL TO "sparra_voice_definer" USING (workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment()) WITH CHECK (workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment());--> statement-breakpoint
CREATE POLICY "voice_recording_scope" ON "voice_private"."recording_purge" AS PERMISSIVE FOR ALL TO "sparra_voice_definer" USING (workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment()) WITH CHECK (workspace_id = voice_private.bound_workspace() and deployment_id = voice_private.bound_deployment());
--> statement-breakpoint
ALTER TABLE voice_private.deployment_binding OWNER TO workspace_owner;
ALTER TABLE voice_private.operation_receipt OWNER TO workspace_owner;
ALTER TABLE voice_private.recording_purge OWNER TO workspace_owner;
ALTER TABLE voice_private.deployment_binding FORCE ROW LEVEL SECURITY;
ALTER TABLE voice_private.operation_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE voice_private.recording_purge FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA voice_private FROM PUBLIC,runtime,workspace_bootstrap;
GRANT SELECT ON voice_private.deployment_binding TO sparra_voice_definer;
GRANT SELECT,INSERT,DELETE ON voice_private.operation_receipt TO sparra_voice_definer;
GRANT SELECT,INSERT,DELETE ON voice_private.recording_purge TO sparra_voice_definer;
GRANT UPDATE(purge_attempt,lease_token,lease_until,retry_at,outcome,ack_token,ack_occurred_at) ON voice_private.recording_purge TO sparra_voice_definer;
GRANT SELECT(id,kind,lifecycle,auth_organization_id),UPDATE(id) ON public.workspace TO sparra_voice_definer;
GRANT SELECT,DELETE ON public.sparra_knowledge_revision TO sparra_voice_definer;
GRANT SELECT,INSERT ON public.sparra_call TO sparra_voice_definer;
GRANT UPDATE(configuration_revision,connection_id,to_e164,from_e164,started_at,ended_at,status,end_reason,end_reason_rank,end_reason_occurred_at,end_reason_operation_id,disclosure_state,disclosure_started_at,disclosure_completed_at,disclosure_failed_at,input_gate_opened_at,encrypted_turns,encrypted_message_result,transcript_loss_count,erasure_requested_at) ON public.sparra_call TO sparra_voice_definer;
GRANT SELECT,DELETE ON public.sparra_erasure TO sparra_voice_definer;
GRANT UPDATE(state,lease_token,lease_until,completed_at,local_cleanup_completed_at,local_ack_occurred_at) ON public.sparra_erasure TO sparra_voice_definer;
--> statement-breakpoint
CREATE FUNCTION voice_private.binding_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.service_login,NEW.service_role_oid,NEW.deployment_id,NEW.workspace_id,NEW.connection_id,NEW.to_e164,NEW.audio_enabled) IS DISTINCT FROM ROW(OLD.service_login,OLD.service_role_oid,OLD.deployment_id,OLD.workspace_id,OLD.connection_id,OLD.to_e164,OLD.audio_enabled) THEN
  RAISE EXCEPTION 'Voice binding is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER voice_binding_immutable BEFORE UPDATE OR DELETE ON voice_private.deployment_binding FOR EACH ROW EXECUTE FUNCTION voice_private.binding_guard();
CREATE FUNCTION voice_private.lock_binding() RETURNS voice_private.deployment_binding LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE b voice_private.deployment_binding;
BEGIN
 SELECT * INTO b FROM voice_private.deployment_binding;
 IF NOT FOUND THEN RAISE EXCEPTION 'Voice authority unavailable' USING ERRCODE='PV202'; END IF;
 PERFORM id FROM public.workspace WHERE id=b.workspace_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Voice authority unavailable' USING ERRCODE='PV202'; END IF;
 RETURN b;
END $$;
-- Strict primitives keep all public functions fail-closed on SQL NULL too.
CREATE FUNCTION voice_private.object_keys(v jsonb,required text[],optional text[] DEFAULT '{}') RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF v IS NULL OR jsonb_typeof(v)<>'object' OR NOT v ?& required OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE NOT k=ANY(required||optional)) THEN
  RAISE EXCEPTION 'Voice object contract' USING ERRCODE='PV202';
 END IF;
END $$;
CREATE FUNCTION voice_private.string_value(v jsonb,max_bytes integer,nullable boolean DEFAULT false) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE s text;
BEGIN
 IF v='null'::jsonb AND nullable THEN RETURN NULL; END IF;
 IF v IS NULL OR jsonb_typeof(v)<>'string' THEN RAISE EXCEPTION 'Voice string contract' USING ERRCODE='PV202'; END IF;
 s=v#>>'{}';
 IF octet_length(s) NOT BETWEEN 1 AND max_bytes OR s ~ U&'[\0001-\001F\007F-\009F]' THEN RAISE EXCEPTION 'Voice string contract' USING ERRCODE='PV202'; END IF;
 RETURN s;
END $$;
CREATE FUNCTION voice_private.uuid_value(v jsonb) RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE s text;
BEGIN
 s=voice_private.string_value(v,36);
 IF s !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Voice UUID contract' USING ERRCODE='PV202'; END IF;
 RETURN s::uuid;
END $$;
CREATE FUNCTION voice_private.instant(v jsonb,nullable boolean DEFAULT false) RETURNS timestamptz LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE s text; d timestamptz;
BEGIN
 IF v='null'::jsonb AND nullable THEN RETURN NULL; END IF;
 s=voice_private.string_value(v,40);
 IF s !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' THEN RAISE EXCEPTION 'Voice instant contract' USING ERRCODE='PV202'; END IF;
 BEGIN
  d=s::timestamptz;
  IF to_char(s::timestamp,'YYYY-MM-DD"T"HH24:MI:SS')<>left(s,19) THEN RAISE EXCEPTION 'Voice instant contract' USING ERRCODE='PV202';END IF;
 EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'Voice instant contract' USING ERRCODE='PV202'; END;
 IF NOT isfinite(d) OR extract(year from d at time zone 'UTC') NOT BETWEEN 1 AND 9999 THEN RAISE EXCEPTION 'Voice instant contract' USING ERRCODE='PV202'; END IF;
 RETURN d;
END $$;
CREATE FUNCTION voice_private.integer_value(v jsonb,minimum bigint,maximum bigint) RETURNS bigint LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF v IS NULL OR jsonb_typeof(v)<>'number' OR v::text !~ '^(0|[1-9][0-9]*)$' OR (v::text)::numeric NOT BETWEEN minimum AND maximum THEN RAISE EXCEPTION 'Voice integer contract' USING ERRCODE='PV202'; END IF;
 RETURN (v::text)::bigint;
END $$;
CREATE FUNCTION voice_private.iso(v timestamptz) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$ SELECT to_char(v AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
CREATE FUNCTION voice_private.envelope(v jsonb,kind text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE n text; c text; nb bytea; cb bytea;
BEGIN
 PERFORM voice_private.integer_value(v->'crypto_version',1,1);
 PERFORM voice_private.integer_value(v->'key_version',1,9007199254740991);
 n=voice_private.string_value(v->'nonce_b64',172);c=voice_private.string_value(v->'ciphertext_b64',87384);
 BEGIN nb=decode(n,'base64');cb=decode(c,'base64'); EXCEPTION WHEN invalid_parameter_value THEN RAISE EXCEPTION 'Voice envelope contract' USING ERRCODE='PV202'; END;
 IF octet_length(nb)<>12 OR octet_length(cb) NOT BETWEEN 16 AND (CASE WHEN kind='result' THEN 8208 ELSE 16400 END)
 OR replace(encode(nb,'base64'),chr(10),'')<>n OR replace(encode(cb,'base64'),chr(10),'')<>c THEN RAISE EXCEPTION 'Voice envelope contract' USING ERRCODE='PV202'; END IF;
END $$;
CREATE FUNCTION voice_private.validate_operation(op jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE p jsonb; k text; status text; started timestamptz; ended timestamptz; retention timestamptz; occurred timestamptz; ev jsonb; a timestamptz; b timestamptz; gate timestamptz; provider text;
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
  PERFORM voice_private.object_keys(p,ARRAY['recording_id','status','telnyx_recording_id','channels','format','started_at','ended_at','retention_until']);
  PERFORM voice_private.uuid_value(p->'recording_id');status=voice_private.string_value(p->'status',16);provider=voice_private.string_value(p->'telnyx_recording_id',256,true);
  IF provider IS NOT NULL AND (provider !~ '^[A-Za-z0-9._~-]+$' OR provider IN ('.','..')) THEN RAISE EXCEPTION 'Voice recording identity' USING ERRCODE='PV202';END IF;
  started=voice_private.instant(p->'started_at',true);ended=voice_private.instant(p->'ended_at',true);retention=voice_private.instant(p->'retention_until',true);
  IF status NOT IN ('off','pending','active','saved','failed','purged') OR (status='off' AND (p-'recording_id'-'status')<>jsonb_build_object('telnyx_recording_id',NULL,'channels',NULL,'format',NULL,'started_at',NULL,'ended_at',NULL,'retention_until',NULL))
   OR (status<>'off' AND (p->>'channels' IS DISTINCT FROM 'dual' OR p->>'format' IS DISTINCT FROM 'wav'))
   OR ((started IS NULL)<>(ended IS NULL)) OR (status IN ('pending','active') AND (provider IS NOT NULL OR started IS NOT NULL OR ended IS NOT NULL OR retention IS NOT NULL))
   OR (status='failed' AND retention IS NOT NULL) OR (status IN ('saved','purged') AND (started IS NULL OR ended IS NULL OR retention IS NULL))
   OR (status='purged' AND provider IS NULL) OR retention<=coalesce(ended,started) THEN RAISE EXCEPTION 'Voice recording contract' USING ERRCODE='PV202';END IF;
 ELSE RAISE EXCEPTION 'Voice operation kind' USING ERRCODE='PV202';
 END IF;
 IF ended<started OR occurred<coalesce(ended,started) THEN RAISE EXCEPTION 'Voice operation chronology' USING ERRCODE='PV202';END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION voice.begin_call_v1(deployment text,call_id uuid,routing jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE b voice_private.deployment_binding; c public.sparra_call; k public.sparra_knowledge_revision; admitted timestamptz; provider text; leg text; session_id text; caller text;
BEGIN
 IF deployment IS NULL OR call_id IS NULL OR routing IS NULL THEN RAISE EXCEPTION 'Voice begin contract' USING ERRCODE='PV202';END IF;
 b=voice_private.lock_binding();
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
 IF c.id IS NULL THEN
  INSERT INTO public.sparra_call(id,workspace_id,configuration_revision,deployment_id,provider_call_control_id,provider_call_leg_id,provider_call_session_id,admitted_at,retention_until,connection_id,to_e164,from_e164)
   VALUES(call_id,b.workspace_id,k.revision,b.deployment_id,provider,leg,session_id,admitted,admitted+interval '2592000 seconds',b.connection_id,b.to_e164,caller);
 ELSE
  UPDATE public.sparra_call SET configuration_revision=k.revision,connection_id=b.connection_id,to_e164=b.to_e164,from_e164=caller WHERE id=c.id;
 END IF;
 RETURN jsonb_build_object('schema_version',1,'call_id',call_id,'configuration_revision',k.revision,'knowledge',jsonb_build_object('business_name',k.business_name,'sector',k.sector,'opening_hours',k.opening_hours,'services',k.services,'prices',k.prices,'faq',k.faq,'instructions',k.instructions),'transfer_destination',k.transfer_destination,'retention_until',voice_private.iso(admitted+interval '2592000 seconds'));
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Voice admission conflict' USING ERRCODE='PV202';
END $$;
--> statement-breakpoint
CREATE FUNCTION voice.ingest_operation_v1(op jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE b voice_private.deployment_binding; c public.sparra_call; fence public.sparra_erasure; rec voice_private.recording_purge; p jsonb; ev jsonb; cid uuid; oid uuid; occurred timestamptz; retention timestamptz; digest text; old_digest text; kind text; answer text='applied'; rank integer; reason_wins boolean; merged jsonb; actual_provider text; dead boolean;
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
    INSERT INTO voice_private.recording_purge(recording_id,workspace_id,deployment_id,call_id,provider_recording_id,original_retention_until) VALUES((p->>'recording_id')::uuid,b.workspace_id,b.deployment_id,cid,actual_provider,retention);
    UPDATE public.sparra_erasure SET state='queued',completed_at=NULL WHERE call_id=cid AND state='completed';
   END IF;
  END IF;
 END IF;
 IF answer='applied' THEN INSERT INTO voice_private.operation_receipt(deployment_id,operation_id,workspace_id,call_id,payload_sha256,occurred_at,original_retention_until) VALUES(b.deployment_id,oid,b.workspace_id,cid,digest,occurred,retention);END IF;
 RETURN jsonb_build_object('schema_version',1,'status',answer,'operation_id',oid,'payload_sha256',digest);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Voice identity conflict' USING ERRCODE='PV202';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_private.sparra_erasure_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.state<>'completed' OR OLD.fence_until>clock_timestamp() OR OLD.local_cleanup_completed_at IS NULL THEN RAISE EXCEPTION 'Erasure obligation retained' USING ERRCODE='23514';END IF;
  RETURN OLD;
 END IF;
 IF ROW(NEW.workspace_id,NEW.call_id,NEW.deployment_id,NEW.provider_call_control_id,NEW.requested_at,NEW.original_retention_until,NEW.fence_until) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.call_id,OLD.deployment_id,OLD.provider_call_control_id,OLD.requested_at,OLD.original_retention_until,OLD.fence_until)
 OR (OLD.local_cleanup_completed_at IS NOT NULL AND NEW.local_cleanup_completed_at IS DISTINCT FROM OLD.local_cleanup_completed_at) THEN RAISE EXCEPTION 'Erasure identity is immutable' USING ERRCODE='23514';END IF;
 IF OLD.state='completed' AND ROW(NEW.state,NEW.completed_at) IS DISTINCT FROM ROW(OLD.state,OLD.completed_at) THEN
  IF current_user<>'sparra_voice_definer' OR NEW.state<>'queued' OR NEW.completed_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM voice_private.recording_purge r WHERE r.call_id=OLD.call_id AND r.workspace_id=OLD.workspace_id AND r.deployment_id=OLD.deployment_id AND coalesce(r.outcome,'') NOT IN ('deleted','not_found')) THEN RAISE EXCEPTION 'Erasure completion is immutable' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION app_private.sparra_revision_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' AND current_user='sparra_voice_definer' AND OLD.workspace_id=voice_private.bound_workspace()
 AND EXISTS(SELECT 1 FROM public.sparra_knowledge_revision k WHERE k.workspace_id=OLD.workspace_id AND k.revision>OLD.revision)
 AND NOT EXISTS(SELECT 1 FROM public.sparra_call c WHERE c.workspace_id=OLD.workspace_id AND c.configuration_revision=OLD.revision) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'Activity revision is immutable' USING ERRCODE='23514';
END $$;
CREATE FUNCTION voice_private.complete_erasure(cid uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 UPDATE public.sparra_erasure SET state='completed',completed_at=clock_timestamp()
 WHERE call_id=cid AND state='queued' AND local_cleanup_completed_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM voice_private.recording_purge WHERE call_id=cid AND coalesce(outcome,'') NOT IN ('deleted','not_found'));
END $$;
CREATE FUNCTION voice_private.maintenance() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE old_tenant text=current_setting('app.tenant_id',true); wid uuid=voice_private.bound_workspace();
BEGIN
 -- Caller already holds the physical Workspace lock. This setting only lets
 -- the existing OLD-derived workspace_owner trigger see its exact call.
 PERFORM set_config('app.tenant_id',wid::text,true);
 BEGIN
  UPDATE public.sparra_call SET erasure_requested_at=clock_timestamp() WHERE id IN(SELECT id FROM public.sparra_call WHERE retention_until<=clock_timestamp() AND erasure_requested_at IS NULL ORDER BY retention_until,id LIMIT 100 FOR UPDATE SKIP LOCKED);
 EXCEPTION WHEN OTHERS THEN PERFORM set_config('app.tenant_id',coalesce(old_tenant,''),true);RAISE;
 END;
 PERFORM set_config('app.tenant_id',coalesce(old_tenant,''),true);
 DELETE FROM voice_private.operation_receipt r WHERE (r.deployment_id,r.operation_id) IN(SELECT deployment_id,operation_id FROM voice_private.operation_receipt o WHERE original_retention_until+interval '900 seconds'<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM public.sparra_call c WHERE c.id=o.call_id) AND EXISTS(SELECT 1 FROM public.sparra_erasure e WHERE e.call_id=o.call_id AND e.state='completed' AND e.local_cleanup_completed_at IS NOT NULL) LIMIT 100);
 DELETE FROM voice_private.recording_purge r WHERE recording_id IN(SELECT recording_id FROM voice_private.recording_purge p WHERE original_retention_until+interval '900 seconds'<=clock_timestamp() AND outcome IN ('deleted','not_found') AND NOT EXISTS(SELECT 1 FROM public.sparra_call c WHERE c.id=p.call_id) AND EXISTS(SELECT 1 FROM public.sparra_erasure e WHERE e.call_id=p.call_id AND e.state='completed' AND e.local_cleanup_completed_at IS NOT NULL) LIMIT 100);
 DELETE FROM public.sparra_erasure e WHERE call_id IN(SELECT call_id FROM public.sparra_erasure f WHERE state='completed' AND local_cleanup_completed_at IS NOT NULL AND fence_until<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM voice_private.operation_receipt r WHERE r.call_id=f.call_id) AND NOT EXISTS(SELECT 1 FROM voice_private.recording_purge r WHERE r.call_id=f.call_id) LIMIT 100);
 DELETE FROM public.sparra_knowledge_revision k WHERE (workspace_id,revision) IN(SELECT workspace_id,revision FROM public.sparra_knowledge_revision v WHERE EXISTS(SELECT 1 FROM public.sparra_knowledge_revision latest WHERE latest.workspace_id=v.workspace_id AND latest.revision>v.revision) AND NOT EXISTS(SELECT 1 FROM public.sparra_call c WHERE c.workspace_id=v.workspace_id AND c.configuration_revision=v.revision) ORDER BY revision LIMIT 100);
END $$;
CREATE FUNCTION voice_private.lease_arguments(worker text,seconds integer,batch integer) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF worker IS NULL OR worker !~ '^[A-Za-z0-9._:-]{1,64}$' OR seconds IS NULL OR seconds NOT BETWEEN 1 AND 300 OR batch IS NULL OR batch NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Voice lease contract' USING ERRCODE='PV202';END IF;
END $$;
CREATE FUNCTION voice.lease_recording_purge_v1(worker text,seconds integer,batch integer) RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM voice_private.lease_arguments(worker,seconds,batch);PERFORM voice_private.lock_binding();PERFORM voice_private.maintenance();
 RETURN QUERY WITH due AS(SELECT recording_id FROM voice_private.recording_purge WHERE coalesce(outcome,'') NOT IN ('deleted','not_found') AND purge_attempt<1000000 AND retry_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY retry_at,recording_id LIMIT batch FOR UPDATE SKIP LOCKED), leased AS(
 UPDATE voice_private.recording_purge p SET lease_token=gen_random_uuid(),lease_until=date_trunc('milliseconds',clock_timestamp())+seconds*interval '1 second',purge_attempt=purge_attempt+1,ack_token=NULL,ack_occurred_at=NULL FROM due WHERE p.recording_id=due.recording_id RETURNING p.*)
 SELECT jsonb_build_object('schema_version',1,'recording_id',recording_id,'lease_token',lease_token,'telnyx_recording_id',provider_recording_id,'purge_attempt',purge_attempt,'lease_expires_at',voice_private.iso(lease_until)) FROM leased;
END $$;
CREATE FUNCTION voice.lease_call_erasure_v1(worker text,seconds integer,batch integer) RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM voice_private.lease_arguments(worker,seconds,batch);PERFORM voice_private.lock_binding();PERFORM voice_private.maintenance();
 RETURN QUERY WITH due AS(SELECT call_id FROM public.sparra_erasure WHERE state='queued' AND local_cleanup_completed_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY requested_at,call_id LIMIT batch FOR UPDATE SKIP LOCKED), leased AS(
 UPDATE public.sparra_erasure e SET lease_token=gen_random_uuid(),lease_until=date_trunc('milliseconds',clock_timestamp())+seconds*interval '1 second' FROM due WHERE e.call_id=due.call_id RETURNING e.*)
 SELECT jsonb_build_object('schema_version',1,'call_id',call_id,'lease_token',lease_token,'deployment_id',deployment_id,'original_retention_until',voice_private.iso(original_retention_until),'lease_expires_at',voice_private.iso(lease_until)) FROM leased;
END $$;
CREATE FUNCTION voice.ack_call_erasure_v1(cid uuid,token uuid,occurred timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE e public.sparra_erasure;
BEGIN
 IF cid IS NULL OR token IS NULL OR occurred IS NULL OR NOT isfinite(occurred) THEN RAISE EXCEPTION 'Voice acknowledgement contract' USING ERRCODE='PV202';END IF;
 PERFORM voice_private.lock_binding();SELECT * INTO e FROM public.sparra_erasure WHERE call_id=cid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Voice erasure unavailable' USING ERRCODE='PV201';END IF;
 IF e.lease_token=token AND e.local_ack_occurred_at=occurred AND e.local_cleanup_completed_at IS NOT NULL THEN RETURN NULL::jsonb;END IF;
 IF e.lease_token IS DISTINCT FROM token OR e.lease_until<=clock_timestamp() OR e.local_cleanup_completed_at IS NOT NULL THEN RAISE EXCEPTION 'Voice stale lease' USING ERRCODE='PV201';END IF;
 UPDATE public.sparra_erasure SET local_cleanup_completed_at=clock_timestamp(),local_ack_occurred_at=occurred WHERE call_id=cid;
 PERFORM voice_private.complete_erasure(cid);RETURN NULL::jsonb;
END $$;
CREATE FUNCTION voice.ack_recording_purge_v1(rid uuid,token uuid,result text,occurred timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r voice_private.recording_purge;
BEGIN
 IF rid IS NULL OR token IS NULL OR result IS NULL OR result NOT IN ('deleted','not_found','retry','failed') OR occurred IS NULL OR NOT isfinite(occurred) THEN RAISE EXCEPTION 'Voice acknowledgement contract' USING ERRCODE='PV202';END IF;
 PERFORM voice_private.lock_binding();SELECT * INTO r FROM voice_private.recording_purge WHERE recording_id=rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Voice recording unavailable' USING ERRCODE='PV201';END IF;
 IF r.lease_token=token AND r.ack_token=token AND r.outcome=result AND r.ack_occurred_at=occurred THEN RETURN NULL::jsonb;END IF;
 IF r.lease_token IS DISTINCT FROM token OR r.lease_until<=clock_timestamp() OR r.ack_token IS NOT NULL THEN RAISE EXCEPTION 'Voice stale lease' USING ERRCODE='PV201';END IF;
 UPDATE voice_private.recording_purge SET outcome=result,ack_token=token,ack_occurred_at=occurred,lease_until=NULL,retry_at=clock_timestamp()+interval '30 seconds' WHERE recording_id=rid;
 PERFORM voice_private.complete_erasure(r.call_id);RETURN NULL::jsonb;
END $$;
--> statement-breakpoint
-- No service name is hard-coded in migration. Operator provisioning grants the
-- exact six signatures to each bound login; see docs/qa/sparra-voice-bridge.md.
ALTER FUNCTION voice_private.bound_workspace() OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.bound_deployment() OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.binding_guard() OWNER TO workspace_owner;
ALTER FUNCTION voice_private.lock_binding() OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.object_keys(jsonb,text[],text[]) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.string_value(jsonb,integer,boolean) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.uuid_value(jsonb) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.instant(jsonb,boolean) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.integer_value(jsonb,bigint,bigint) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.iso(timestamptz) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.envelope(jsonb,text) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.validate_operation(jsonb) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.complete_erasure(uuid) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.maintenance() OWNER TO sparra_voice_definer;
ALTER FUNCTION voice_private.lease_arguments(text,integer,integer) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice.begin_call_v1(text,uuid,jsonb) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice.ingest_operation_v1(jsonb) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice.lease_recording_purge_v1(text,integer,integer) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice.ack_recording_purge_v1(uuid,uuid,text,timestamptz) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice.lease_call_erasure_v1(text,integer,integer) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice.ack_call_erasure_v1(uuid,uuid,timestamptz) OWNER TO sparra_voice_definer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA voice,voice_private FROM PUBLIC,runtime,workspace_bootstrap;
