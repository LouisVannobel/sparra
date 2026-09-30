CREATE TABLE "additional_passkey_intent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"recovery_generation" integer NOT NULL,
	"phase" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"authentication_challenge" text,
	"authorizing_key_id" text,
	"authorizing_credential_id" text,
	"authorizing_public_key" text,
	"registration_verification_identifier" text,
	CONSTRAINT "additional_passkey_intent_generation" CHECK ("additional_passkey_intent"."recovery_generation" >= 0),
	CONSTRAINT "additional_passkey_intent_phase" CHECK ((
    "additional_passkey_intent"."phase" = 'CHALLENGE' and "additional_passkey_intent"."authentication_challenge" is not null
    and "additional_passkey_intent"."authorizing_key_id" is null and "additional_passkey_intent"."authorizing_credential_id" is null
    and "additional_passkey_intent"."authorizing_public_key" is null and "additional_passkey_intent"."registration_verification_identifier" is null
  ) or (
    "additional_passkey_intent"."phase" in ('AUTHORIZED','CONSUMED') and "additional_passkey_intent"."authentication_challenge" is null
    and "additional_passkey_intent"."authorizing_key_id" is not null and "additional_passkey_intent"."authorizing_credential_id" is not null
    and "additional_passkey_intent"."authorizing_public_key" is not null and "additional_passkey_intent"."registration_verification_identifier" is not null
  ))
);
--> statement-breakpoint
ALTER TABLE "additional_passkey_intent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "additional_passkey_intent" ADD CONSTRAINT "additional_passkey_intent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "additional_passkey_intent" ADD CONSTRAINT "additional_passkey_intent_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "additional_passkey_intent_expired_idx" ON "additional_passkey_intent" USING btree ("user_id","expires_at","id");--> statement-breakpoint
CREATE POLICY "additional_passkey_intent_scope" ON "additional_passkey_intent" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000') WITH CHECK (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000');