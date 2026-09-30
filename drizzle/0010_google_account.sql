CREATE TABLE "google_account_intent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"recovery_generation" integer NOT NULL,
	"action" text NOT NULL,
	"locale" text NOT NULL,
	"target_account_id" text,
	"target_subject" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"phase" text NOT NULL,
	"reason" text,
	"authentication_challenge" text,
	"authorizing_key_id" text,
	"authorizing_credential_id" text,
	"authorizing_public_key" text,
	"oauth_state" text,
	"native_account_id" text,
	"provider_subject" text,
	"outcome" text,
	CONSTRAINT "google_account_intent_generation" CHECK ("google_account_intent"."recovery_generation" >= 0),
	CONSTRAINT "google_account_intent_locale" CHECK ("google_account_intent"."locale" in ('fr','en')),
	CONSTRAINT "google_account_intent_expiry" CHECK ("google_account_intent"."expires_at" > "google_account_intent"."created_at" and "google_account_intent"."expires_at" <= "google_account_intent"."created_at" + interval '5 minutes'),
	CONSTRAINT "google_account_intent_target" CHECK (("google_account_intent"."action" = 'LINK' and "google_account_intent"."target_account_id" is null and "google_account_intent"."target_subject" is null) or ("google_account_intent"."action" = 'UNLINK' and "google_account_intent"."target_account_id" is not null and "google_account_intent"."target_subject" is not null)),
	CONSTRAINT "google_account_intent_phase" CHECK ("google_account_intent"."phase" in ('CHALLENGE','AUTHORIZED','EXCHANGING','CONSUMED','INVALIDATED') and ("google_account_intent"."action" = 'LINK' or "google_account_intent"."phase" not in ('AUTHORIZED','EXCHANGING'))),
	CONSTRAINT "google_account_intent_proof" CHECK ((
    "google_account_intent"."phase" = 'CHALLENGE' and "google_account_intent"."authentication_challenge" is not null and "google_account_intent"."authorizing_key_id" is null and "google_account_intent"."authorizing_credential_id" is null and "google_account_intent"."authorizing_public_key" is null and "google_account_intent"."oauth_state" is null
  ) or (
    "google_account_intent"."phase" in ('AUTHORIZED','EXCHANGING') and "google_account_intent"."authentication_challenge" is null and "google_account_intent"."authorizing_key_id" is not null and "google_account_intent"."authorizing_credential_id" is not null and "google_account_intent"."authorizing_public_key" is not null and "google_account_intent"."oauth_state" is not null
  ) or (
    "google_account_intent"."phase" in ('CONSUMED','INVALIDATED') and "google_account_intent"."authentication_challenge" is null and "google_account_intent"."authorizing_key_id" is null and "google_account_intent"."authorizing_credential_id" is null and "google_account_intent"."authorizing_public_key" is null and "google_account_intent"."oauth_state" is null
  )),
	CONSTRAINT "google_account_intent_receipt" CHECK (("google_account_intent"."phase" = 'CONSUMED' and "google_account_intent"."native_account_id" is not null and "google_account_intent"."provider_subject" is not null and "google_account_intent"."outcome" is not null and (("google_account_intent"."action" = 'LINK' and "google_account_intent"."outcome" = 'linked') or ("google_account_intent"."action" = 'UNLINK' and "google_account_intent"."outcome" = 'unlinked'))) or ("google_account_intent"."phase" <> 'CONSUMED' and "google_account_intent"."native_account_id" is null and "google_account_intent"."provider_subject" is null and "google_account_intent"."outcome" is null)),
	CONSTRAINT "google_account_intent_reason" CHECK (("google_account_intent"."phase" = 'INVALIDATED' and "google_account_intent"."reason" is not null and "google_account_intent"."reason" in ('unavailable','expired','cancelled')) or ("google_account_intent"."phase" <> 'INVALIDATED' and "google_account_intent"."reason" is null))
);
--> statement-breakpoint
ALTER TABLE "google_account_intent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "google_account_intent" ADD CONSTRAINT "google_account_intent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_account_intent" ADD CONSTRAINT "google_account_intent_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "google_account_intent_retention_idx" ON "google_account_intent" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE POLICY "google_account_intent_scope" ON "google_account_intent" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000') WITH CHECK (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000');