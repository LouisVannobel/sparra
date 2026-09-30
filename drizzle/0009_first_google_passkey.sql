CREATE TABLE "first_google_passkey_intent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"recovery_generation" integer NOT NULL,
	"account_id" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"phase" text NOT NULL,
	"reason" text,
	"authenticated_at" timestamp (3) with time zone,
	"registration_verification_identifier" text,
	"passkey_id" text,
	CONSTRAINT "first_google_passkey_intent_generation" CHECK ("first_google_passkey_intent"."recovery_generation" >= 0),
	CONSTRAINT "first_google_passkey_intent_expiry" CHECK ("first_google_passkey_intent"."expires_at" > "first_google_passkey_intent"."created_at" and "first_google_passkey_intent"."expires_at" <= "first_google_passkey_intent"."created_at" + interval '5 minutes'),
	CONSTRAINT "first_google_passkey_intent_phase" CHECK ("first_google_passkey_intent"."phase" in ('PENDING_GOOGLE','EXCHANGING','AUTHORIZED','CONSUMED','INVALIDATED')),
	CONSTRAINT "first_google_passkey_intent_authority" CHECK ("first_google_passkey_intent"."phase" not in ('AUTHORIZED','CONSUMED') or "first_google_passkey_intent"."authenticated_at" is not null),
	CONSTRAINT "first_google_passkey_intent_reason" CHECK (("first_google_passkey_intent"."phase" = 'INVALIDATED' and "first_google_passkey_intent"."reason" is not null and "first_google_passkey_intent"."reason" in ('unavailable','proof_unavailable','proof_stale','cancelled','superseded')) or ("first_google_passkey_intent"."phase" <> 'INVALIDATED' and "first_google_passkey_intent"."reason" is null))
);
--> statement-breakpoint
ALTER TABLE "first_google_passkey_intent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "first_google_passkey_intent" ADD CONSTRAINT "first_google_passkey_intent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "first_google_passkey_intent" ADD CONSTRAINT "first_google_passkey_intent_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "first_google_passkey_intent_retention_idx" ON "first_google_passkey_intent" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE POLICY "first_google_passkey_intent_scope" ON "first_google_passkey_intent" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000') WITH CHECK (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000');