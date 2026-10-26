ALTER TABLE public.sparra_call
 ADD COLUMN collection_manifest jsonb,
 ADD COLUMN collection_closed boolean NOT NULL DEFAULT false,
 ADD COLUMN publication_snapshot jsonb,
 ADD COLUMN publication_version integer NOT NULL DEFAULT 0,
 ADD COLUMN declared_publication integer NOT NULL DEFAULT 0,
 ADD COLUMN declaration_active boolean NOT NULL DEFAULT false,
 ADD COLUMN publication_token uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD CONSTRAINT sparra_call_publication_versions CHECK (publication_version>=0 AND declared_publication>=0 AND declared_publication<=publication_version),
 ADD CONSTRAINT sparra_call_publication_bound CHECK (publication_snapshot IS NULL OR (jsonb_typeof(publication_snapshot)='object' AND octet_length(publication_snapshot::text)<=1048576));
--> statement-breakpoint
-- Only the existing internal owners can mutate these columns. Runtime receives no write grant.
GRANT UPDATE(collection_manifest) ON public.sparra_call TO sparra_voice_definer;
CREATE POLICY sparra_call_publication_owner ON public.sparra_call FOR UPDATE TO workspace_owner
 USING (workspace_id::text=current_setting('app.tenant_id',true)) WITH CHECK (workspace_id::text=current_setting('app.tenant_id',true));
CREATE POLICY calendar_publication_owner ON public.sparra_calendar_command FOR SELECT TO workspace_owner
 USING (workspace_id::text=current_setting('app.tenant_id',true));
CREATE POLICY audio_publication_owner ON public.sparra_audio_chunk FOR SELECT TO workspace_owner
 USING (workspace_id::text=current_setting('app.tenant_id',true));
--> statement-breakpoint
ALTER FUNCTION voice_private.validate_operation(jsonb) RENAME TO validate_operation_without_collection;
CREATE FUNCTION voice_private.validate_operation(op jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE m jsonb; a jsonb; x jsonb; ids jsonb;
BEGIN
 IF op->>'kind'='call.upsert' AND op->'payload' ? 'collection' THEN
  m=op->'payload'->'collection';
  PERFORM voice_private.object_keys(m,ARRAY['schema_version','episode_id','expected_turn_ids','result_outcome','audio','gaps']);
  PERFORM voice_private.integer_value(m->'schema_version',1,1);PERFORM voice_private.uuid_value(m->'episode_id');
  IF op->'payload'->>'status' NOT IN ('closing','closed','failed') OR jsonb_typeof(m->'expected_turn_ids') IS DISTINCT FROM 'array'
   OR jsonb_array_length(m->'expected_turn_ids')>200 OR jsonb_typeof(m->'gaps') IS DISTINCT FROM 'array' OR jsonb_array_length(m->'gaps')>3
   OR voice_private.string_value(m->'result_outcome',16) NOT IN ('present','absent','failed','fenced')
   OR (m->>'result_outcome'='present') IS DISTINCT FROM (op->'payload' ? 'message_result')
  THEN RAISE EXCEPTION 'Voice collection contract' USING ERRCODE='PV202';END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(m->'expected_turn_ids') LOOP PERFORM voice_private.uuid_value(x);END LOOP;
  SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') INTO ids FROM (SELECT DISTINCT value v FROM jsonb_array_elements(m->'expected_turn_ids')) t;
  IF ids<>m->'expected_turn_ids' THEN RAISE EXCEPTION 'Voice collection turns' USING ERRCODE='PV202';END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(m->'gaps') LOOP
   IF voice_private.string_value(x,32) NOT IN ('transcript_loss','result_unavailable','audio_partial') THEN RAISE EXCEPTION 'Voice collection gap' USING ERRCODE='PV202';END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') INTO ids FROM (SELECT DISTINCT value v FROM jsonb_array_elements(m->'gaps')) t;
  IF ids<>m->'gaps' THEN RAISE EXCEPTION 'Voice collection gaps' USING ERRCODE='PV202';END IF;
  a=m->'audio';
  IF voice_private.string_value(a->'state',16)='terminal' THEN
   PERFORM voice_private.object_keys(a,ARRAY['state','recording_id','last_sequence','total_samples','reason']);
   PERFORM voice_private.uuid_value(a->'recording_id');PERFORM voice_private.integer_value(a->'total_samples',0,4800000);
   IF a->'last_sequence'<>'null'::jsonb THEN PERFORM voice_private.integer_value(a->'last_sequence',0,599);END IF;
   IF voice_private.string_value(a->'reason',16) NOT IN ('complete','transfer','interrupted','limit','failure') OR ((a->>'total_samples')::int=0) IS DISTINCT FROM (a->'last_sequence'='null'::jsonb)
    OR (a->'last_sequence'<>'null'::jsonb AND (a->>'total_samples')::int NOT BETWEEN (a->>'last_sequence')::int+1 AND ((a->>'last_sequence')::int+1)*8000)
   THEN RAISE EXCEPTION 'Voice collection audio terminal' USING ERRCODE='PV202';END IF;
  ELSE
   PERFORM voice_private.object_keys(a,ARRAY['state']);
   IF a->>'state' NOT IN ('off','unavailable','declined') THEN RAISE EXCEPTION 'Voice collection audio state' USING ERRCODE='PV202';END IF;
  END IF;
  PERFORM voice_private.validate_operation_without_collection(jsonb_set(op,'{payload}',(op->'payload')-'collection'));
 ELSE PERFORM voice_private.validate_operation_without_collection(op);END IF;
END $$;
ALTER FUNCTION voice_private.validate_operation(jsonb) OWNER TO sparra_voice_definer;
REVOKE ALL ON FUNCTION voice_private.validate_operation(jsonb),voice_private.validate_operation_without_collection(jsonb) FROM PUBLIC,runtime,workspace_bootstrap;
--> statement-breakpoint
CREATE FUNCTION app_private.publish_sparra_inbox_v1(cid uuid,wid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE c public.sparra_call; m jsonb; a jsonb; closed boolean=false; bundle jsonb; bookings jsonb; old_tenant text=current_setting('app.tenant_id',true); chunk_count integer; samples bigint; first_seq integer; last_seq integer;
BEGIN
 PERFORM set_config('app.tenant_id',wid::text,true);
 SELECT * INTO c FROM public.sparra_call WHERE id=cid AND workspace_id=wid FOR UPDATE;
 IF NOT FOUND OR c.erasure_requested_at IS NOT NULL OR c.retention_until<=clock_timestamp() THEN
  PERFORM set_config('app.tenant_id',coalesce(old_tenant,''),true);RETURN;
 END IF;
 m=c.collection_manifest;a=m->'audio';
 IF m IS NOT NULL THEN
  closed=NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(m->'expected_turn_ids') t WHERE NOT c.encrypted_turns ? t)
   AND ((m->>'result_outcome'='present')=(c.encrypted_message_result IS NOT NULL));
  -- Exact set: any extra accepted turn has an unknown collection scope.
  closed=closed AND (SELECT count(*) FROM jsonb_object_keys(c.encrypted_turns))=jsonb_array_length(m->'expected_turn_ids');
  IF a->>'state'='terminal' THEN
   SELECT count(*),coalesce(sum(sample_count),0),min(sequence),max(sequence) INTO chunk_count,samples,first_seq,last_seq FROM public.sparra_audio_chunk
    WHERE call_id=cid AND workspace_id=wid AND recording_id=(a->>'recording_id')::uuid;
   closed=closed AND c.recording_id=(a->>'recording_id')::uuid
    AND c.audio_finish_reason=a->>'reason' AND c.audio_total_samples=(a->>'total_samples')::int
    AND c.audio_last_sequence IS NOT DISTINCT FROM (a->>'last_sequence')::int
    AND chunk_count=coalesce((a->>'last_sequence')::int+1,0) AND samples=(a->>'total_samples')::int
    AND (chunk_count=0 OR (first_seq=0 AND last_seq=(a->>'last_sequence')::int)) AND c.audio_denied_at IS NULL;
  ELSE closed=closed AND c.audio_state=a->>'state';END IF;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'state',state,'service_name',service_name,
  'window_start',window_start,'window_end',window_end,'current_start',current_start,'current_end',current_end,
  'timezone',policy->>'timeZone','buffer_minutes',policy->'bufferMinutes','event_id',event_id,'observed_state',observed_state)
  ORDER BY created_at DESC,id),'[]') INTO bookings FROM public.sparra_calendar_command WHERE workspace_id=wid AND call_id=cid AND kind='book_appointment';
 bundle=jsonb_build_object('schema_version',1,'collection',m,'collection_closed',coalesce(closed,false),
  'status',c.status,'configuration_revision',c.configuration_revision,'from_e164',c.from_e164,'admitted_at',c.admitted_at,'ended_at',c.ended_at,
  'end_reason',c.end_reason,'disclosure_state',c.disclosure_state,'transcript_loss_count',c.transcript_loss_count,
  'encrypted_turns',c.encrypted_turns,'encrypted_message_result',c.encrypted_message_result,'bookings',bookings,
  'audio',jsonb_build_object('state',c.audio_state,'recording_id',c.recording_id,'total_samples',c.audio_total_samples,'last_sequence',c.audio_last_sequence,'finish_reason',c.audio_finish_reason,'coverage','unknown'));
 IF c.publication_snapshot IS DISTINCT FROM bundle THEN
  UPDATE public.sparra_call SET publication_snapshot=bundle,collection_closed=coalesce(closed,false),
   publication_version=publication_version+1,publication_token=gen_random_uuid() WHERE id=cid;
 END IF;
 PERFORM set_config('app.tenant_id',coalesce(old_tenant,''),true);
END $$;
ALTER FUNCTION app_private.publish_sparra_inbox_v1(uuid,uuid) OWNER TO workspace_owner;
REVOKE ALL ON FUNCTION app_private.publish_sparra_inbox_v1(uuid,uuid) FROM PUBLIC,runtime,workspace_bootstrap;
GRANT EXECUTE ON FUNCTION app_private.publish_sparra_inbox_v1(uuid,uuid) TO sparra_voice_definer,calendar_definer;
GRANT USAGE ON SCHEMA app_private TO sparra_voice_definer;
--> statement-breakpoint
ALTER FUNCTION voice_private.ingest_contract(jsonb,integer) RENAME TO ingest_without_inbox;
CREATE FUNCTION voice_private.ingest_contract(op jsonb,expected_version integer) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE answer jsonb; c public.sparra_call; b voice_private.deployment_binding;
BEGIN
 b=voice_private.lock_binding();
 IF expected_version=1 THEN PERFORM voice_private.validate_operation(op);ELSE PERFORM voice_private.validate_audio_operation(op);END IF;
 -- Same call lock as ingress and human declarations; any marker conflict rolls back the full statement.
 SELECT * INTO c FROM public.sparra_call WHERE id=(op->>'call_id')::uuid FOR UPDATE;
 answer=voice_private.ingest_without_inbox(op,expected_version);
 -- Preserve the original receipt's conflict/duplicate result before checking a fresh marker.
 IF answer->>'status'='applied' AND op->>'kind'='call.upsert' AND op->'payload' ? 'collection'
  AND c.collection_manifest IS NOT NULL AND c.collection_manifest<>op->'payload'->'collection'
 THEN RAISE EXCEPTION 'Voice collection conflict' USING ERRCODE='PV202';END IF;
 IF answer->>'status'='applied' AND op->>'kind' IN ('call.upsert','turn.upsert','audio.chunk','audio.finish','audio.revoke') THEN
  IF op->>'kind'='call.upsert' AND op->'payload' ? 'collection' THEN
   UPDATE public.sparra_call SET collection_manifest=op->'payload'->'collection' WHERE id=(op->>'call_id')::uuid;
  END IF;
  PERFORM app_private.publish_sparra_inbox_v1((op->>'call_id')::uuid,b.workspace_id);
 END IF;
 RETURN answer;
END $$;
ALTER FUNCTION voice_private.ingest_contract(jsonb,integer) OWNER TO sparra_voice_definer;
REVOKE ALL ON FUNCTION voice_private.ingest_contract(jsonb,integer),voice_private.ingest_without_inbox(jsonb,integer) FROM PUBLIC,runtime,workspace_bootstrap;
--> statement-breakpoint
-- Existing calendar RPCs hold Workspace before command/call locks. Ignore lease/accounting fields.
CREATE FUNCTION app_private.calendar_inbox_lock_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW.call_id IS NOT NULL THEN PERFORM id FROM public.sparra_call WHERE id=NEW.call_id AND workspace_id=NEW.workspace_id FOR UPDATE;END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION app_private.calendar_inbox_lock_v1() OWNER TO calendar_definer;
GRANT UPDATE(id) ON public.sparra_call TO calendar_definer;
CREATE POLICY calendar_call_lock ON public.sparra_call FOR UPDATE TO calendar_definer USING (true) WITH CHECK (true);
CREATE FUNCTION app_private.calendar_inbox_publish_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW.call_id IS NOT NULL AND NEW.kind='book_appointment' THEN PERFORM app_private.publish_sparra_inbox_v1(NEW.call_id,NEW.workspace_id);END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION app_private.calendar_inbox_publish_v1() OWNER TO calendar_definer;
REVOKE ALL ON FUNCTION app_private.calendar_inbox_lock_v1(),app_private.calendar_inbox_publish_v1() FROM PUBLIC,runtime,workspace_bootstrap,sparra_voice_definer;
CREATE TRIGGER calendar_inbox_lock BEFORE INSERT OR UPDATE OF state,result,observed_state,current_start,current_end ON public.sparra_calendar_command
 FOR EACH ROW EXECUTE FUNCTION app_private.calendar_inbox_lock_v1();
CREATE TRIGGER calendar_inbox_publish AFTER INSERT OR UPDATE OF state,result,observed_state,current_start,current_end ON public.sparra_calendar_command
 FOR EACH ROW EXECUTE FUNCTION app_private.calendar_inbox_publish_v1();

--> statement-breakpoint
-- Preserve the first declaration date, but never infer A or closure from legacy treated/closed.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT id,workspace_id FROM public.sparra_call LOOP
  PERFORM app_private.publish_sparra_inbox_v1(c.id,c.workspace_id);
 END LOOP;
END $$;
--> statement-breakpoint
-- Native runtime owns the authenticated Workspace lease; only this bounded
-- command may mutate declaration state. No direct C/T/snapshot grant is added.
REVOKE UPDATE(treated_at) ON public.sparra_call FROM runtime;
CREATE FUNCTION app_private.update_sparra_follow_up_v1(wid uuid,cid uuid,expected_c integer,expected_t uuid,treated boolean)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=on AS $$
DECLARE c public.sparra_call;
BEGIN
 IF wid::text IS DISTINCT FROM current_setting('app.tenant_id',true)
  OR wid='00000000-0000-0000-0000-000000000000' OR treated IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.workspace WHERE id=wid AND kind='personal' AND lifecycle='active' AND auth_organization_id IS NULL)
 THEN RETURN 'missing';END IF;
 SELECT * INTO c FROM public.sparra_call WHERE id=cid AND workspace_id=wid FOR UPDATE;
 -- Evaluate time after acquiring the shared publication lock, not before a wait.
 IF NOT FOUND OR c.erasure_requested_at IS NOT NULL OR c.retention_until<=clock_timestamp() THEN RETURN 'missing';END IF;
 IF expected_c IS DISTINCT FROM c.publication_version OR expected_t IS DISTINCT FROM c.publication_token THEN RETURN 'conflict';END IF;
 IF c.publication_version=0 OR c.publication_snapshot IS NULL OR NOT c.collection_closed
  OR c.publication_snapshot->>'collection_closed' IS DISTINCT FROM 'true'
  OR c.publication_snapshot->'collection' IS NULL OR c.publication_snapshot->'collection'='null'::jsonb
 THEN RETURN 'provisional';END IF;
 UPDATE public.sparra_call SET declared_publication=CASE WHEN treated THEN publication_version ELSE declared_publication END,
  declaration_active=treated,treated_at=CASE WHEN treated THEN coalesce(treated_at,clock_timestamp()) ELSE treated_at END,
  publication_token=gen_random_uuid() WHERE id=cid AND workspace_id=wid;
 RETURN 'applied';
END $$;
ALTER FUNCTION app_private.update_sparra_follow_up_v1(uuid,uuid,integer,uuid,boolean) OWNER TO workspace_owner;
REVOKE ALL ON FUNCTION app_private.update_sparra_follow_up_v1(uuid,uuid,integer,uuid,boolean) FROM PUBLIC,workspace_bootstrap,sparra_voice_definer,calendar_definer;
GRANT EXECUTE ON FUNCTION app_private.update_sparra_follow_up_v1(uuid,uuid,integer,uuid,boolean) TO runtime;
