CREATE TABLE "recovery_attempt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"recovery_generation" integer NOT NULL,
	"batch_id" uuid NOT NULL,
	"code_id" uuid NOT NULL,
	"google_account_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"oauth_state" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"phase" text NOT NULL,
	CONSTRAINT "recovery_attempt_oauth_state_unique" UNIQUE("oauth_state"),
	CONSTRAINT "recovery_attempt_generation_nonnegative" CHECK ("recovery_attempt"."recovery_generation" >= 0),
	CONSTRAINT "recovery_attempt_issuer_google" CHECK ("recovery_attempt"."issuer" = 'https://accounts.google.com'),
	CONSTRAINT "recovery_attempt_subject_nonempty" CHECK (length("recovery_attempt"."subject") > 0),
	CONSTRAINT "recovery_attempt_state_nonempty" CHECK (length("recovery_attempt"."oauth_state") > 0),
	CONSTRAINT "recovery_attempt_deadline" CHECK ("recovery_attempt"."expires_at" > "recovery_attempt"."created_at" and "recovery_attempt"."expires_at" <= "recovery_attempt"."created_at" + interval '5 minutes'),
	CONSTRAINT "recovery_attempt_phase" CHECK ("recovery_attempt"."phase" in ('PENDING_GOOGLE','EXCHANGING','PROVED'))
);
--> statement-breakpoint
ALTER TABLE "recovery_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recovery_code" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"spent_at" timestamp (3) with time zone,
	CONSTRAINT "recovery_code_digest_unique" UNIQUE("digest"),
	CONSTRAINT "recovery_code_digest_hex" CHECK ("recovery_code"."digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "recovery_code" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recovery_code_batch" (
	"user_id" text PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"format_version" integer NOT NULL,
	"recovery_generation" integer NOT NULL,
	"issued_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "recovery_code_batch_batch_id_unique" UNIQUE("batch_id"),
	CONSTRAINT "recovery_code_batch_owner_unique" UNIQUE("user_id","batch_id"),
	CONSTRAINT "recovery_code_batch_format_v1" CHECK ("recovery_code_batch"."format_version" = 1),
	CONSTRAINT "recovery_code_batch_generation_nonnegative" CHECK ("recovery_code_batch"."recovery_generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE "recovery_code_batch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recovery_code_rotation_fact" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" text NOT NULL,
	"generation" integer NOT NULL,
	"authorizing_session_id" text NOT NULL,
	"authorizing_passkey_id" text NOT NULL,
	"challenge_id" uuid NOT NULL,
	"prior_batch_id" uuid,
	"new_batch_id" uuid NOT NULL,
	"code_count" integer NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"correlation_id" uuid NOT NULL,
	CONSTRAINT "recovery_code_rotation_fact_generation" CHECK ("recovery_code_rotation_fact"."generation" >= 0),
	CONSTRAINT "recovery_code_rotation_fact_eight" CHECK ("recovery_code_rotation_fact"."code_count" = 8)
);
--> statement-breakpoint
ALTER TABLE "recovery_code_rotation_fact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recovery_attempt" ADD CONSTRAINT "recovery_attempt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_code" ADD CONSTRAINT "recovery_code_current_batch_fk" FOREIGN KEY ("user_id","batch_id") REFERENCES "public"."recovery_code_batch"("user_id","batch_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_code_batch" ADD CONSTRAINT "recovery_code_batch_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recovery_attempt_cleanup_idx" ON "recovery_attempt" USING btree ("user_id","expires_at","id");--> statement-breakpoint
CREATE POLICY "recovery_attempt_scope" ON "recovery_attempt" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000') WITH CHECK (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "recovery_code_scope" ON "recovery_code" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000') WITH CHECK (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "recovery_code_batch_scope" ON "recovery_code_batch" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000') WITH CHECK (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "recovery_code_rotation_fact_insert" ON "recovery_code_rotation_fact" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000');
--> statement-breakpoint
REVOKE ALL ON TABLE public.recovery_code_batch, public.recovery_code, public.recovery_attempt, public.recovery_code_rotation_fact FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.recovery_code_batch, public.recovery_code, public.recovery_attempt, public.recovery_code_rotation_fact FROM runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.recovery_code_batch, public.recovery_code, public.recovery_attempt TO runtime;
--> statement-breakpoint
GRANT INSERT ON TABLE public.recovery_code_rotation_fact TO runtime;
