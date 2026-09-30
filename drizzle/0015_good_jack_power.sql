CREATE TABLE "sparra_call" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"configuration_revision" integer,
	"deployment_id" text NOT NULL,
	"provider_call_control_id" text NOT NULL,
	"provider_call_leg_id" text,
	"provider_call_session_id" text,
	"admitted_at" timestamp (3) with time zone NOT NULL,
	"retention_until" timestamp (3) with time zone NOT NULL,
	"ended_at" timestamp (3) with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"disclosure_state" text DEFAULT 'pending' NOT NULL,
	"disclosure_started_at" timestamp (3) with time zone,
	"disclosure_completed_at" timestamp (3) with time zone,
	"disclosure_failed_at" timestamp (3) with time zone,
	"input_gate_opened_at" timestamp (3) with time zone,
	"encrypted_turns" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_message_result" jsonb,
	"treated_at" timestamp (3) with time zone,
	"erasure_requested_at" timestamp (3) with time zone,
	CONSTRAINT "sparra_call_provider_identity" UNIQUE("deployment_id","provider_call_control_id"),
	CONSTRAINT "sparra_call_nonzero_workspace" CHECK ("sparra_call"."workspace_id" <> '00000000-0000-0000-0000-000000000000'::uuid),
	CONSTRAINT "sparra_call_identity" CHECK (length("sparra_call"."deployment_id") between 1 and 256 and length("sparra_call"."provider_call_control_id") between 1 and 1024),
	CONSTRAINT "sparra_call_retention" CHECK (isfinite("sparra_call"."admitted_at") and isfinite("sparra_call"."retention_until") and "sparra_call"."retention_until" = "sparra_call"."admitted_at" + interval '2592000 seconds'),
	CONSTRAINT "sparra_call_status" CHECK ("sparra_call"."status" in ('pending','active','closing','closed','failed')),
	CONSTRAINT "sparra_call_disclosure" CHECK ("sparra_call"."disclosure_state" in ('pending','completed','failed')),
	CONSTRAINT "sparra_call_turns" CHECK (jsonb_typeof("sparra_call"."encrypted_turns") = 'object' and octet_length("sparra_call"."encrypted_turns"::text) <= 524288),
	CONSTRAINT "sparra_call_result" CHECK ("sparra_call"."encrypted_message_result" is null or (jsonb_typeof("sparra_call"."encrypted_message_result") = 'object' and octet_length("sparra_call"."encrypted_message_result"::text) <= 16384)),
	CONSTRAINT "sparra_call_finite_ended_at" CHECK ("sparra_call"."ended_at" is null or isfinite("sparra_call"."ended_at")),
	CONSTRAINT "sparra_call_finite_disclosure_started_at" CHECK ("sparra_call"."disclosure_started_at" is null or isfinite("sparra_call"."disclosure_started_at")),
	CONSTRAINT "sparra_call_finite_disclosure_completed_at" CHECK ("sparra_call"."disclosure_completed_at" is null or isfinite("sparra_call"."disclosure_completed_at")),
	CONSTRAINT "sparra_call_finite_disclosure_failed_at" CHECK ("sparra_call"."disclosure_failed_at" is null or isfinite("sparra_call"."disclosure_failed_at")),
	CONSTRAINT "sparra_call_finite_input_gate_opened_at" CHECK ("sparra_call"."input_gate_opened_at" is null or isfinite("sparra_call"."input_gate_opened_at")),
	CONSTRAINT "sparra_call_finite_treated_at" CHECK ("sparra_call"."treated_at" is null or isfinite("sparra_call"."treated_at")),
	CONSTRAINT "sparra_call_finite_erasure_requested_at" CHECK ("sparra_call"."erasure_requested_at" is null or isfinite("sparra_call"."erasure_requested_at"))
);
--> statement-breakpoint
ALTER TABLE "sparra_call" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sparra_erasure" (
	"workspace_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"deployment_id" text NOT NULL,
	"provider_call_control_id" text NOT NULL,
	"requested_at" timestamp (3) with time zone NOT NULL,
	"original_retention_until" timestamp (3) with time zone NOT NULL,
	"fence_until" timestamp (3) with time zone NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "sparra_erasure_workspace_id_call_id_pk" PRIMARY KEY("workspace_id","call_id"),
	CONSTRAINT "sparra_erasure_provider_identity" UNIQUE("deployment_id","provider_call_control_id"),
	CONSTRAINT "sparra_erasure_nonzero_workspace" CHECK ("sparra_erasure"."workspace_id" <> '00000000-0000-0000-0000-000000000000'::uuid),
	CONSTRAINT "sparra_erasure_fence" CHECK (isfinite("sparra_erasure"."requested_at") and isfinite("sparra_erasure"."original_retention_until") and isfinite("sparra_erasure"."fence_until") and "sparra_erasure"."fence_until" = "sparra_erasure"."original_retention_until" + interval '900 seconds'),
	CONSTRAINT "sparra_erasure_state" CHECK (("sparra_erasure"."state" = 'queued' and "sparra_erasure"."completed_at" is null) or ("sparra_erasure"."state" = 'completed' and "sparra_erasure"."completed_at" is not null and isfinite("sparra_erasure"."completed_at"))),
	CONSTRAINT "sparra_erasure_lease" CHECK (("sparra_erasure"."lease_token" is null and "sparra_erasure"."lease_until" is null) or ("sparra_erasure"."lease_token" is not null and "sparra_erasure"."lease_until" is not null and isfinite("sparra_erasure"."lease_until")))
);
--> statement-breakpoint
ALTER TABLE "sparra_erasure" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD CONSTRAINT "sparra_call_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sparra_call" ADD CONSTRAINT "sparra_call_configuration_pin" FOREIGN KEY ("workspace_id","configuration_revision") REFERENCES "public"."sparra_knowledge_revision"("workspace_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sparra_call_inbox" ON "sparra_call" USING btree ("workspace_id","admitted_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "sparra_call_read" ON "sparra_call" AS PERMISSIVE FOR SELECT TO "runtime" USING ("sparra_call"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000' and exists (select 1 from public.workspace where workspace.id = "sparra_call"."workspace_id" and workspace.lifecycle = 'active'));--> statement-breakpoint
CREATE POLICY "sparra_call_update" ON "sparra_call" AS PERMISSIVE FOR UPDATE TO "runtime" USING ("sparra_call"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000' and exists (select 1 from public.workspace where workspace.id = "sparra_call"."workspace_id" and workspace.lifecycle = 'active')) WITH CHECK ("sparra_call"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000' and exists (select 1 from public.workspace where workspace.id = "sparra_call"."workspace_id" and workspace.lifecycle = 'active'));--> statement-breakpoint
CREATE POLICY "sparra_call_erase_read" ON "sparra_call" AS PERMISSIVE FOR SELECT TO "workspace_owner" USING ("sparra_call"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "sparra_call_erase_delete" ON "sparra_call" AS PERMISSIVE FOR DELETE TO "workspace_owner" USING ("sparra_call"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "sparra_erasure_read" ON "sparra_erasure" AS PERMISSIVE FOR SELECT TO "runtime" USING ("sparra_erasure"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000' and exists (select 1 from public.workspace where workspace.id = "sparra_erasure"."workspace_id" and workspace.lifecycle = 'active'));--> statement-breakpoint
CREATE POLICY "sparra_erasure_insert" ON "sparra_erasure" AS PERMISSIVE FOR INSERT TO "workspace_owner" WITH CHECK ("sparra_erasure"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
ALTER TABLE public.sparra_call OWNER TO workspace_owner;
ALTER TABLE public.sparra_erasure OWNER TO workspace_owner;
ALTER TABLE public.sparra_call FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sparra_erasure FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sparra_call, public.sparra_erasure FROM PUBLIC, runtime, workspace_bootstrap;
GRANT SELECT ON public.sparra_call, public.sparra_erasure TO runtime;
GRANT UPDATE (treated_at, erasure_requested_at) ON public.sparra_call TO runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.sparra_erase_call() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  INSERT INTO public.sparra_erasure(workspace_id,call_id,deployment_id,provider_call_control_id,requested_at,original_retention_until,fence_until)
  VALUES(OLD.workspace_id,OLD.id,OLD.deployment_id,OLD.provider_call_control_id,clock_timestamp(),OLD.retention_until,OLD.retention_until + interval '900 seconds');
  DELETE FROM public.sparra_call WHERE workspace_id=OLD.workspace_id AND id=OLD.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request unavailable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION app_private.sparra_erase_call() OWNER TO workspace_owner;
REVOKE ALL ON FUNCTION app_private.sparra_erase_call() FROM PUBLIC, runtime, workspace_bootstrap;
CREATE TRIGGER sparra_erase_call AFTER UPDATE OF erasure_requested_at ON public.sparra_call
FOR EACH ROW WHEN (OLD.erasure_requested_at IS NULL AND NEW.erasure_requested_at IS NOT NULL)
EXECUTE FUNCTION app_private.sparra_erase_call();
--> statement-breakpoint
CREATE FUNCTION app_private.sparra_erasure_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.state <> 'completed' OR OLD.fence_until > clock_timestamp() THEN
      RAISE EXCEPTION 'Erasure obligation retained' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.workspace_id,NEW.call_id,NEW.deployment_id,NEW.provider_call_control_id,NEW.requested_at,NEW.original_retention_until,NEW.fence_until)
     IS DISTINCT FROM ROW(OLD.workspace_id,OLD.call_id,OLD.deployment_id,OLD.provider_call_control_id,OLD.requested_at,OLD.original_retention_until,OLD.fence_until)
     OR (OLD.state='completed' AND ROW(NEW.state,NEW.completed_at) IS DISTINCT FROM ROW(OLD.state,OLD.completed_at)) THEN
    RAISE EXCEPTION 'Erasure identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION app_private.sparra_erasure_guard() OWNER TO workspace_owner;
REVOKE ALL ON FUNCTION app_private.sparra_erasure_guard() FROM PUBLIC, runtime, workspace_bootstrap;
CREATE TRIGGER sparra_erasure_guard BEFORE UPDATE OR DELETE ON public.sparra_erasure
FOR EACH ROW EXECUTE FUNCTION app_private.sparra_erasure_guard();
