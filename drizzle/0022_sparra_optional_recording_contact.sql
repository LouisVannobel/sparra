ALTER TABLE "sparra_knowledge_revision" DROP CONSTRAINT "sparra_revision_local_recording";--> statement-breakpoint
ALTER TABLE "sparra_knowledge_revision" ADD CONSTRAINT "sparra_revision_local_recording" CHECK ("sparra_knowledge_revision"."recording_policy" <> 'local_30d' or not "sparra_knowledge_revision"."recording_enabled");
--> statement-breakpoint
-- Preserve the V2 admission authority and original call pins; contact absence is permitted.
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
 IF k.recording_policy='local_30d' AND k.recording_contact_phone IS NOT NULL
 AND voice_private.string_value(to_jsonb(k.recording_contact_phone),16) !~ '^\+[1-9][0-9]{1,14}$'
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
