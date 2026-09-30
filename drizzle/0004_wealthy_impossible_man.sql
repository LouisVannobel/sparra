CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'personal' NOT NULL,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"owner_user_id" text NOT NULL,
	"auth_organization_id" text,
	"display_name" text DEFAULT 'Workspace' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_owner_user_id_unique" UNIQUE("owner_user_id"),
	CONSTRAINT "workspace_personal" CHECK ("workspace"."kind" = 'personal' and "workspace"."auth_organization_id" is null),
	CONSTRAINT "workspace_lifecycle" CHECK ("workspace"."lifecycle" in ('provisioning','active','deleting')),
	CONSTRAINT "workspace_nonzero_id" CHECK ("workspace"."id" <> '00000000-0000-0000-0000-000000000000'::uuid),
	CONSTRAINT "workspace_display_name" CHECK (length("workspace"."display_name") between 1 and 80 and length(btrim("workspace"."display_name")) > 0 and "workspace"."display_name" !~ '[[:cntrl:]]' and position(chr(8232) in "workspace"."display_name") = 0 and position(chr(8233) in "workspace"."display_name") = 0)
);
--> statement-breakpoint
ALTER TABLE "workspace" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"occurred_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "workspace_audit_action" CHECK ("workspace_audit"."action" in ('personal-created','display-name-changed'))
);
--> statement-breakpoint
ALTER TABLE "workspace_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "workspace_tenant" ON "workspace" AS PERMISSIVE FOR ALL TO "runtime" USING ("workspace"."id"::text = current_setting('app.tenant_id', true) and "workspace"."lifecycle" = 'active') WITH CHECK ("workspace"."id"::text = current_setting('app.tenant_id', true) and "workspace"."lifecycle" = 'active');--> statement-breakpoint
CREATE POLICY "workspace_bootstrap" ON "workspace" AS PERMISSIVE FOR ALL TO "workspace_bootstrap" USING (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000') WITH CHECK (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "workspace_audit_tenant_insert" ON "workspace_audit" AS PERMISSIVE FOR INSERT TO "runtime" WITH CHECK ("workspace_audit"."workspace_id"::text = current_setting('app.tenant_id', true) and "workspace_audit"."action" = 'display-name-changed');--> statement-breakpoint
CREATE POLICY "workspace_audit_bootstrap_insert" ON "workspace_audit" AS PERMISSIVE FOR INSERT TO "workspace_bootstrap" WITH CHECK (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000' and "workspace_audit"."action" = 'personal-created');
--> statement-breakpoint
-- Operator-owned prerequisites; only the disposable fixture provisions roles.
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('workspace_owner','workspace_bootstrap')
    AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid OR r.oid=m.member WHERE r.rolname IN ('workspace_owner','workspace_bootstrap')) THEN
    RAISE EXCEPTION 'Workspace role prerequisites not satisfied';
  END IF;
END $$;
ALTER TABLE public.workspace OWNER TO workspace_owner;
ALTER TABLE public.workspace_audit OWNER TO workspace_owner;
ALTER TABLE public.workspace FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_audit FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace,public.workspace_audit FROM PUBLIC;
CREATE SCHEMA app_private AUTHORIZATION workspace_owner;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
GRANT USAGE ON SCHEMA app_private TO runtime,workspace_bootstrap;
GRANT USAGE ON SCHEMA public TO runtime,workspace_owner,workspace_bootstrap;
GRANT SELECT(id,recovering,recovery_generation),UPDATE(id) ON public."user" TO workspace_bootstrap;
GRANT SELECT(id,user_id,auth_state,recovery_generation,expires_at,last_activity_at,authenticated_at),UPDATE(id) ON public.session TO workspace_bootstrap;
GRANT SELECT,INSERT,UPDATE(id) ON public.workspace TO workspace_bootstrap;
GRANT INSERT ON public.workspace_audit TO workspace_bootstrap,runtime;
GRANT SELECT,UPDATE(display_name,updated_at) ON public.workspace TO runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.resolve_personal_workspace(actor_user_id text, actor_session_id text, create_if_missing boolean) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  current_user_row record;
  current_session_row record;
  selected_row record;
  selected_id uuid;
  current_time_value timestamptz;
  correlation text;
BEGIN
  IF current_setting('app.tenant_id', true) IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'
    OR actor_user_id IS NULL OR actor_user_id = '' OR actor_session_id IS NULL OR actor_session_id = '' OR create_if_missing IS NULL THEN RETURN NULL; END IF;
  correlation := current_setting('app.correlation_id', true);
  IF correlation IS NULL OR correlation !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN RETURN NULL; END IF;
  SELECT u.id,u.recovering,u.recovery_generation INTO current_user_row FROM public."user" u WHERE u.id=actor_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT s.id,s.user_id,s.auth_state,s.recovery_generation,s.expires_at,s.last_activity_at,s.authenticated_at INTO current_session_row
    FROM public.session s WHERE s.id=actor_session_id AND s.user_id=actor_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  current_time_value := clock_timestamp();
  IF current_user_row.recovering OR current_session_row.auth_state <> 'ACTIVE'
    OR current_session_row.recovery_generation <> current_user_row.recovery_generation
    OR current_session_row.expires_at <= current_time_value
    OR current_session_row.last_activity_at <= current_time_value - interval '43200 seconds'
    OR current_session_row.authenticated_at + interval '604800 seconds' <= current_time_value THEN RETURN NULL; END IF;
  SELECT w.id,w.kind,w.lifecycle,w.auth_organization_id INTO selected_row FROM public.workspace w WHERE w.owner_user_id=actor_user_id FOR UPDATE;
  IF FOUND THEN
    IF selected_row.kind='personal' AND selected_row.lifecycle='active' AND selected_row.auth_organization_id IS NULL THEN RETURN selected_row.id; END IF;
    RETURN NULL;
  END IF;
  IF NOT create_if_missing THEN RETURN NULL; END IF;
  INSERT INTO public.workspace(owner_user_id) VALUES(actor_user_id) ON CONFLICT(owner_user_id) DO NOTHING RETURNING id INTO selected_id;
  IF selected_id IS NOT NULL THEN
    INSERT INTO public.workspace_audit(action,actor_user_id,workspace_id,correlation_id)
      VALUES('personal-created',actor_user_id,selected_id,correlation::uuid);
    RETURN selected_id;
  END IF;
  -- A distinct VOLATILE statement sees a concurrent unique-owner winner.
  SELECT w.id,w.kind,w.lifecycle,w.auth_organization_id INTO selected_row FROM public.workspace w WHERE w.owner_user_id=actor_user_id FOR UPDATE;
  IF FOUND AND selected_row.kind='personal' AND selected_row.lifecycle='active' AND selected_row.auth_organization_id IS NULL THEN RETURN selected_row.id; END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION app_private.resolve_personal_workspace(text,text,boolean) OWNER TO workspace_bootstrap;
REVOKE ALL ON FUNCTION app_private.resolve_personal_workspace(text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.resolve_personal_workspace(text,text,boolean) TO runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.workspace_audit_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Workspace audit is append-only' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION app_private.workspace_audit_immutable() FROM PUBLIC;
CREATE TRIGGER workspace_audit_immutable BEFORE UPDATE OR DELETE ON public.workspace_audit FOR EACH ROW EXECUTE FUNCTION app_private.workspace_audit_immutable();
