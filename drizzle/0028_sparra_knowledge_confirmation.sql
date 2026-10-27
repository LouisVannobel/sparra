CREATE TABLE "sparra_knowledge_capture" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"capture_id" uuid NOT NULL,
	"source" jsonb,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "sparra_capture_bounded" CHECK (("sparra_knowledge_capture"."source" is null or (jsonb_typeof("sparra_knowledge_capture"."source") = 'object' and octet_length("sparra_knowledge_capture"."source"::text) <= 400000)) and isfinite("sparra_knowledge_capture"."expires_at"))
);
--> statement-breakpoint
ALTER TABLE "sparra_knowledge_capture" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sparra_knowledge_confirmation" (
	"workspace_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"draft_version" integer NOT NULL,
	"revision" integer NOT NULL,
	"input_hash" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"saved_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "sparra_knowledge_confirmation_workspace_id_draft_id_draft_version_pk" PRIMARY KEY("workspace_id","draft_id","draft_version"),
	CONSTRAINT "sparra_confirmation_identity" CHECK ("sparra_knowledge_confirmation"."draft_version" > 0 and "sparra_knowledge_confirmation"."revision" > 0 and "sparra_knowledge_confirmation"."input_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "sparra_confirmation_bounded" CHECK (jsonb_typeof("sparra_knowledge_confirmation"."provenance") = 'object' and octet_length("sparra_knowledge_confirmation"."provenance"::text) <= 400000),
	CONSTRAINT "sparra_confirmation_retention" CHECK (isfinite("sparra_knowledge_confirmation"."saved_at") and "sparra_knowledge_confirmation"."expires_at" = "sparra_knowledge_confirmation"."saved_at" + interval '604800 seconds')
);
--> statement-breakpoint
ALTER TABLE "sparra_knowledge_confirmation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sparra_knowledge_capture" ADD CONSTRAINT "sparra_knowledge_capture_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sparra_knowledge_confirmation" ADD CONSTRAINT "sparra_knowledge_confirmation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "sparra_capture_runtime" ON "sparra_knowledge_capture" AS PERMISSIVE FOR ALL TO "runtime" USING ("sparra_knowledge_capture"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000' and exists (select 1 from public.workspace where workspace.id = "sparra_knowledge_capture"."workspace_id" and workspace.lifecycle = 'active')) WITH CHECK ("sparra_knowledge_capture"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000' and exists (select 1 from public.workspace where workspace.id = "sparra_knowledge_capture"."workspace_id" and workspace.lifecycle = 'active'));--> statement-breakpoint
CREATE POLICY "sparra_capture_cleanup" ON "sparra_knowledge_capture" AS PERMISSIVE FOR ALL TO "workspace_owner" USING ("sparra_knowledge_capture"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000') WITH CHECK ("sparra_knowledge_capture"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "sparra_capture_voice" ON "sparra_knowledge_capture" AS PERMISSIVE FOR ALL TO "sparra_voice_definer" USING (workspace_id = voice_private.bound_workspace()) WITH CHECK (workspace_id = voice_private.bound_workspace());--> statement-breakpoint
CREATE POLICY "sparra_confirmation_read" ON "sparra_knowledge_confirmation" AS PERMISSIVE FOR SELECT TO "runtime" USING ("sparra_knowledge_confirmation"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000' and exists (select 1 from public.workspace where workspace.id = "sparra_knowledge_confirmation"."workspace_id" and workspace.lifecycle = 'active'));--> statement-breakpoint
CREATE POLICY "sparra_confirmation_insert" ON "sparra_knowledge_confirmation" AS PERMISSIVE FOR INSERT TO "runtime" WITH CHECK ("sparra_knowledge_confirmation"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000' and exists (select 1 from public.workspace where workspace.id = "sparra_knowledge_confirmation"."workspace_id" and workspace.lifecycle = 'active'));--> statement-breakpoint
CREATE POLICY "sparra_confirmation_cleanup" ON "sparra_knowledge_confirmation" AS PERMISSIVE FOR ALL TO "workspace_owner" USING ("sparra_knowledge_confirmation"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000') WITH CHECK ("sparra_knowledge_confirmation"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "sparra_confirmation_voice" ON "sparra_knowledge_confirmation" AS PERMISSIVE FOR ALL TO "sparra_voice_definer" USING (workspace_id = voice_private.bound_workspace()) WITH CHECK (workspace_id = voice_private.bound_workspace());--> statement-breakpoint
ALTER TABLE public.sparra_knowledge_capture OWNER TO workspace_owner;
ALTER TABLE public.sparra_knowledge_confirmation OWNER TO workspace_owner;
ALTER TABLE public.sparra_knowledge_capture FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sparra_knowledge_confirmation FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sparra_knowledge_capture,public.sparra_knowledge_confirmation FROM PUBLIC,runtime,workspace_bootstrap;
GRANT SELECT,INSERT,UPDATE ON public.sparra_knowledge_capture TO runtime;
GRANT SELECT,INSERT ON public.sparra_knowledge_confirmation TO runtime;
GRANT SELECT,DELETE ON public.sparra_knowledge_capture,public.sparra_knowledge_confirmation TO sparra_voice_definer;
--> statement-breakpoint
CREATE FUNCTION app_private.sparra_confirmation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Knowledge confirmation is immutable' USING ERRCODE='23514';END $$;
ALTER FUNCTION app_private.sparra_confirmation_immutable() OWNER TO workspace_owner;
REVOKE ALL ON FUNCTION app_private.sparra_confirmation_immutable() FROM PUBLIC;
CREATE TRIGGER sparra_confirmation_immutable BEFORE UPDATE ON public.sparra_knowledge_confirmation FOR EACH ROW EXECUTE FUNCTION app_private.sparra_confirmation_immutable();
--> statement-breakpoint
-- Selected only inside the native personal lease: no arbitrary SQL or pool.
CREATE FUNCTION public.sparra_knowledge_cleanup_v1() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE wid uuid;
BEGIN
 SELECT id INTO wid FROM public.workspace WHERE id::text=current_setting('app.tenant_id',true) AND lifecycle='active';
 IF wid IS NULL THEN RAISE EXCEPTION 'Knowledge cleanup authority unavailable' USING ERRCODE='23514';END IF;
 DELETE FROM public.sparra_knowledge_capture WHERE workspace_id=wid AND expires_at<=clock_timestamp();
 DELETE FROM public.sparra_knowledge_confirmation WHERE (workspace_id,draft_id,draft_version) IN
  (SELECT workspace_id,draft_id,draft_version FROM public.sparra_knowledge_confirmation WHERE workspace_id=wid AND expires_at<=clock_timestamp() ORDER BY expires_at,draft_id,draft_version LIMIT 100);
END $$;
ALTER FUNCTION public.sparra_knowledge_cleanup_v1() OWNER TO workspace_owner;
REVOKE ALL ON FUNCTION public.sparra_knowledge_cleanup_v1() FROM PUBLIC,workspace_bootstrap;
GRANT EXECUTE ON FUNCTION public.sparra_knowledge_cleanup_v1() TO runtime;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION voice_private.maintenance() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE old_tenant text=current_setting('app.tenant_id',true); wid uuid=voice_private.bound_workspace(); candidate record; blocked_constraint text; blocked_schema text; blocked_table text;
BEGIN
 DELETE FROM public.sparra_knowledge_capture WHERE expires_at<=clock_timestamp();
 DELETE FROM public.sparra_knowledge_confirmation WHERE (workspace_id,draft_id,draft_version) IN
  (SELECT workspace_id,draft_id,draft_version FROM public.sparra_knowledge_confirmation WHERE expires_at<=clock_timestamp() ORDER BY expires_at,draft_id,draft_version LIMIT 100);
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
 FOR candidate IN
  SELECT workspace_id,revision FROM public.sparra_knowledge_revision v
  WHERE EXISTS(SELECT 1 FROM public.sparra_knowledge_revision latest WHERE latest.workspace_id=v.workspace_id AND latest.revision>v.revision)
  AND NOT EXISTS(SELECT 1 FROM public.sparra_call c WHERE c.workspace_id=v.workspace_id AND c.configuration_revision=v.revision)
  ORDER BY revision LIMIT 100
 LOOP
  BEGIN
   DELETE FROM public.sparra_knowledge_revision WHERE workspace_id=candidate.workspace_id AND revision=candidate.revision;
  EXCEPTION WHEN foreign_key_violation THEN
   -- Calls belonging to another deployment remain hidden by FORCE RLS. The
   -- exact native FK still protects their revision; retain that candidate
   -- without rolling back independent expiry/cleanup work in this transaction.
   GET STACKED DIAGNOSTICS blocked_constraint=CONSTRAINT_NAME,blocked_schema=SCHEMA_NAME,blocked_table=TABLE_NAME;
   IF blocked_constraint IS DISTINCT FROM 'sparra_call_configuration_pin'
    OR blocked_schema IS DISTINCT FROM 'public' OR blocked_table IS DISTINCT FROM 'sparra_call' THEN RAISE;END IF;
  END;
 END LOOP;
END $$;
