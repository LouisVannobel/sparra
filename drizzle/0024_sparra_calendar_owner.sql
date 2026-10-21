CREATE TABLE "sparra_calendar_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"google_subject" text,
	"account_email" text,
	"token_envelope" text,
	"state_hash" text,
	"state_session" text,
	"state_secret" text,
	"state_expires_at" timestamp (3) with time zone,
	"work_id" uuid,
	"work_expires_at" timestamp (3) with time zone,
	"policy_revision" integer DEFAULT 0 NOT NULL,
	"policy" jsonb,
	"calendar_id" text,
	"calendar_summary" text,
	"enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sparra_calendar_connection_workspace_id_unique" UNIQUE("workspace_id"),
	CONSTRAINT "calendar_generation" CHECK ("sparra_calendar_connection"."generation" >= 0 and "sparra_calendar_connection"."policy_revision" >= 0),
	CONSTRAINT "calendar_status" CHECK ("sparra_calendar_connection"."status" in ('disconnected','connecting','connected','reconnect_required','revoking')),
	CONSTRAINT "calendar_active_rules" CHECK (not "sparra_calendar_connection"."enabled" or ("sparra_calendar_connection"."status" = 'connected' and "sparra_calendar_connection"."policy" is not null and "sparra_calendar_connection"."calendar_id" is not null and "sparra_calendar_connection"."policy_revision" > 0)),
	CONSTRAINT "calendar_credentials" CHECK (("sparra_calendar_connection"."status" in ('connected','reconnect_required','revoking')) = ("sparra_calendar_connection"."google_subject" is not null and "sparra_calendar_connection"."token_envelope" is not null and "sparra_calendar_connection"."account_email" is not null)),
	CONSTRAINT "calendar_policy_shape" CHECK ("sparra_calendar_connection"."policy" is null or (jsonb_typeof("sparra_calendar_connection"."policy") = 'object' and "sparra_calendar_connection"."policy"->>'version' = '1')),
	CONSTRAINT "calendar_state_bound" CHECK (("sparra_calendar_connection"."state_hash" is null and "sparra_calendar_connection"."state_secret" is null and "sparra_calendar_connection"."state_session" is null and "sparra_calendar_connection"."state_expires_at" is null) or ("sparra_calendar_connection"."status" = 'connecting' and "sparra_calendar_connection"."state_hash" ~ '^[a-f0-9]{64}$' and "sparra_calendar_connection"."state_secret" is not null and "sparra_calendar_connection"."state_session" is not null and isfinite("sparra_calendar_connection"."state_expires_at")))
);
--> statement-breakpoint
ALTER TABLE "sparra_calendar_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sparra_calendar_connection" ADD CONSTRAINT "sparra_calendar_connection_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_active_google_subject" ON "sparra_calendar_connection" USING btree ("google_subject") WHERE "sparra_calendar_connection"."google_subject" is not null;--> statement-breakpoint
CREATE POLICY "calendar_owner" ON "sparra_calendar_connection" AS PERMISSIVE FOR ALL TO "runtime" USING ("sparra_calendar_connection"."workspace_id"::text = current_setting('app.tenant_id',true)) WITH CHECK ("sparra_calendar_connection"."workspace_id"::text = current_setting('app.tenant_id',true));
--> statement-breakpoint
ALTER TABLE public.sparra_calendar_connection FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.sparra_calendar_connection TO runtime;
REVOKE ALL ON public.sparra_calendar_connection FROM PUBLIC;
