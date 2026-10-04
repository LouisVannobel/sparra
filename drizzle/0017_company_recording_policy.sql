ALTER TABLE public.sparra_knowledge_revision ADD COLUMN recording_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE voice_private.deployment_binding DROP CONSTRAINT voice_binding_audio_off;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION voice.begin_call_v1(deployment text,call_id uuid,routing jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
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
