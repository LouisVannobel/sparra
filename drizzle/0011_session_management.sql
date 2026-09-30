CREATE TABLE "auth_session_revocation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" text NOT NULL,
	"authorizing_session_id" text NOT NULL,
	"target_session_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"correlation_id" uuid NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_session_revocation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "auth_session_revocation_insert" ON "auth_session_revocation" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000');