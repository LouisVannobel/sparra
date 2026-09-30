CREATE TABLE "auth_email_command" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"purpose" text NOT NULL,
	"recipient" text NOT NULL,
	"locale" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"user_id" text,
	"recovery_generation" integer,
	CONSTRAINT "auth_email_command_request_generation_unique" UNIQUE("request_id","generation"),
	CONSTRAINT "auth_email_command_generation_positive" CHECK ("auth_email_command"."generation" > 0),
	CONSTRAINT "auth_email_command_purpose" CHECK ("auth_email_command"."purpose" = 'magic-link'),
	CONSTRAINT "auth_email_command_locale" CHECK ("auth_email_command"."locale" in ('fr','en')),
	CONSTRAINT "auth_email_command_expiry" CHECK ("auth_email_command"."expires_at" > "auth_email_command"."created_at" and "auth_email_command"."expires_at" <= "auth_email_command"."created_at" + interval '10 minutes'),
	CONSTRAINT "auth_email_command_user_binding" CHECK (("auth_email_command"."user_id" is null and "auth_email_command"."recovery_generation" is null) or ("auth_email_command"."user_id" is not null and "auth_email_command"."recovery_generation" is not null and "auth_email_command"."recovery_generation" >= 0))
);
--> statement-breakpoint
ALTER TABLE "auth_email_command" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth_email_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"delivery_id" uuid NOT NULL,
	CONSTRAINT "auth_email_outbox_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
ALTER TABLE "auth_email_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth_email_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"purpose" text NOT NULL,
	"generation" integer NOT NULL,
	"state" text NOT NULL,
	"user_id" text,
	CONSTRAINT "auth_email_request_email_purpose_unique" UNIQUE("email","purpose"),
	CONSTRAINT "auth_email_request_generation_positive" CHECK ("auth_email_request"."generation" > 0),
	CONSTRAINT "auth_email_request_purpose" CHECK ("auth_email_request"."purpose" = 'magic-link'),
	CONSTRAINT "auth_email_request_normalized" CHECK ("auth_email_request"."email" = lower(btrim("auth_email_request"."email"))),
	CONSTRAINT "auth_email_request_state" CHECK ("auth_email_request"."state" in ('active','consumed','terminal'))
);
--> statement-breakpoint
ALTER TABLE "auth_email_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "email_delivery" (
	"id" uuid PRIMARY KEY NOT NULL,
	"command_id" uuid NOT NULL,
	"state" text NOT NULL,
	"verifier_hash" text,
	"key_id" text NOT NULL,
	"ciphertext" text,
	"nonce" text,
	"tag" text,
	CONSTRAINT "email_delivery_command_id_unique" UNIQUE("command_id"),
	CONSTRAINT "email_delivery_state" CHECK ("email_delivery"."state" in ('active','consumed','terminal','superseded','expired')),
	CONSTRAINT "email_delivery_envelope" CHECK (("email_delivery"."ciphertext" is null and "email_delivery"."nonce" is null and "email_delivery"."tag" is null) or ("email_delivery"."ciphertext" is not null and "email_delivery"."nonce" is not null and "email_delivery"."tag" is not null and "email_delivery"."nonce" ~ '^[0-9a-f]{24}$' and "email_delivery"."tag" ~ '^[0-9a-f]{32}$'))
);
--> statement-breakpoint
ALTER TABLE "email_delivery" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_email_command" ADD CONSTRAINT "auth_email_command_request_id_auth_email_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."auth_email_request"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_email_command" ADD CONSTRAINT "auth_email_command_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_email_outbox" ADD CONSTRAINT "auth_email_outbox_delivery_id_email_delivery_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."email_delivery"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_email_request" ADD CONSTRAINT "auth_email_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_delivery" ADD CONSTRAINT "email_delivery_command_id_auth_email_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."auth_email_command"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "auth_email_command_scope" ON "auth_email_command" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000') WITH CHECK (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "auth_email_outbox_scope" ON "auth_email_outbox" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000') WITH CHECK (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "auth_email_request_scope" ON "auth_email_request" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000') WITH CHECK (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "email_delivery_scope" ON "email_delivery" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000') WITH CHECK (current_setting('app.tenant_id', true) = '00000000-0000-0000-0000-000000000000');
--> statement-breakpoint
-- Drizzle-generated tables/policies above; module invariants below require
-- native PostgreSQL triggers. No deployment role names or provider grants.
ALTER TABLE public.auth_email_request FORCE ROW LEVEL SECURITY;
ALTER TABLE public.auth_email_command FORCE ROW LEVEL SECURITY;
ALTER TABLE public.email_delivery FORCE ROW LEVEL SECURITY;
ALTER TABLE public.auth_email_outbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.auth_email_request, public.auth_email_command, public.email_delivery, public.auth_email_outbox FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.auth_email_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Auth email immutable record' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_email_immutable() FROM PUBLIC;
CREATE TRIGGER auth_email_command_immutable BEFORE UPDATE OR DELETE ON public.auth_email_command
FOR EACH ROW EXECUTE FUNCTION public.auth_email_immutable();
CREATE TRIGGER auth_email_outbox_immutable BEFORE UPDATE OR DELETE ON public.auth_email_outbox
FOR EACH ROW EXECUTE FUNCTION public.auth_email_immutable();
--> statement-breakpoint
CREATE FUNCTION public.auth_email_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Auth email request transition rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.email IS DISTINCT FROM OLD.email
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR (OLD.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id)
    OR NEW.generation < OLD.generation OR NEW.generation > OLD.generation + 1
    OR (NEW.generation = OLD.generation AND OLD.state <> 'active' AND NEW.state IS DISTINCT FROM OLD.state)
    OR (NEW.generation > OLD.generation AND NEW.state <> 'active') THEN
    RAISE EXCEPTION 'Auth email request transition rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_email_request_guard() FROM PUBLIC;
CREATE TRIGGER auth_email_request_guard BEFORE UPDATE OR DELETE ON public.auth_email_request
FOR EACH ROW EXECUTE FUNCTION public.auth_email_request_guard();
--> statement-breakpoint
CREATE FUNCTION public.auth_email_delivery_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Auth email delivery transition rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.command_id IS DISTINCT FROM OLD.command_id
    OR NEW.key_id IS DISTINCT FROM OLD.key_id
    OR (OLD.state <> 'active' AND NEW.state IS DISTINCT FROM OLD.state)
    OR (NEW.ciphertext IS NOT NULL AND NEW.ciphertext IS DISTINCT FROM OLD.ciphertext)
    OR (NEW.nonce IS NOT NULL AND NEW.nonce IS DISTINCT FROM OLD.nonce)
    OR (NEW.tag IS NOT NULL AND NEW.tag IS DISTINCT FROM OLD.tag)
    OR (NEW.verifier_hash IS NOT NULL AND NEW.verifier_hash IS DISTINCT FROM OLD.verifier_hash)
    OR (NEW.state <> 'active' AND (NEW.ciphertext IS NOT NULL OR NEW.nonce IS NOT NULL OR NEW.tag IS NOT NULL OR NEW.verifier_hash IS NOT NULL)) THEN
    RAISE EXCEPTION 'Auth email delivery transition rejected' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_email_delivery_guard() FROM PUBLIC;
CREATE TRIGGER auth_email_delivery_guard BEFORE UPDATE OR DELETE ON public.email_delivery
FOR EACH ROW EXECUTE FUNCTION public.auth_email_delivery_guard();
