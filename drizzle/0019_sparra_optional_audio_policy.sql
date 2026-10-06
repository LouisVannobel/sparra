ALTER TABLE "sparra_knowledge_revision" ADD COLUMN "recording_policy" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "sparra_knowledge_revision" ADD COLUMN "recording_contact_phone" text;--> statement-breakpoint
ALTER TABLE "voice_private"."deployment_binding" ADD COLUMN "contract_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_private"."deployment_binding" ADD COLUMN "local_audio_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sparra_knowledge_revision" ADD CONSTRAINT "sparra_revision_recording_policy" CHECK ("sparra_knowledge_revision"."recording_policy" in ('off','local_30d'));--> statement-breakpoint
ALTER TABLE "sparra_knowledge_revision" ADD CONSTRAINT "sparra_revision_recording_contact" CHECK ("sparra_knowledge_revision"."recording_contact_phone" is null or "sparra_knowledge_revision"."recording_contact_phone" ~ '^\+[1-9][0-9]{1,14}$');--> statement-breakpoint
ALTER TABLE "sparra_knowledge_revision" ADD CONSTRAINT "sparra_revision_local_recording" CHECK ("sparra_knowledge_revision"."recording_policy" <> 'local_30d' or ("sparra_knowledge_revision"."recording_contact_phone" is not null and not "sparra_knowledge_revision"."recording_enabled"));--> statement-breakpoint
ALTER TABLE "voice_private"."deployment_binding" ADD CONSTRAINT "voice_binding_contract_version" CHECK ("voice_private"."deployment_binding"."contract_version" in (1,2));--> statement-breakpoint
CREATE POLICY "workspace_local_audio_read" ON "workspace" AS PERMISSIVE FOR SELECT TO "workspace_owner" USING ("workspace"."id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000' and "workspace"."kind" = 'personal' and "workspace"."lifecycle" = 'active' and "workspace"."auth_organization_id" is null);--> statement-breakpoint
CREATE POLICY "voice_binding_local_audio_read" ON "voice_private"."deployment_binding" AS PERMISSIVE FOR SELECT TO "workspace_owner" USING ("voice_private"."deployment_binding"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000' and "voice_private"."deployment_binding"."admission_enabled" and "voice_private"."deployment_binding"."contract_version" = 2 and "voice_private"."deployment_binding"."local_audio_enabled");
--> statement-breakpoint
CREATE FUNCTION public.sparra_local_audio_available_v1() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE tenant text=current_setting('app.tenant_id',true);
BEGIN
 IF tenant IS NULL OR tenant !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR tenant='00000000-0000-0000-0000-000000000000' THEN RETURN false;END IF;
 RETURN EXISTS(
  SELECT 1 FROM public.workspace w
  JOIN voice_private.deployment_binding b ON b.workspace_id=w.id
  JOIN pg_catalog.pg_roles r ON r.rolname=b.service_login AND r.oid=b.service_role_oid AND r.rolcanlogin
  WHERE w.id=tenant::uuid AND w.kind='personal' AND w.lifecycle='active' AND w.auth_organization_id IS NULL
  AND b.admission_enabled AND b.contract_version=2 AND b.local_audio_enabled
 );
END $$;
ALTER FUNCTION public.sparra_local_audio_available_v1() OWNER TO workspace_owner;
REVOKE ALL ON FUNCTION public.sparra_local_audio_available_v1() FROM PUBLIC,workspace_bootstrap,sparra_voice_definer;
GRANT EXECUTE ON FUNCTION public.sparra_local_audio_available_v1() TO runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION voice_private.binding_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE'
 OR ROW(NEW.service_login,NEW.service_role_oid,NEW.deployment_id,NEW.workspace_id,NEW.connection_id,NEW.to_e164,NEW.audio_enabled,NEW.contract_version,NEW.local_audio_enabled)
 IS DISTINCT FROM ROW(OLD.service_login,OLD.service_role_oid,OLD.deployment_id,OLD.workspace_id,OLD.connection_id,OLD.to_e164,OLD.audio_enabled,OLD.contract_version,OLD.local_audio_enabled) THEN
  RAISE EXCEPTION 'Voice binding is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
