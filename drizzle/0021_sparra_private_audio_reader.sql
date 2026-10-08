CREATE TABLE "sparra_audio_reader" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"call_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"incarnation" uuid NOT NULL,
	"container_id" text NOT NULL,
	"reader_deployment_id" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"state" text NOT NULL,
	"released_at" timestamp (3) with time zone,
	CONSTRAINT "sparra_audio_reader_lease_id_unique" UNIQUE("lease_id"),
	CONSTRAINT "sparra_audio_reader_container" CHECK (container_id ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sparra_audio_reader_token_hash" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sparra_audio_reader_deployment" CHECK (length(reader_deployment_id) between 1 and 256 and reader_deployment_id !~ '[[:cntrl:]]'),
	CONSTRAINT "sparra_audio_reader_state" CHECK (state in ('active','revoked','released') and ((state='released') = (released_at is not null)) and isfinite(expires_at))
);
--> statement-breakpoint
ALTER TABLE "sparra_audio_reader" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sparra_audio_reader" ADD CONSTRAINT "sparra_audio_reader_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "sparra_audio_reader_runtime" ON "sparra_audio_reader" AS PERMISSIVE FOR ALL TO "runtime" USING ("sparra_audio_reader"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000' and exists (select 1 from public.workspace where workspace.id = "sparra_audio_reader"."workspace_id" and workspace.lifecycle = 'active')) WITH CHECK ("sparra_audio_reader"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000' and exists (select 1 from public.workspace where workspace.id = "sparra_audio_reader"."workspace_id" and workspace.lifecycle = 'active'));--> statement-breakpoint
CREATE POLICY "sparra_audio_reader_cleanup" ON "sparra_audio_reader" AS PERMISSIVE FOR ALL TO "workspace_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "sparra_audio_reader_voice" ON "sparra_audio_reader" AS PERMISSIVE FOR ALL TO "sparra_voice_definer" USING (workspace_id = voice_private.bound_workspace()) WITH CHECK (workspace_id = voice_private.bound_workspace());
--> statement-breakpoint
-- Append only after the native Drizzle-generated0021 prefix.
ALTER TABLE public.sparra_audio_reader OWNER TO workspace_owner;
ALTER TABLE public.sparra_audio_reader FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON public.sparra_audio_reader TO runtime;
GRANT SELECT ON public.sparra_audio_reader TO sparra_voice_definer;
GRANT UPDATE(state) ON public.sparra_audio_reader TO sparra_voice_definer;
GRANT SELECT ON public.sparra_audio_chunk TO runtime;
CREATE POLICY sparra_audio_chunk_runtime_read ON public.sparra_audio_chunk FOR SELECT TO runtime
USING (workspace_id::text=current_setting('app.tenant_id',true)
 AND current_setting('app.tenant_id',true)<>'00000000-0000-0000-0000-000000000000'
 AND EXISTS(SELECT 1 FROM public.workspace w WHERE w.id=workspace_id AND w.lifecycle='active'));
CREATE POLICY workspace_audio_reader_cleanup_select ON public.workspace FOR SELECT TO workspace_owner
USING(id::text=current_setting('app.tenant_id',true) AND EXISTS(SELECT 1 FROM public.sparra_audio_reader r WHERE r.workspace_id=id));
CREATE POLICY workspace_audio_reader_cleanup_update ON public.workspace FOR UPDATE TO workspace_owner
USING(id::text=current_setting('app.tenant_id',true) AND EXISTS(SELECT 1 FROM public.sparra_audio_reader r WHERE r.workspace_id=id))
WITH CHECK(id::text=current_setting('app.tenant_id',true) AND EXISTS(SELECT 1 FROM public.sparra_audio_reader r WHERE r.workspace_id=id));
--> statement-breakpoint
CREATE POLICY sparra_call_reader_cleanup ON public.sparra_call FOR ALL TO workspace_owner
USING(workspace_id::text=current_setting('app.tenant_id',true))
WITH CHECK(workspace_id::text=current_setting('app.tenant_id',true));
GRANT SELECT ON voice_private.recording_purge TO workspace_owner;
GRANT USAGE ON SCHEMA voice_private TO workspace_owner;
CREATE POLICY sparra_erasure_reader_cleanup ON public.sparra_erasure FOR UPDATE TO workspace_owner
USING(workspace_id::text=current_setting('app.tenant_id',true))
WITH CHECK(workspace_id::text=current_setting('app.tenant_id',true));
CREATE POLICY sparra_erasure_reader_cleanup_read ON public.sparra_erasure FOR SELECT TO workspace_owner
USING(workspace_id::text=current_setting('app.tenant_id',true));
CREATE POLICY recording_purge_reader_cleanup ON voice_private.recording_purge FOR SELECT TO workspace_owner
USING(workspace_id::text=current_setting('app.tenant_id',true));
--> statement-breakpoint
CREATE FUNCTION app_private.sparra_audio_joined_cleanup(cid uuid,wid uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE previous_scope text=current_setting('app.tenant_id',true);
BEGIN
 PERFORM set_config('app.tenant_id',wid::text,true);
 UPDATE public.sparra_call SET audio_state='declined'
 WHERE id=cid AND workspace_id=wid AND audio_denied_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM public.sparra_audio_reader r WHERE r.call_id=cid AND r.state<>'released')
 AND NOT EXISTS(SELECT 1 FROM public.sparra_audio_chunk a WHERE a.call_id=cid);
 UPDATE public.sparra_erasure SET state='completed',completed_at=clock_timestamp()
 WHERE call_id=cid AND workspace_id=wid AND state='queued' AND local_cleanup_completed_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM public.sparra_audio_reader r WHERE r.call_id=cid AND r.state<>'released')
 AND NOT EXISTS(SELECT 1 FROM public.sparra_audio_chunk a WHERE a.call_id=cid)
 AND NOT EXISTS(SELECT 1 FROM public.sparra_call c WHERE c.id=cid AND (c.audio_reserved_bytes<>0 OR c.audio_charged_bytes<>0))
 AND NOT EXISTS(SELECT 1 FROM voice_private.recording_purge p WHERE p.call_id=cid AND coalesce(p.outcome,'') NOT IN ('deleted','not_found'));
 PERFORM set_config('app.tenant_id',coalesce(previous_scope,''),true);
END $$;
ALTER FUNCTION app_private.sparra_audio_joined_cleanup(uuid,uuid) OWNER TO workspace_owner;
REVOKE ALL ON FUNCTION app_private.sparra_audio_joined_cleanup(uuid,uuid) FROM PUBLIC,runtime,workspace_bootstrap,sparra_voice_definer;
--> statement-breakpoint
CREATE FUNCTION public.sparra_audio_release_reader_v1(lease_id uuid,token uuid,incarnation uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE found_slot public.sparra_audio_reader; expected_hash text=encode(sha256(convert_to(token::text,'UTF8')),'hex');
 previous_scope text=current_setting('app.tenant_id',true);
BEGIN
 SELECT * INTO found_slot FROM public.sparra_audio_reader r
 WHERE r.lease_id=sparra_audio_release_reader_v1.lease_id AND r.token_hash=expected_hash AND r.incarnation=sparra_audio_release_reader_v1.incarnation;
 IF NOT FOUND THEN RETURN false;END IF;
 PERFORM set_config('app.tenant_id',found_slot.workspace_id::text,true);
 PERFORM 1 FROM public.workspace WHERE id=found_slot.workspace_id FOR UPDATE;
 IF NOT FOUND THEN PERFORM set_config('app.tenant_id',coalesce(previous_scope,''),true);RETURN false;END IF;
 SELECT * INTO found_slot FROM public.sparra_audio_reader r
 WHERE r.lease_id=sparra_audio_release_reader_v1.lease_id AND r.token_hash=expected_hash AND r.incarnation=sparra_audio_release_reader_v1.incarnation FOR UPDATE;
 IF NOT FOUND THEN PERFORM set_config('app.tenant_id',coalesce(previous_scope,''),true);RETURN false;END IF;
 UPDATE public.sparra_audio_reader AS r SET state='released',released_at=coalesce(r.released_at,clock_timestamp())
 WHERE r.workspace_id=found_slot.workspace_id AND r.lease_id=found_slot.lease_id;
 PERFORM app_private.sparra_audio_joined_cleanup(found_slot.call_id,found_slot.workspace_id);
 PERFORM set_config('app.tenant_id',coalesce(previous_scope,''),true);
 RETURN true;
END $$;
ALTER FUNCTION public.sparra_audio_release_reader_v1(uuid,uuid,uuid) OWNER TO workspace_owner;
REVOKE ALL ON FUNCTION public.sparra_audio_release_reader_v1(uuid,uuid,uuid) FROM PUBLIC,workspace_bootstrap,sparra_voice_definer;
GRANT EXECUTE ON FUNCTION public.sparra_audio_release_reader_v1(uuid,uuid,uuid) TO runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.sparra_audio_reader_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.audio_denied_at IS NOT NULL OR NEW.erasure_requested_at IS NOT NULL THEN
  UPDATE public.sparra_audio_reader SET state='revoked'
  WHERE call_id=OLD.id AND workspace_id=OLD.workspace_id AND state<>'released';
  IF TG_OP<>'DELETE' AND NEW.audio_denied_at IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.sparra_audio_reader WHERE call_id=OLD.id AND state<>'released')
  THEN NEW.audio_state='deletion_pending';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION app_private.sparra_audio_reader_fence() OWNER TO workspace_owner;
REVOKE ALL ON FUNCTION app_private.sparra_audio_reader_fence() FROM PUBLIC,runtime,workspace_bootstrap,sparra_voice_definer;
CREATE TRIGGER sparra_audio_reader_fence BEFORE DELETE OR UPDATE OF audio_denied_at,erasure_requested_at ON public.sparra_call
FOR EACH ROW EXECUTE FUNCTION app_private.sparra_audio_reader_fence();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION voice_private.complete_erasure(cid uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 UPDATE public.sparra_erasure SET state='completed',completed_at=clock_timestamp()
 WHERE call_id=cid AND state='queued' AND local_cleanup_completed_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM public.sparra_audio_reader WHERE call_id=cid AND state<>'released')
 AND NOT EXISTS(SELECT 1 FROM public.sparra_audio_chunk WHERE call_id=cid)
 AND NOT EXISTS(SELECT 1 FROM public.sparra_call WHERE id=cid AND (audio_reserved_bytes<>0 OR audio_charged_bytes<>0))
 AND NOT EXISTS(SELECT 1 FROM voice_private.recording_purge WHERE call_id=cid AND coalesce(outcome,'') NOT IN ('deleted','not_found'));
END $$;
--> statement-breakpoint
CREATE FUNCTION public.sparra_audio_retire_readers_v1(incarnation uuid,container_id text,deployment_id text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE found_slot public.sparra_audio_reader; settled integer=0; previous_scope text=current_setting('app.tenant_id',true);
BEGIN
 IF session_user<>'migrator' OR container_id !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'Reader retirement unavailable' USING ERRCODE='23514';END IF;
 FOR found_slot IN SELECT * FROM public.sparra_audio_reader r
  WHERE r.incarnation=sparra_audio_retire_readers_v1.incarnation AND r.container_id=sparra_audio_retire_readers_v1.container_id
  AND r.reader_deployment_id=sparra_audio_retire_readers_v1.deployment_id AND r.state<>'released'
  ORDER BY r.workspace_id LIMIT 100
 LOOP
  PERFORM set_config('app.tenant_id',found_slot.workspace_id::text,true);
  PERFORM 1 FROM public.workspace WHERE id=found_slot.workspace_id FOR UPDATE;
  IF NOT FOUND THEN CONTINUE;END IF;
  UPDATE public.sparra_audio_reader AS r SET state='released',released_at=clock_timestamp()
  WHERE r.workspace_id=found_slot.workspace_id AND r.incarnation=sparra_audio_retire_readers_v1.incarnation
  AND r.container_id=sparra_audio_retire_readers_v1.container_id AND r.reader_deployment_id=sparra_audio_retire_readers_v1.deployment_id AND r.state<>'released';
  IF FOUND THEN settled=settled+1;PERFORM app_private.sparra_audio_joined_cleanup(found_slot.call_id,found_slot.workspace_id);END IF;
 END LOOP;
 PERFORM set_config('app.tenant_id',coalesce(previous_scope,''),true);
 RETURN settled;
END $$;
ALTER FUNCTION public.sparra_audio_retire_readers_v1(uuid,text,text) OWNER TO workspace_owner;
REVOKE ALL ON FUNCTION public.sparra_audio_retire_readers_v1(uuid,text,text) FROM PUBLIC,runtime,workspace_bootstrap,sparra_voice_definer;
GRANT EXECUTE ON FUNCTION public.sparra_audio_retire_readers_v1(uuid,text,text) TO migrator;
