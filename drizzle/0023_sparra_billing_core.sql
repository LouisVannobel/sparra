-- Sparra forward0023: frozen billing core, reconciliation and cancellation.
-- Historical consumer migrations through0022 remain immutable.
-- Checkout, reconciliation and cancellation supplements are embedded once.

CREATE TABLE "billing_customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"account_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"known_subscription_id" text,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "billing_customer_scope_unique" UNIQUE("workspace_id","environment","account_id"),
	CONSTRAINT "billing_customer_provider_unique" UNIQUE("environment","account_id","stripe_customer_id"),
	CONSTRAINT "billing_customer_checkout_ref" UNIQUE("workspace_id","environment","account_id","stripe_customer_id"),
	CONSTRAINT "billing_customer_environment" CHECK ("billing_customer"."environment" in ('sandbox','live')),
	CONSTRAINT "billing_customer_provider_id" CHECK ("billing_customer"."stripe_customer_id" ~ '^cus_[A-Za-z0-9]+$'),
	CONSTRAINT "billing_customer_subscription_id" CHECK ("billing_customer"."known_subscription_id" is null or "billing_customer"."known_subscription_id" ~ '^sub_[A-Za-z0-9]+$')
);
--> statement-breakpoint
ALTER TABLE "billing_customer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_operation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"phase" text DEFAULT 'ADMITTED' NOT NULL,
	"environment" text NOT NULL,
	"account_id" text NOT NULL,
	"api_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"customer_id" text,
	"monthly_price_id" text,
	"onboarding_price_id" text,
	"currency" text,
	"monthly_unit_amount" bigint,
	"onboarding_unit_amount" bigint,
	"integration_identifier" text,
	"stripe_object_id" text,
	"checkout_url" text,
	"checkout_expires_at" bigint,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "billing_operation_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "billing_operation_one_slot" UNIQUE("workspace_id","environment","account_id","kind"),
	CONSTRAINT "billing_operation_workspace_ref" UNIQUE("id","workspace_id"),
	CONSTRAINT "billing_operation_kind" CHECK ("billing_operation"."kind" in ('CUSTOMER_CREATE','CHECKOUT_CREATE')),
	CONSTRAINT "billing_operation_phase" CHECK ("billing_operation"."phase" in ('ADMITTED','DISPATCHING','SUCCEEDED','UNKNOWN')),
	CONSTRAINT "billing_operation_environment" CHECK ("billing_operation"."environment" in ('sandbox','live')),
	CONSTRAINT "billing_operation_api" CHECK ("billing_operation"."api_version" = '2026-09-30.endive'),
	CONSTRAINT "billing_operation_key" CHECK (length("billing_operation"."idempotency_key") between 1 and 255 and "billing_operation"."idempotency_key" ~ '^[A-Za-z0-9:_-]+$'),
	CONSTRAINT "billing_operation_hash" CHECK ("billing_operation"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "billing_operation_shape" CHECK ((
    "billing_operation"."kind"='CUSTOMER_CREATE' and "billing_operation"."customer_id" is null and "billing_operation"."monthly_price_id" is null
      and "billing_operation"."onboarding_price_id" is null and "billing_operation"."currency" is null and "billing_operation"."monthly_unit_amount" is null
      and "billing_operation"."onboarding_unit_amount" is null and "billing_operation"."integration_identifier" is null
    or "billing_operation"."kind"='CHECKOUT_CREATE' and "billing_operation"."customer_id" ~ '^cus_[A-Za-z0-9]+$'
      and "billing_operation"."monthly_price_id" ~ '^price_[A-Za-z0-9]+$' and "billing_operation"."currency" ~ '^[a-z]{3}$'
      and "billing_operation"."monthly_unit_amount" > 0 and ("billing_operation"."onboarding_price_id" is null and "billing_operation"."onboarding_unit_amount" is null
        or "billing_operation"."onboarding_price_id" ~ '^price_[A-Za-z0-9]+$' and "billing_operation"."onboarding_unit_amount" > 0)
      and "billing_operation"."integration_identifier" ~ '^[A-Za-z][A-Za-z0-9_-]*_[A-Za-z]{8}$'
  ) is true),
	CONSTRAINT "billing_operation_result" CHECK ((
    "billing_operation"."phase"='SUCCEEDED' and "billing_operation"."stripe_object_id" is not null
      and ("billing_operation"."kind"='CUSTOMER_CREATE' and "billing_operation"."stripe_object_id" ~ '^cus_[A-Za-z0-9]+$' and "billing_operation"."checkout_url" is null and "billing_operation"."checkout_expires_at" is null
        or "billing_operation"."kind"='CHECKOUT_CREATE' and "billing_operation"."stripe_object_id" ~ '^cs_(test|live)_[A-Za-z0-9]+$'
          and "billing_operation"."checkout_url" is not null and "billing_operation"."checkout_expires_at" > 0)
    or "billing_operation"."phase"<>'SUCCEEDED' and "billing_operation"."stripe_object_id" is null and "billing_operation"."checkout_url" is null and "billing_operation"."checkout_expires_at" is null
  ) is true)
);
--> statement-breakpoint
ALTER TABLE "billing_operation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_operation_outcome" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"stripe_object_id" text,
	"occurred_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "billing_outcome_one_phase" UNIQUE("operation_id","outcome"),
	CONSTRAINT "billing_outcome_kind" CHECK ("billing_operation_outcome"."outcome" in ('DISPATCHING','SUCCEEDED','UNKNOWN')),
	CONSTRAINT "billing_outcome_object" CHECK (("billing_operation_outcome"."outcome"='SUCCEEDED' and "billing_operation_outcome"."stripe_object_id" is not null) or ("billing_operation_outcome"."outcome"<>'SUCCEEDED' and "billing_operation_outcome"."stripe_object_id" is null))
);
--> statement-breakpoint
ALTER TABLE "billing_operation_outcome" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_customer" ADD CONSTRAINT "billing_customer_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_operation" ADD CONSTRAINT "billing_operation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_operation" ADD CONSTRAINT "billing_operation_customer_same_scope" FOREIGN KEY ("workspace_id","environment","account_id","customer_id") REFERENCES "public"."billing_customer"("workspace_id","environment","account_id","stripe_customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_operation_outcome" ADD CONSTRAINT "billing_outcome_operation_same_workspace" FOREIGN KEY ("operation_id","workspace_id") REFERENCES "public"."billing_operation"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "billing_customer_runtime_read" ON "billing_customer" AS PERMISSIVE FOR SELECT TO "runtime" USING ("billing_customer"."workspace_id"::text = current_setting('app.tenant_id', true));--> statement-breakpoint
CREATE POLICY "billing_customer_definer" ON "billing_customer" AS PERMISSIVE FOR ALL TO "workspace_bootstrap" USING ("billing_customer"."workspace_id"::text = current_setting('app.tenant_id', true)) WITH CHECK ("billing_customer"."workspace_id"::text = current_setting('app.tenant_id', true));--> statement-breakpoint
CREATE POLICY "billing_operation_runtime_read" ON "billing_operation" AS PERMISSIVE FOR SELECT TO "runtime" USING ("billing_operation"."workspace_id"::text = current_setting('app.tenant_id', true));--> statement-breakpoint
CREATE POLICY "billing_operation_definer" ON "billing_operation" AS PERMISSIVE FOR ALL TO "workspace_bootstrap" USING ("billing_operation"."workspace_id"::text = current_setting('app.tenant_id', true)) WITH CHECK ("billing_operation"."workspace_id"::text = current_setting('app.tenant_id', true));--> statement-breakpoint
CREATE POLICY "billing_outcome_runtime_read" ON "billing_operation_outcome" AS PERMISSIVE FOR SELECT TO "runtime" USING ("billing_operation_outcome"."workspace_id"::text = current_setting('app.tenant_id', true));--> statement-breakpoint
CREATE POLICY "billing_outcome_definer" ON "billing_operation_outcome" AS PERMISSIVE FOR ALL TO "workspace_bootstrap" USING ("billing_operation_outcome"."workspace_id"::text = current_setting('app.tenant_id', true)) WITH CHECK ("billing_operation_outcome"."workspace_id"::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
-- ROOT appends this supplement after the generated Task 2 tables in its new
-- unpublished migration. Existing migrations and live services are untouched.
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('workspace_owner','workspace_bootstrap')
    AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls
    AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r
      ON r.oid=m.roleid OR r.oid=m.member WHERE r.rolname IN ('workspace_owner','workspace_bootstrap')) THEN
    RAISE EXCEPTION 'Billing role prerequisites not satisfied';
  END IF;
END $$;
ALTER TABLE public.billing_customer OWNER TO workspace_owner;
ALTER TABLE public.billing_operation OWNER TO workspace_owner;
ALTER TABLE public.billing_operation_outcome OWNER TO workspace_owner;
ALTER TABLE public.billing_customer FORCE ROW LEVEL SECURITY;
ALTER TABLE public.billing_operation FORCE ROW LEVEL SECURITY;
ALTER TABLE public.billing_operation_outcome FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_customer,public.billing_operation,public.billing_operation_outcome FROM PUBLIC,runtime,workspace_bootstrap;
GRANT SELECT ON public.billing_customer,public.billing_operation,public.billing_operation_outcome TO runtime,workspace_bootstrap;
GRANT INSERT ON public.billing_customer,public.billing_operation,public.billing_operation_outcome TO workspace_bootstrap;
GRANT UPDATE(phase,stripe_object_id,checkout_url,checkout_expires_at,updated_at) ON public.billing_operation TO workspace_bootstrap;
GRANT SELECT(email_verified,hold_until) ON public."user" TO workspace_bootstrap;
GRANT SELECT(auth_method) ON public.session TO workspace_bootstrap;
--> statement-breakpoint
-- The function is private to the NOLOGIN definer. It saves/restores the tenant
-- GUC so auth rows remain subject to their existing sentinel RLS policy.
-- Every authority decision takes User -> Session -> Workspace locks and gets
-- fresh DB time only after all waits.
CREATE FUNCTION app_private.billing_authority(p_user text,p_session text,p_workspace uuid,p_allow_sentinel boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE original_tenant text; u record; s record; w record; now_at timestamptz; authorized boolean;
  has_user boolean := false; has_session boolean := false; has_workspace boolean := false;
BEGIN
  original_tenant := current_setting('app.tenant_id',true);
  IF p_user IS NULL OR p_user='' OR p_session IS NULL OR p_session='' OR p_workspace IS NULL
    OR p_workspace='00000000-0000-0000-0000-000000000000'::uuid
    OR current_setting('app.correlation_id',true) IS NULL
    OR current_setting('app.correlation_id',true) !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    OR (original_tenant IS DISTINCT FROM p_workspace::text
      AND (NOT p_allow_sentinel OR original_tenant IS DISTINCT FROM '00000000-0000-0000-0000-000000000000')) THEN RETURN false; END IF;
  PERFORM set_config('app.tenant_id','00000000-0000-0000-0000-000000000000',true);
  SELECT id,email_verified,recovering,recovery_generation,hold_until INTO u
    FROM public."user" WHERE id=p_user FOR UPDATE;
  has_user := FOUND;
  IF has_user THEN
    SELECT id,user_id,auth_state,auth_method,recovery_generation,expires_at,last_activity_at,authenticated_at INTO s
      FROM public.session WHERE id=p_session AND user_id=p_user FOR UPDATE;
    has_session := FOUND;
  END IF;
  IF has_session THEN
    SELECT id,owner_user_id,kind,lifecycle,auth_organization_id INTO w
      FROM public.workspace WHERE id=p_workspace FOR UPDATE;
    has_workspace := FOUND;
  END IF;
  now_at := clock_timestamp();
  IF has_user AND has_session AND has_workspace THEN
    authorized := coalesce(u.id=p_user AND u.email_verified AND NOT u.recovering
    AND (u.hold_until IS NULL OR u.hold_until<=now_at)
    AND s.id=p_session AND s.user_id=p_user AND s.auth_state='ACTIVE' AND s.auth_method='passkey'
    AND s.recovery_generation=u.recovery_generation
    AND s.expires_at>now_at AND s.last_activity_at<=now_at
    AND s.last_activity_at>now_at-interval '43200 seconds'
    AND s.authenticated_at<=now_at AND s.authenticated_at>now_at-interval '300 seconds'
    AND s.authenticated_at+interval '604800 seconds'>now_at
    AND w.id=p_workspace AND w.owner_user_id=p_user AND w.kind='personal'
    AND w.lifecycle='active' AND w.auth_organization_id IS NULL,false);
  ELSE authorized := false; END IF;
  PERFORM set_config('app.tenant_id',original_tenant,true);
  RETURN authorized;
END $$;
ALTER FUNCTION app_private.billing_authority(text,text,uuid,boolean) OWNER TO workspace_bootstrap;
REVOKE ALL ON FUNCTION app_private.billing_authority(text,text,uuid,boolean) FROM PUBLIC,runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.resolve_billing_workspace(p_user text,p_session text,p_workspace uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF current_setting('app.tenant_id',true) IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'
    OR NOT app_private.billing_authority(p_user,p_session,p_workspace,true) THEN RETURN NULL; END IF;
  RETURN p_workspace;
END $$;
ALTER FUNCTION app_private.resolve_billing_workspace(text,text,uuid) OWNER TO workspace_bootstrap;
REVOKE ALL ON FUNCTION app_private.resolve_billing_workspace(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.resolve_billing_workspace(text,text,uuid) TO runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.billing_admit_customer(p_user text,p_session text,p_workspace uuid,p_environment text,p_account text,
  p_api text,p_id uuid,p_key text,p_hash text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE existing_id uuid; inserted_id uuid;
BEGIN
  IF NOT app_private.billing_authority(p_user,p_session,p_workspace,false)
    OR p_environment NOT IN ('sandbox','live') OR p_account !~ '^acct_[A-Za-z0-9]+$'
    OR p_api <> '2026-09-30.endive' OR p_id IS NULL
    OR p_key !~ '^[A-Za-z0-9:_-]{1,255}$' OR p_hash !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.billing_customer WHERE workspace_id=p_workspace AND environment=p_environment AND account_id=p_account) THEN RETURN NULL; END IF;
  INSERT INTO public.billing_operation(id,workspace_id,kind,environment,account_id,api_version,idempotency_key,request_hash)
    VALUES(p_id,p_workspace,'CUSTOMER_CREATE',p_environment,p_account,p_api,p_key,p_hash)
    ON CONFLICT(workspace_id,environment,account_id,kind) DO NOTHING RETURNING id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN RETURN inserted_id; END IF;
  SELECT id INTO existing_id FROM public.billing_operation
    WHERE workspace_id=p_workspace AND environment=p_environment AND account_id=p_account AND kind='CUSTOMER_CREATE';
  RETURN existing_id;
END $$;
ALTER FUNCTION app_private.billing_admit_customer(text,text,uuid,text,text,text,uuid,text,text) OWNER TO workspace_bootstrap;
REVOKE ALL ON FUNCTION app_private.billing_admit_customer(text,text,uuid,text,text,text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.billing_admit_customer(text,text,uuid,text,text,text,uuid,text,text) TO runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.billing_admit_checkout(p_user text,p_session text,p_workspace uuid,p_environment text,p_account text,
  p_api text,p_id uuid,p_key text,p_hash text,p_customer text,p_monthly text,p_onboarding text,p_currency text,
  p_monthly_amount bigint,p_onboarding_amount bigint,p_integration text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE existing_id uuid; inserted_id uuid;
BEGIN
  IF NOT app_private.billing_authority(p_user,p_session,p_workspace,false)
    OR p_environment NOT IN ('sandbox','live') OR p_account !~ '^acct_[A-Za-z0-9]+$'
    OR p_api <> '2026-09-30.endive' OR p_id IS NULL OR p_key !~ '^[A-Za-z0-9:_-]{1,255}$'
    OR p_hash !~ '^[0-9a-f]{64}$' OR p_monthly !~ '^price_[A-Za-z0-9]+$'
    OR p_currency !~ '^[a-z]{3}$' OR p_monthly_amount<=0
    OR (p_onboarding IS NULL) IS DISTINCT FROM (p_onboarding_amount IS NULL)
    OR (p_onboarding IS NOT NULL AND (p_onboarding !~ '^price_[A-Za-z0-9]+$' OR p_onboarding_amount<=0))
    OR p_integration !~ '^[A-Za-z][A-Za-z0-9_-]*_[A-Za-z]{8}$' THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.billing_customer c WHERE c.workspace_id=p_workspace AND c.environment=p_environment
    AND c.account_id=p_account AND c.stripe_customer_id=p_customer AND c.known_subscription_id IS NULL) THEN RETURN NULL; END IF;
  INSERT INTO public.billing_operation(id,workspace_id,kind,environment,account_id,api_version,idempotency_key,request_hash,
    customer_id,monthly_price_id,onboarding_price_id,currency,monthly_unit_amount,onboarding_unit_amount,integration_identifier)
    VALUES(p_id,p_workspace,'CHECKOUT_CREATE',p_environment,p_account,p_api,p_key,p_hash,p_customer,p_monthly,p_onboarding,p_currency,
      p_monthly_amount,p_onboarding_amount,p_integration)
    ON CONFLICT(workspace_id,environment,account_id,kind) DO NOTHING RETURNING id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN RETURN inserted_id; END IF;
  SELECT id INTO existing_id FROM public.billing_operation
    WHERE workspace_id=p_workspace AND environment=p_environment AND account_id=p_account AND kind='CHECKOUT_CREATE';
  RETURN existing_id;
END $$;
ALTER FUNCTION app_private.billing_admit_checkout(text,text,uuid,text,text,text,uuid,text,text,text,text,text,text,bigint,bigint,text) OWNER TO workspace_bootstrap;
REVOKE ALL ON FUNCTION app_private.billing_admit_checkout(text,text,uuid,text,text,text,uuid,text,text,text,text,text,text,bigint,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.billing_admit_checkout(text,text,uuid,text,text,text,uuid,text,text,text,text,text,text,bigint,bigint,text) TO runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.billing_claim_operation(p_user text,p_session text,p_workspace uuid,p_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o public.billing_operation;
BEGIN
  IF NOT app_private.billing_authority(p_user,p_session,p_workspace,false) THEN RETURN false; END IF;
  SELECT * INTO o FROM public.billing_operation WHERE id=p_id AND workspace_id=p_workspace FOR UPDATE;
  IF o.id IS NULL OR o.phase<>'ADMITTED' THEN RETURN false; END IF;
  UPDATE public.billing_operation SET phase='DISPATCHING',updated_at=clock_timestamp() WHERE id=o.id;
  INSERT INTO public.billing_operation_outcome(operation_id,workspace_id,outcome) VALUES(o.id,p_workspace,'DISPATCHING');
  RETURN true;
END $$;
ALTER FUNCTION app_private.billing_claim_operation(text,text,uuid,uuid) OWNER TO workspace_bootstrap;
REVOKE ALL ON FUNCTION app_private.billing_claim_operation(text,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.billing_claim_operation(text,text,uuid,uuid) TO runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.billing_complete_customer(p_user text,p_session text,p_workspace uuid,p_id uuid,p_customer text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o public.billing_operation;
BEGIN
  IF NOT app_private.billing_authority(p_user,p_session,p_workspace,false) OR p_customer !~ '^cus_[A-Za-z0-9]+$' THEN RETURN false; END IF;
  SELECT * INTO o FROM public.billing_operation WHERE id=p_id AND workspace_id=p_workspace FOR UPDATE;
  IF o.id IS NULL OR o.kind<>'CUSTOMER_CREATE' OR o.phase<>'DISPATCHING' THEN RETURN false; END IF;
  INSERT INTO public.billing_customer(workspace_id,environment,account_id,stripe_customer_id)
    VALUES(p_workspace,o.environment,o.account_id,p_customer);
  UPDATE public.billing_operation SET phase='SUCCEEDED',stripe_object_id=p_customer,updated_at=clock_timestamp() WHERE id=o.id;
  INSERT INTO public.billing_operation_outcome(operation_id,workspace_id,outcome,stripe_object_id)
    VALUES(o.id,p_workspace,'SUCCEEDED',p_customer);
  RETURN true;
END $$;
ALTER FUNCTION app_private.billing_complete_customer(text,text,uuid,uuid,text) OWNER TO workspace_bootstrap;
REVOKE ALL ON FUNCTION app_private.billing_complete_customer(text,text,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.billing_complete_customer(text,text,uuid,uuid,text) TO runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.billing_complete_checkout(p_user text,p_session text,p_workspace uuid,p_id uuid,p_session_id text,p_url text,p_expires_at bigint) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o public.billing_operation;
BEGIN
  IF NOT app_private.billing_authority(p_user,p_session,p_workspace,false)
    OR p_session_id !~ '^cs_(test|live)_[A-Za-z0-9]+$'
    OR left(p_url,length('https://checkout.stripe.com/c/pay/'||p_session_id)) IS DISTINCT FROM 'https://checkout.stripe.com/c/pay/'||p_session_id
    OR substring(p_url from length('https://checkout.stripe.com/c/pay/'||p_session_id)+1 for 1) NOT IN ('','?','#') THEN RETURN false; END IF;
  SELECT * INTO o FROM public.billing_operation WHERE id=p_id AND workspace_id=p_workspace FOR UPDATE;
  IF o.id IS NULL OR o.kind<>'CHECKOUT_CREATE' OR o.phase<>'DISPATCHING'
    OR (o.environment='sandbox') IS DISTINCT FROM (p_session_id LIKE 'cs_test_%')
    OR p_expires_at IS NULL OR p_expires_at<=extract(epoch from clock_timestamp()) THEN RETURN false; END IF;
  UPDATE public.billing_operation SET phase='SUCCEEDED',stripe_object_id=p_session_id,checkout_url=p_url,
    checkout_expires_at=p_expires_at,updated_at=clock_timestamp() WHERE id=o.id;
  INSERT INTO public.billing_operation_outcome(operation_id,workspace_id,outcome,stripe_object_id)
    VALUES(o.id,p_workspace,'SUCCEEDED',p_session_id);
  RETURN true;
END $$;
ALTER FUNCTION app_private.billing_complete_checkout(text,text,uuid,uuid,text,text,bigint) OWNER TO workspace_bootstrap;
REVOKE ALL ON FUNCTION app_private.billing_complete_checkout(text,text,uuid,uuid,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.billing_complete_checkout(text,text,uuid,uuid,text,text,bigint) TO runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.billing_mark_unknown(p_user text,p_session text,p_workspace uuid,p_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o public.billing_operation;
BEGIN
  IF NOT app_private.billing_authority(p_user,p_session,p_workspace,false) THEN RETURN false; END IF;
  SELECT * INTO o FROM public.billing_operation WHERE id=p_id AND workspace_id=p_workspace FOR UPDATE;
  IF o.id IS NULL OR o.phase<>'DISPATCHING' THEN RETURN false; END IF;
  UPDATE public.billing_operation SET phase='UNKNOWN',updated_at=clock_timestamp() WHERE id=o.id;
  INSERT INTO public.billing_operation_outcome(operation_id,workspace_id,outcome) VALUES(o.id,p_workspace,'UNKNOWN');
  RETURN true;
END $$;
ALTER FUNCTION app_private.billing_mark_unknown(text,text,uuid,uuid) OWNER TO workspace_bootstrap;
REVOKE ALL ON FUNCTION app_private.billing_mark_unknown(text,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.billing_mark_unknown(text,text,uuid,uuid) TO runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.billing_operation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF ROW(NEW.id,NEW.workspace_id,NEW.kind,NEW.environment,NEW.account_id,NEW.api_version,NEW.idempotency_key,
      NEW.request_hash,NEW.customer_id,NEW.monthly_price_id,NEW.onboarding_price_id,NEW.currency,
      NEW.monthly_unit_amount,NEW.onboarding_unit_amount,NEW.integration_identifier,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.kind,OLD.environment,OLD.account_id,OLD.api_version,OLD.idempotency_key,
      OLD.request_hash,OLD.customer_id,OLD.monthly_price_id,OLD.onboarding_price_id,OLD.currency,
      OLD.monthly_unit_amount,OLD.onboarding_unit_amount,OLD.integration_identifier,OLD.created_at)
    OR NOT (OLD.phase='ADMITTED' AND NEW.phase='DISPATCHING'
      OR OLD.phase='DISPATCHING' AND NEW.phase IN ('SUCCEEDED','UNKNOWN')) THEN
    RAISE EXCEPTION 'Billing operation immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.billing_operation_guard() FROM PUBLIC;
CREATE TRIGGER billing_operation_guard BEFORE UPDATE ON public.billing_operation
  FOR EACH ROW EXECUTE FUNCTION app_private.billing_operation_guard();
--> statement-breakpoint
CREATE FUNCTION app_private.billing_outcome_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Billing outcome immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION app_private.billing_outcome_immutable() FROM PUBLIC;
CREATE TRIGGER billing_outcome_immutable BEFORE UPDATE OR DELETE ON public.billing_operation_outcome
  FOR EACH ROW EXECUTE FUNCTION app_private.billing_outcome_immutable();
--> statement-breakpoint
CREATE TABLE "billing_agreement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"account_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"period_start" bigint NOT NULL,
	"period_end" bigint NOT NULL,
	"proof" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "billing_agreement_period" UNIQUE("environment","account_id","subscription_id","period_start","period_end"),
	CONSTRAINT "billing_agreement_invoice" UNIQUE("environment","account_id","invoice_id"),
	CONSTRAINT "billing_agreement_pair" UNIQUE("id","workspace_id"),
	CONSTRAINT "billing_agreement_period_order" CHECK ("billing_agreement"."period_start">0 and "billing_agreement"."period_end">"billing_agreement"."period_start")
);
--> statement-breakpoint
ALTER TABLE "billing_agreement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_charge_binding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"account_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"charge_id" text NOT NULL,
	"payment_intent_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "billing_binding_edge" UNIQUE("environment","account_id","charge_id","payment_intent_id","invoice_id")
);
--> statement-breakpoint
ALTER TABLE "billing_charge_binding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_command" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"fence" bigint DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"manifest_revision" bigint DEFAULT 0 NOT NULL,
	"target_progress" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"identities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "billing_command_receipt_id_unique" UNIQUE("receipt_id"),
	CONSTRAINT "billing_command_pair" UNIQUE("id","workspace_id"),
	CONSTRAINT "billing_command_progress_bound" CHECK (jsonb_typeof("billing_command"."target_progress")='array' and jsonb_array_length("billing_command"."target_progress")<=500 and jsonb_typeof("billing_command"."identities")='object'),
	CONSTRAINT "billing_command_fences" CHECK ("billing_command"."fence">=0 and "billing_command"."manifest_revision">=0)
);
--> statement-breakpoint
ALTER TABLE "billing_command" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_current_agreement" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"agreement_id" uuid NOT NULL,
	"version" bigint NOT NULL,
	"held_at" timestamp with time zone,
	CONSTRAINT "billing_current_version" CHECK ("billing_current_agreement"."version">0)
);
--> statement-breakpoint
ALTER TABLE "billing_current_agreement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_event_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" text NOT NULL,
	"account_id" text NOT NULL,
	"event_id" text NOT NULL,
	"projection" jsonb NOT NULL,
	"projection_hash" text NOT NULL,
	"charge_id" text,
	"risk_id" text,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "billing_receipt_identity" UNIQUE("environment","account_id","event_id"),
	CONSTRAINT "billing_receipt_scope" CHECK ("billing_event_receipt"."environment" in ('sandbox','live') and "billing_event_receipt"."account_id" ~ '^acct_[A-Za-z0-9]+$'),
	CONSTRAINT "billing_receipt_hash" CHECK ("billing_event_receipt"."projection_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "billing_event_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"admission_state" text DEFAULT 'ready' NOT NULL,
	"admission_fence" bigint DEFAULT 0 NOT NULL,
	"admission_lease_until" timestamp with time zone,
	"run_id" uuid,
	"terminal_disposition" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "billing_outbox_command_id_unique" UNIQUE("command_id"),
	CONSTRAINT "billing_outbox_state" CHECK ("billing_outbox"."admission_state" in ('ready','dispatching','unknown','admitted','retired')),
	CONSTRAINT "billing_outbox_terminal" CHECK (("billing_outbox"."admission_state"='retired')=("billing_outbox"."terminal_disposition" is not null) and ("billing_outbox"."admission_state"<>'retired' or "billing_outbox"."run_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "billing_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_receipt_assignment" (
	"receipt_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "billing_assignment_pair" UNIQUE("receipt_id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "billing_receipt_assignment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_risk_observation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"account_id" text NOT NULL,
	"charge_id" text NOT NULL,
	"facts" jsonb NOT NULL,
	"facts_hash" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "billing_risk_fact_identity" UNIQUE("environment","account_id","charge_id","facts_hash")
);
--> statement-breakpoint
ALTER TABLE "billing_risk_observation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_operation" ADD COLUMN "checkout_reference_version" text DEFAULT 'legacy-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_operation" ADD CONSTRAINT "billing_operation_graph_ref" UNIQUE("id","workspace_id","environment","account_id","customer_id");--> statement-breakpoint
ALTER TABLE "billing_agreement" ADD CONSTRAINT "billing_agreement_operation_pair" FOREIGN KEY ("operation_id","workspace_id") REFERENCES "public"."billing_operation"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_charge_binding" ADD CONSTRAINT "billing_binding_operation_pair" FOREIGN KEY ("operation_id","workspace_id") REFERENCES "public"."billing_operation"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_charge_binding" ADD CONSTRAINT "billing_binding_operation_scope" FOREIGN KEY ("operation_id","workspace_id","environment","account_id","customer_id") REFERENCES "public"."billing_operation"("id","workspace_id","environment","account_id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_command" ADD CONSTRAINT "billing_command_assignment_pair" FOREIGN KEY ("receipt_id","workspace_id") REFERENCES "public"."billing_receipt_assignment"("receipt_id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_command" ADD CONSTRAINT "billing_command_operation_pair" FOREIGN KEY ("operation_id","workspace_id") REFERENCES "public"."billing_operation"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_current_agreement" ADD CONSTRAINT "billing_current_agreement_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_current_agreement" ADD CONSTRAINT "billing_current_same_workspace" FOREIGN KEY ("agreement_id","workspace_id") REFERENCES "public"."billing_agreement"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_outbox" ADD CONSTRAINT "billing_outbox_command_pair" FOREIGN KEY ("command_id","workspace_id") REFERENCES "public"."billing_command"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_receipt_assignment" ADD CONSTRAINT "billing_receipt_assignment_receipt_id_billing_event_receipt_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."billing_event_receipt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_receipt_assignment" ADD CONSTRAINT "billing_receipt_assignment_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_risk_observation" ADD CONSTRAINT "billing_risk_observation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_agreement_workspace" ON "billing_agreement" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "billing_binding_invoice" ON "billing_charge_binding" USING btree ("environment","account_id","invoice_id");--> statement-breakpoint
CREATE INDEX "billing_binding_pi" ON "billing_charge_binding" USING btree ("environment","account_id","payment_intent_id");--> statement-breakpoint
CREATE INDEX "billing_binding_operation" ON "billing_charge_binding" USING btree ("operation_id","workspace_id");--> statement-breakpoint
CREATE INDEX "billing_command_operation" ON "billing_command" USING btree ("operation_id","workspace_id");--> statement-breakpoint
CREATE INDEX "billing_command_pending" ON "billing_command" USING btree ("completed_at","created_at");--> statement-breakpoint
CREATE INDEX "billing_command_identity_lookup" ON "billing_command" USING gin ("identities");--> statement-breakpoint
CREATE INDEX "billing_receipt_charge" ON "billing_event_receipt" USING btree ("environment","account_id","charge_id");--> statement-breakpoint
CREATE INDEX "billing_outbox_admission" ON "billing_outbox" USING btree ("admission_state","admission_lease_until","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_one_native_run" ON "billing_outbox" USING btree ((true)) WHERE "billing_outbox"."admission_state" in ('dispatching','unknown','admitted');--> statement-breakpoint
CREATE INDEX "billing_assignment_workspace" ON "billing_receipt_assignment" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "billing_risk_workspace" ON "billing_risk_observation" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customer_subscription_scope" ON "billing_customer" USING btree ("environment","account_id","known_subscription_id") WHERE "billing_customer"."known_subscription_id" is not null;--> statement-breakpoint
ALTER TABLE "billing_operation" ADD CONSTRAINT "billing_reference_version" CHECK ("billing_operation"."checkout_reference_version" in ('legacy-v1','operation-v2'));--> statement-breakpoint
CREATE POLICY "billing_agreement_runtime_read" ON "billing_agreement" AS PERMISSIVE FOR SELECT TO "runtime" USING ("billing_agreement"."workspace_id"::text = current_setting('app.tenant_id', true));--> statement-breakpoint
CREATE POLICY "billing_current_runtime_read" ON "billing_current_agreement" AS PERMISSIVE FOR SELECT TO "runtime" USING ("billing_current_agreement"."workspace_id"::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
-- BEGIN billing reconciliation forward supplement (0019)
-- ROOT appends only this forward delta after the generated schema delta.
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname='billing_owner') THEN
    CREATE ROLE billing_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname='billing_definer') THEN
    CREATE ROLE billing_definer NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname='billing_relay') THEN
    CREATE ROLE billing_relay LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname='billing_worker') THEN
    CREATE ROLE billing_worker LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('billing_owner','billing_definer','billing_relay','billing_worker')
    AND rolcanlogin=(rolname IN ('billing_relay','billing_worker')) AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls
    AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication)<>4
    OR EXISTS(SELECT FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid OR r.oid=m.member
      WHERE r.rolname IN ('billing_owner','billing_definer','billing_relay','billing_worker')) THEN
    RAISE EXCEPTION 'Billing role prerequisites rejected';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public,app_private TO billing_definer,billing_relay,billing_worker;
ALTER TABLE public.billing_event_receipt OWNER TO billing_owner;
ALTER TABLE public.billing_receipt_assignment OWNER TO billing_owner;
ALTER TABLE public.billing_command OWNER TO billing_owner;
ALTER TABLE public.billing_outbox OWNER TO billing_owner;
ALTER TABLE public.billing_charge_binding OWNER TO billing_owner;
ALTER TABLE public.billing_risk_observation OWNER TO billing_owner;
ALTER TABLE public.billing_agreement OWNER TO billing_owner;
ALTER TABLE public.billing_current_agreement OWNER TO billing_owner;
ALTER TABLE public.billing_event_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE public.billing_receipt_assignment FORCE ROW LEVEL SECURITY;
ALTER TABLE public.billing_command FORCE ROW LEVEL SECURITY;
ALTER TABLE public.billing_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE public.billing_charge_binding FORCE ROW LEVEL SECURITY;
ALTER TABLE public.billing_risk_observation FORCE ROW LEVEL SECURITY;
ALTER TABLE public.billing_agreement FORCE ROW LEVEL SECURITY;
ALTER TABLE public.billing_current_agreement FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_event_receipt,public.billing_receipt_assignment,public.billing_command,public.billing_outbox,
 public.billing_charge_binding,public.billing_risk_observation,public.billing_agreement,public.billing_current_agreement
 FROM PUBLIC,runtime,billing_relay,billing_worker,auth_mail_relay,auth_mail_worker,billing_definer;
GRANT SELECT,INSERT ON public.billing_event_receipt,public.billing_receipt_assignment,public.billing_command,public.billing_outbox,
 public.billing_charge_binding,public.billing_risk_observation,public.billing_agreement,public.billing_current_agreement TO billing_definer;
GRANT UPDATE(fence,lease_until,manifest_revision,target_progress,identities,completed_at) ON public.billing_command TO billing_definer;
GRANT UPDATE(admission_state,admission_fence,admission_lease_until,run_id,terminal_disposition) ON public.billing_outbox TO billing_definer;
GRANT UPDATE(agreement_id,version,held_at) ON public.billing_current_agreement TO billing_definer;
GRANT SELECT ON public.billing_agreement,public.billing_current_agreement TO runtime;
CREATE POLICY billing_receipt_definer ON public.billing_event_receipt TO billing_definer USING(true) WITH CHECK(true);
CREATE POLICY billing_assignment_definer ON public.billing_receipt_assignment TO billing_definer USING(true) WITH CHECK(true);
CREATE POLICY billing_command_definer ON public.billing_command TO billing_definer USING(true) WITH CHECK(true);
CREATE POLICY billing_outbox_definer ON public.billing_outbox TO billing_definer USING(true) WITH CHECK(true);
CREATE POLICY billing_binding_definer ON public.billing_charge_binding TO billing_definer USING(true) WITH CHECK(true);
CREATE POLICY billing_risk_definer ON public.billing_risk_observation TO billing_definer USING(true) WITH CHECK(true);
CREATE POLICY billing_agreement_definer ON public.billing_agreement TO billing_definer USING(true) WITH CHECK(true);
CREATE POLICY billing_current_definer ON public.billing_current_agreement TO billing_definer USING(true) WITH CHECK(true);
GRANT SELECT ON public.billing_customer,public.billing_operation TO billing_definer;
GRANT UPDATE(known_subscription_id) ON public.billing_customer TO billing_definer;
CREATE POLICY billing_customer_reconcile ON public.billing_customer TO billing_definer USING(true) WITH CHECK(true);
CREATE POLICY billing_operation_reconcile ON public.billing_operation FOR SELECT TO billing_definer USING(true);
GRANT SELECT(id,email_verified,recovering,hold_until) ON public."user" TO billing_definer;
GRANT UPDATE(id) ON public."user" TO billing_definer;
GRANT SELECT(id,owner_user_id,kind,lifecycle,auth_organization_id) ON public.workspace TO billing_definer;
GRANT UPDATE(id) ON public.workspace TO billing_definer;
CREATE POLICY billing_user_reconcile ON public."user" TO billing_definer USING(true) WITH CHECK(true);
CREATE POLICY billing_workspace_reconcile ON public.workspace TO billing_definer USING(true) WITH CHECK(true);
--> statement-breakpoint
CREATE FUNCTION app_private.billing_json_keys(p jsonb,k text[]) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p)='object' THEN
   (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(p) x)=(SELECT array_agg(x ORDER BY x) FROM unnest(k) x)
 ELSE false END
$$;
CREATE FUNCTION app_private.billing_json_array(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p)='array' THEN jsonb_array_length(p)<=500 ELSE false END
$$;
CREATE FUNCTION app_private.billing_uint(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p)='number' AND p::text ~ '^(0|[1-9][0-9]{0,15})$' THEN (p::text)::numeric<=9007199254740991 ELSE false END
$$;
CREATE FUNCTION app_private.billing_string_ids(p jsonb,pattern text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT coalesce(app_private.billing_json_array(p),false) THEN RETURN false; END IF;
 RETURN NOT EXISTS(SELECT FROM jsonb_array_elements(p) v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}')>255 OR (v#>>'{}')!~pattern)
   AND (SELECT count(*) FROM jsonb_array_elements(p))=(SELECT count(DISTINCT v) FROM jsonb_array_elements(p) v);
END $$;
CREATE FUNCTION app_private.billing_lock_charges(e text,a text,ids text[]) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE ch text;
BEGIN
 FOR ch IN SELECT DISTINCT x FROM unnest(ids) x WHERE x IS NOT NULL ORDER BY x LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended(e||':'||a||':'||ch,4932));
 END LOOP;
END $$;
CREATE FUNCTION app_private.billing_lock_workspace(w uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE initial_owner text; u record; current_workspace record;
BEGIN
 SELECT owner_user_id INTO initial_owner FROM public.workspace WHERE id=w;
 IF initial_owner IS NULL THEN RAISE EXCEPTION 'Billing owner unavailable'; END IF;
 SELECT id,email_verified,recovering,hold_until INTO u FROM public."user" WHERE id=initial_owner FOR UPDATE;
 SELECT id,owner_user_id,kind,lifecycle,auth_organization_id INTO current_workspace FROM public.workspace WHERE id=w FOR UPDATE;
 IF u.id IS NULL OR current_workspace.owner_user_id IS DISTINCT FROM initial_owner OR current_workspace.kind<>'personal'
   OR current_workspace.auth_organization_id IS NOT NULL THEN RAISE EXCEPTION 'Billing owner changed'; END IF;
 RETURN u.email_verified AND NOT u.recovering AND (u.hold_until IS NULL OR u.hold_until<=clock_timestamp()) AND current_workspace.lifecycle='active';
END $$;
CREATE FUNCTION app_private.billing_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Billing fact immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER billing_receipt_immutable BEFORE UPDATE OR DELETE ON public.billing_event_receipt FOR EACH ROW EXECUTE FUNCTION app_private.billing_immutable();
CREATE TRIGGER billing_assignment_immutable BEFORE UPDATE OR DELETE ON public.billing_receipt_assignment FOR EACH ROW EXECUTE FUNCTION app_private.billing_immutable();
CREATE TRIGGER billing_binding_immutable BEFORE UPDATE OR DELETE ON public.billing_charge_binding FOR EACH ROW EXECUTE FUNCTION app_private.billing_immutable();
CREATE TRIGGER billing_risk_immutable BEFORE UPDATE OR DELETE ON public.billing_risk_observation FOR EACH ROW EXECUTE FUNCTION app_private.billing_immutable();
CREATE TRIGGER billing_agreement_immutable BEFORE UPDATE OR DELETE ON public.billing_agreement FOR EACH ROW EXECUTE FUNCTION app_private.billing_immutable();
CREATE FUNCTION app_private.billing_binding_insert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM app_private.billing_lock_charges(NEW.environment,NEW.account_id,ARRAY[NEW.charge_id]);
 IF NEW.environment NOT IN ('sandbox','live') OR NEW.account_id!~'^acct_[A-Za-z0-9]+$'
  OR NEW.charge_id!~'^ch_[A-Za-z0-9]+$' OR NEW.payment_intent_id!~'^pi_[A-Za-z0-9]+$' OR NEW.invoice_id!~'^in_[A-Za-z0-9]+$'
  OR EXISTS(SELECT FROM public.billing_charge_binding b WHERE b.environment=NEW.environment AND b.account_id=NEW.account_id
    AND (b.charge_id=NEW.charge_id AND ROW(b.workspace_id,b.operation_id,b.payment_intent_id,b.customer_id,b.subscription_id)
      IS DISTINCT FROM ROW(NEW.workspace_id,NEW.operation_id,NEW.payment_intent_id,NEW.customer_id,NEW.subscription_id)
      OR b.invoice_id=NEW.invoice_id AND ROW(b.workspace_id,b.operation_id,b.customer_id,b.subscription_id)
      IS DISTINCT FROM ROW(NEW.workspace_id,NEW.operation_id,NEW.customer_id,NEW.subscription_id))) THEN
    RAISE EXCEPTION 'Billing graph contradiction' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_binding_insert_guard BEFORE INSERT ON public.billing_charge_binding FOR EACH ROW EXECUTE FUNCTION app_private.billing_binding_insert_guard();
--> statement-breakpoint
CREATE FUNCTION app_private.billing_admit_checkout_v2(p_user text,p_session text,p_workspace uuid,p_environment text,p_account text,
 p_api text,p_id uuid,p_key text,p_hash text,p_customer text,p_monthly text,p_onboarding text,p_currency text,
 p_monthly_amount bigint,p_onboarding_amount bigint,p_integration text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE admitted uuid;
BEGIN
 IF NOT app_private.billing_authority(p_user,p_session,p_workspace,false)
  OR p_environment NOT IN ('sandbox','live') OR p_account!~'^acct_[A-Za-z0-9]+$' OR p_api<>'2026-09-30.endive'
  OR p_id IS NULL OR p_key IS DISTINCT FROM 'checkout:'||p_id::text OR p_hash!~'^[0-9a-f]{64}$'
  OR p_monthly!~'^price_[A-Za-z0-9]+$' OR p_currency!~'^[a-z]{3}$' OR p_monthly_amount<=0
  OR (p_onboarding IS NULL) IS DISTINCT FROM (p_onboarding_amount IS NULL)
  OR (p_onboarding IS NOT NULL AND (p_onboarding!~'^price_[A-Za-z0-9]+$' OR p_onboarding_amount<=0))
  OR p_integration!~'^[A-Za-z][A-Za-z0-9_-]*_[A-Za-z]{8}$' THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT FROM public.billing_customer WHERE workspace_id=p_workspace AND environment=p_environment
  AND account_id=p_account AND stripe_customer_id=p_customer AND known_subscription_id IS NULL) THEN RETURN NULL; END IF;
 INSERT INTO public.billing_operation(id,workspace_id,kind,environment,account_id,api_version,idempotency_key,request_hash,
  customer_id,monthly_price_id,onboarding_price_id,currency,monthly_unit_amount,onboarding_unit_amount,integration_identifier,checkout_reference_version)
 VALUES(p_id,p_workspace,'CHECKOUT_CREATE',p_environment,p_account,p_api,p_key,p_hash,p_customer,p_monthly,p_onboarding,p_currency,
  p_monthly_amount,p_onboarding_amount,p_integration,'operation-v2') ON CONFLICT(workspace_id,environment,account_id,kind) DO NOTHING RETURNING id INTO admitted;
 IF admitted IS NULL THEN SELECT id INTO admitted FROM public.billing_operation WHERE workspace_id=p_workspace
   AND environment=p_environment AND account_id=p_account AND kind='CHECKOUT_CREATE'; END IF;
 RETURN admitted;
END $$;
ALTER FUNCTION app_private.billing_admit_checkout_v2(text,text,uuid,text,text,text,uuid,text,text,text,text,text,text,bigint,bigint,text) OWNER TO workspace_bootstrap;
REVOKE ALL ON FUNCTION app_private.billing_admit_checkout(text,text,uuid,text,text,text,uuid,text,text,text,text,text,text,bigint,bigint,text) FROM runtime;
REVOKE ALL ON FUNCTION app_private.billing_admit_checkout_v2(text,text,uuid,text,text,text,uuid,text,text,text,text,text,text,bigint,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.billing_admit_checkout_v2(text,text,uuid,text,text,text,uuid,text,text,text,text,text,text,bigint,bigint,text) TO runtime;
CREATE FUNCTION app_private.billing_reference_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN IF NEW.checkout_reference_version IS DISTINCT FROM OLD.checkout_reference_version THEN RAISE EXCEPTION 'Checkout reference immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER billing_reference_immutable BEFORE UPDATE ON public.billing_operation FOR EACH ROW EXECUTE FUNCTION app_private.billing_reference_immutable();
--> statement-breakpoint
CREATE FUNCTION app_private.billing_associate_receipt(r uuid,w uuid,op uuid) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE cmd uuid; assigned uuid;
BEGIN
 SELECT workspace_id INTO assigned FROM public.billing_receipt_assignment WHERE receipt_id=r;
 IF assigned IS NOT NULL AND assigned<>w THEN RAISE EXCEPTION 'Billing receipt ownership conflict'; END IF;
 INSERT INTO public.billing_receipt_assignment(receipt_id,workspace_id) VALUES(r,w) ON CONFLICT DO NOTHING;
 INSERT INTO public.billing_command(receipt_id,workspace_id,operation_id) VALUES(r,w,op) ON CONFLICT(receipt_id) DO NOTHING;
 SELECT id INTO cmd FROM public.billing_command WHERE receipt_id=r AND workspace_id=w AND operation_id=op;
 IF cmd IS NULL THEN RAISE EXCEPTION 'Billing command ownership conflict'; END IF;
 INSERT INTO public.billing_outbox(command_id,workspace_id) VALUES(cmd,w) ON CONFLICT(command_id) DO NOTHING;
END $$;
CREATE FUNCTION app_private.billing_revise_risk(e text,a text,ch text) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE c record; t jsonb; next_targets jsonb; changed boolean;
BEGIN
 FOR c IN SELECT x.* FROM public.billing_command x WHERE x.completed_at IS NULL AND EXISTS(
   SELECT FROM public.billing_charge_binding b WHERE b.environment=e AND b.account_id=a AND b.charge_id=ch
   AND b.workspace_id=x.workspace_id AND x.identities ? b.invoice_id) ORDER BY x.id FOR UPDATE LOOP
  next_targets:='[]'; changed:=false;
  FOR t IN SELECT value FROM jsonb_array_elements(c.target_progress) LOOP
   IF EXISTS(SELECT FROM public.billing_charge_binding b WHERE b.environment=e AND b.account_id=a AND b.charge_id=ch
       AND b.workspace_id=c.workspace_id AND b.invoice_id=t->>'invoiceId') THEN
    t:=t||jsonb_build_object('requiresRisk',true,'requiredWorkRevision',(t->>'requiredWorkRevision')::bigint+1); changed:=true;
   END IF;
   next_targets:=next_targets||jsonb_build_array(t);
  END LOOP;
  IF changed THEN UPDATE public.billing_command SET target_progress=next_targets,manifest_revision=manifest_revision+1 WHERE id=c.id; END IF;
 END LOOP;
 UPDATE public.billing_current_agreement current SET held_at=coalesce(held_at,clock_timestamp())
  FROM public.billing_agreement agreement WHERE agreement.id=current.agreement_id AND EXISTS(
   SELECT FROM public.billing_charge_binding b WHERE b.environment=e AND b.account_id=a AND b.charge_id=ch
    AND b.workspace_id=agreement.workspace_id AND b.subscription_id=agreement.subscription_id);
END $$;
CREATE FUNCTION app_private.billing_receive_event(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE refs jsonb; event_kind text; pattern text; charge text; risk boolean; receipt public.billing_event_receipt; target uuid;
 op uuid; candidates uuid[]; current_candidate uuid; inserted uuid; e text; a text;
BEGIN
 IF NOT coalesce(app_private.billing_json_keys(p,ARRAY['id','type','created','objectId','objectType','projectionVersion','environment','accountId','references']),false)
  OR NOT coalesce(app_private.billing_json_keys(p->'references',ARRAY['customerId','subscriptionId','paymentIntentId','chargeId','riskId']),false)
  OR EXISTS(SELECT FROM unnest(ARRAY['id','type','objectId','objectType','environment','accountId']) k WHERE jsonb_typeof(p->k)<>'string')
  OR p->>'id'!~'^evt_[A-Za-z0-9]+$' OR length(p->>'id')>255 OR p->'projectionVersion'<>'1'::jsonb
  OR NOT app_private.billing_uint(p->'created') OR p->>'environment' NOT IN ('sandbox','live')
  OR p->>'accountId'!~'^acct_[A-Za-z0-9]+$' OR length(p->>'accountId')>255 THEN RAISE EXCEPTION 'Billing receipt rejected'; END IF;
 event_kind:=CASE p->>'type' WHEN 'checkout.session.completed' THEN 'checkout.session' WHEN 'checkout.session.async_payment_succeeded' THEN 'checkout.session'
 WHEN 'checkout.session.async_payment_failed' THEN 'checkout.session' WHEN 'customer.subscription.created' THEN 'subscription'
 WHEN 'customer.subscription.updated' THEN 'subscription' WHEN 'customer.subscription.deleted' THEN 'subscription'
 WHEN 'invoice.paid' THEN 'invoice' WHEN 'invoice.payment_failed' THEN 'invoice' WHEN 'charge.refunded' THEN 'charge'
 WHEN 'charge.dispute.created' THEN 'dispute' WHEN 'charge.dispute.updated' THEN 'dispute' WHEN 'charge.dispute.closed' THEN 'dispute'
 WHEN 'radar.early_fraud_warning.created' THEN 'radar.early_fraud_warning' END;
 pattern:=CASE event_kind WHEN 'checkout.session' THEN '^cs_(test|live)_[A-Za-z0-9]+$' WHEN 'subscription' THEN '^sub_[A-Za-z0-9]+$'
 WHEN 'invoice' THEN '^in_[A-Za-z0-9]+$' WHEN 'charge' THEN '^ch_[A-Za-z0-9]+$' WHEN 'dispute' THEN '^dp_[A-Za-z0-9]+$' ELSE '^issfr_[A-Za-z0-9]+$' END;
 refs:=p->'references'; e:=p->>'environment'; a:=p->>'accountId'; charge:=refs->>'chargeId'; risk:=event_kind IN ('charge','dispute','radar.early_fraud_warning');
 IF event_kind IS NULL OR p->>'objectType' IS DISTINCT FROM event_kind OR (p->>'objectId')!~pattern OR length(p->>'objectId')>255
 OR EXISTS(SELECT FROM jsonb_each(refs) v WHERE v.value<>'null'::jsonb AND (jsonb_typeof(v.value)<>'string' OR length(v.value#>>'{}')>255
  OR (v.value#>>'{}')!~CASE v.key WHEN 'customerId' THEN '^cus_[A-Za-z0-9]+$' WHEN 'subscriptionId' THEN '^sub_[A-Za-z0-9]+$'
   WHEN 'paymentIntentId' THEN '^pi_[A-Za-z0-9]+$' WHEN 'chargeId' THEN '^ch_[A-Za-z0-9]+$' ELSE '^(dp|issfr)_[A-Za-z0-9]+$' END))
 OR risk AND charge IS NULL OR event_kind='charge' AND charge IS DISTINCT FROM p->>'objectId'
 OR event_kind IN ('dispute','radar.early_fraud_warning') AND refs->>'riskId' IS DISTINCT FROM p->>'objectId'
 OR event_kind IN ('dispute','radar.early_fraud_warning') AND (refs->>'customerId' IS NOT NULL OR refs->>'subscriptionId' IS NOT NULL)
 OR event_kind IN ('invoice','subscription') AND (charge IS NOT NULL OR refs->>'paymentIntentId' IS NOT NULL OR refs->>'riskId' IS NOT NULL)
 OR event_kind IN ('checkout.session','charge') AND refs->>'riskId' IS NOT NULL
 OR event_kind='checkout.session' AND (charge IS NOT NULL OR e='sandbox' AND p->>'objectId' !~'^cs_test_' OR e='live' AND p->>'objectId' !~'^cs_live_')
 OR event_kind='subscription' AND refs->>'subscriptionId' IS DISTINCT FROM p->>'objectId' THEN RAISE EXCEPTION 'Billing event projection rejected'; END IF;
 PERFORM app_private.billing_lock_charges(e,a,ARRAY[charge]);
 PERFORM pg_advisory_xact_lock(hashtextextended(e||':'||a||':'||(p->>'id'),7812));
 IF refs->>'riskId' IS NOT NULL AND EXISTS(SELECT FROM public.billing_event_receipt r WHERE r.environment=e AND r.account_id=a
   AND r.risk_id=refs->>'riskId' AND r.charge_id IS DISTINCT FROM charge) THEN RAISE EXCEPTION 'Billing risk identity changed Charge'; END IF;
 SELECT * INTO receipt FROM public.billing_event_receipt WHERE environment=e AND account_id=a AND event_id=p->>'id';
 IF receipt.id IS NOT NULL AND receipt.projection IS DISTINCT FROM p THEN RAISE EXCEPTION 'Billing event drift'; END IF;
 SELECT array_agg(DISTINCT w) INTO candidates FROM (
  SELECT workspace_id w FROM public.billing_customer WHERE environment=e AND account_id=a AND
   (stripe_customer_id=refs->>'customerId' OR known_subscription_id=refs->>'subscriptionId')
  UNION SELECT workspace_id FROM public.billing_charge_binding WHERE environment=e AND account_id=a AND
   (charge_id=charge OR payment_intent_id=refs->>'paymentIntentId' OR event_kind='invoice' AND invoice_id=p->>'objectId')
  UNION SELECT workspace_id FROM public.billing_operation WHERE environment=e AND account_id=a AND event_kind='checkout.session' AND stripe_object_id=p->>'objectId'
 ) mappings;
 IF cardinality(candidates)>1 THEN RAISE EXCEPTION 'Billing mappings disagree'; END IF;
 target:=candidates[1];
 IF receipt.id IS NOT NULL THEN
  SELECT workspace_id INTO current_candidate FROM public.billing_receipt_assignment WHERE receipt_id=receipt.id;
  IF current_candidate IS NOT NULL THEN
   IF target IS NOT NULL AND current_candidate<>target THEN RAISE EXCEPTION 'Billing receipt mapping changed'; END IF;
   IF EXISTS(SELECT FROM public.billing_command c JOIN public.billing_outbox o ON o.command_id=c.id AND o.workspace_id=c.workspace_id
      WHERE c.receipt_id=receipt.id AND c.workspace_id=current_candidate) THEN RETURN jsonb_build_object('status','duplicate'); END IF;
   RAISE EXCEPTION 'Billing handoff incomplete';
  END IF;
 END IF;
 IF target IS NULL AND NOT risk THEN RAISE EXCEPTION 'Billing mapping unavailable'; END IF;
 IF target IS NOT NULL THEN
  PERFORM app_private.billing_lock_workspace(target);
  -- Re-read all resolvable references after the User/Workspace wait. Missing
  -- references cannot excuse a contradiction with a retained known edge.
  IF EXISTS(SELECT FROM public.billing_customer b WHERE b.environment=e AND b.account_id=a AND
    (b.stripe_customer_id=refs->>'customerId' OR b.known_subscription_id=refs->>'subscriptionId') AND b.workspace_id<>target)
   OR EXISTS(SELECT FROM public.billing_charge_binding b WHERE b.environment=e AND b.account_id=a
     AND (b.charge_id=charge OR b.payment_intent_id=refs->>'paymentIntentId' OR event_kind='invoice' AND b.invoice_id=p->>'objectId')
     AND (b.workspace_id<>target OR b.charge_id=charge AND refs->>'paymentIntentId' IS NOT NULL AND b.payment_intent_id<>refs->>'paymentIntentId'))
   OR EXISTS(SELECT FROM public.billing_customer b WHERE b.workspace_id=target AND b.environment=e AND b.account_id=a
     AND b.known_subscription_id IS NOT NULL AND refs->>'subscriptionId' IS NOT NULL AND b.known_subscription_id<>refs->>'subscriptionId')
   THEN RAISE EXCEPTION 'Billing mappings changed or contradict'; END IF;
  SELECT id INTO op FROM public.billing_operation WHERE workspace_id=target AND environment=e AND account_id=a
    AND kind='CHECKOUT_CREATE' AND phase IN ('DISPATCHING','UNKNOWN','SUCCEEDED');
  IF op IS NULL OR refs->>'customerId' IS NOT NULL AND NOT EXISTS(SELECT FROM public.billing_customer WHERE workspace_id=target
    AND environment=e AND account_id=a AND stripe_customer_id=refs->>'customerId') THEN RAISE EXCEPTION 'Billing operation unavailable'; END IF;
 END IF;
 IF receipt.id IS NULL THEN
  INSERT INTO public.billing_event_receipt(environment,account_id,event_id,projection,projection_hash,charge_id,risk_id)
   VALUES(e,a,p->>'id',p,encode(sha256(convert_to(p::text,'UTF8')),'hex'),charge,refs->>'riskId') RETURNING id INTO inserted;
  receipt.id:=inserted;
  IF risk THEN PERFORM app_private.billing_revise_risk(e,a,charge); END IF;
 END IF;
 IF target IS NULL THEN RETURN jsonb_build_object('status','unassigned-risk'); END IF;
 PERFORM app_private.billing_associate_receipt(receipt.id,target,op);
 RETURN jsonb_build_object('status','enqueued');
END $$;
--> statement-breakpoint
CREATE FUNCTION app_private.billing_claim_admission() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o public.billing_outbox; mode text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('billing-native-admission',8341));
 SELECT * INTO o FROM public.billing_outbox WHERE admission_state IN ('dispatching','unknown','admitted') ORDER BY created_at,id LIMIT 1 FOR UPDATE;
 IF o.id IS NOT NULL THEN
  IF o.admission_lease_until>clock_timestamp() THEN RETURN NULL; END IF;
  mode:='reconcile';
 ELSE
  SELECT b.* INTO o FROM public.billing_outbox b JOIN public.billing_command c ON c.id=b.command_id AND c.workspace_id=b.workspace_id
   WHERE b.admission_state='ready' AND c.completed_at IS NULL ORDER BY b.created_at,b.id LIMIT 1 FOR UPDATE OF b;
  IF o.id IS NULL THEN RETURN NULL; END IF;
  mode:='dispatch';
 END IF;
 UPDATE public.billing_outbox SET admission_fence=admission_fence+1,admission_lease_until=clock_timestamp()+interval '30 seconds',
  admission_state=CASE WHEN mode='dispatch' THEN 'dispatching' WHEN admission_state='dispatching' THEN 'unknown' ELSE admission_state END
  WHERE id=o.id RETURNING * INTO o;
 RETURN jsonb_build_object('input',jsonb_build_object('outboxId',o.id,'tenantId',o.workspace_id),'fence',o.admission_fence,'state',mode,'runId',o.run_id);
END $$;
CREATE FUNCTION app_private.billing_finalize_admission(outbox uuid,tenant uuid,fence bigint,result jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE o public.billing_outbox; mode text; run uuid;
BEGIN
 mode:=result->>'state';
 IF NOT coalesce(CASE mode WHEN 'unknown' THEN app_private.billing_json_keys(result,ARRAY['state'])
  WHEN 'admitted' THEN app_private.billing_json_keys(result,ARRAY['state','runId'])
  WHEN 'terminal' THEN app_private.billing_json_keys(result,ARRAY['state','runId','terminalDisposition']) ELSE false END,false) THEN RAISE EXCEPTION 'Billing native observation rejected'; END IF;
 IF mode<>'unknown' THEN
  IF NOT coalesce(result->>'runId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false) THEN RAISE EXCEPTION 'Billing native run rejected'; END IF;
  run:=(result->>'runId')::uuid;
 END IF;
 IF mode='terminal' AND NOT coalesce(result->>'terminalDisposition' IN ('completed','failed','cancelled'),false) THEN RAISE EXCEPTION 'Billing terminal observation rejected'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('billing-native-admission',8341));
 SELECT * INTO o FROM public.billing_outbox WHERE id=outbox AND workspace_id=tenant FOR UPDATE;
 IF o.id IS NULL OR o.admission_fence IS DISTINCT FROM fence OR o.admission_state NOT IN ('dispatching','unknown','admitted')
  OR o.admission_lease_until IS NULL OR o.admission_lease_until<=clock_timestamp() THEN RETURN false; END IF;
 IF mode='unknown' THEN
  UPDATE public.billing_outbox SET admission_state='unknown',admission_lease_until=NULL WHERE id=o.id;
 ELSIF mode='admitted' THEN
  IF o.run_id IS NOT NULL AND o.run_id<>run THEN RETURN false; END IF;
  UPDATE public.billing_outbox SET admission_state='admitted',run_id=run,admission_lease_until=NULL WHERE id=o.id;
 ELSE
  IF o.run_id IS DISTINCT FROM run THEN RETURN false; END IF;
  UPDATE public.billing_outbox SET admission_state='retired',admission_lease_until=NULL,terminal_disposition=result->>'terminalDisposition' WHERE id=o.id;
 END IF;
 RETURN true;
END $$;
CREATE FUNCTION app_private.billing_known_invoices(c public.billing_command) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') FROM (
  SELECT t->>'invoiceId' id FROM jsonb_array_elements((c).target_progress) t
  UNION SELECT r.projection->>'objectId' FROM public.billing_event_receipt r WHERE r.id=(c).receipt_id AND r.projection->>'objectType'='invoice'
  UNION SELECT b.invoice_id FROM public.billing_charge_binding b JOIN public.billing_event_receipt r ON r.id=(c).receipt_id
    WHERE b.workspace_id=(c).workspace_id AND b.environment=r.environment AND b.account_id=r.account_id AND
    (r.charge_id IS NOT NULL AND b.charge_id=r.charge_id
     OR r.projection->>'objectType'='subscription' AND b.subscription_id=r.projection->>'objectId'
     OR r.projection->>'objectType'='checkout.session' AND b.operation_id=(c).operation_id)
 ) known
$$;
CREATE FUNCTION app_private.billing_claim_command(outbox uuid,tenant uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.billing_command; op public.billing_operation; customer public.billing_customer; event jsonb; known jsonb;
BEGIN
 SELECT cmd.* INTO c FROM public.billing_command cmd JOIN public.billing_outbox o ON o.command_id=cmd.id AND o.workspace_id=cmd.workspace_id
  JOIN public.billing_receipt_assignment a ON a.receipt_id=cmd.receipt_id AND a.workspace_id=cmd.workspace_id
  WHERE o.id=outbox AND o.workspace_id=tenant;
 IF c.id IS NULL THEN RETURN NULL; END IF;
 IF c.completed_at IS NULL THEN
  PERFORM app_private.billing_lock_workspace(tenant);
  SELECT * INTO c FROM public.billing_command WHERE id=c.id FOR UPDATE;
 END IF;
 IF c.completed_at IS NOT NULL THEN
  IF jsonb_array_length(c.target_progress)=0 OR EXISTS(SELECT FROM jsonb_array_elements(c.target_progress) t WHERE
    t->'identityValidated' IS DISTINCT FROM 'true'::jsonb
    OR NOT coalesce(app_private.billing_uint(t->'requiredWorkRevision'),false) OR t->'requiredWorkRevision'='0'::jsonb
    OR jsonb_typeof(t->'requiresMonetary') IS DISTINCT FROM 'boolean' OR jsonb_typeof(t->'requiresRisk') IS DISTINCT FROM 'boolean'
    OR NOT coalesce(t->'requiresMonetary'='true'::jsonb OR t->'requiresRisk'='true'::jsonb,false)
    OR t->'requiresMonetary'='true'::jsonb AND (t->'monetarySettlement'->'revision' IS DISTINCT FROM t->'requiredWorkRevision'
      OR NOT coalesce(t->'monetarySettlement'->>'disposition' IN ('applied','duplicate','held','observed-no-grant'),false))
    OR t->'requiresRisk'='true'::jsonb AND (t->'riskSettlement'->'revision' IS DISTINCT FROM t->'requiredWorkRevision'
      OR NOT coalesce(t->'riskSettlement'->>'disposition' IN ('held','risk-recorded'),false))) THEN
   RAISE EXCEPTION 'Billing completion inconsistent';
  END IF;
  -- Historical completion grants neither a fresh lease nor service authority.
  RETURN jsonb_build_object('input',jsonb_build_object('outboxId',outbox,'tenantId',tenant),'commandCompleted',true);
 END IF;
 IF c.lease_until>clock_timestamp() THEN RETURN NULL; END IF;
 SELECT * INTO op FROM public.billing_operation WHERE id=c.operation_id AND workspace_id=tenant AND kind='CHECKOUT_CREATE';
 SELECT * INTO customer FROM public.billing_customer WHERE workspace_id=tenant AND environment=op.environment AND account_id=op.account_id AND stripe_customer_id=op.customer_id;
 SELECT projection INTO event FROM public.billing_event_receipt WHERE id=c.receipt_id;
 IF op.id IS NULL OR customer.id IS NULL OR op.phase NOT IN ('SUCCEEDED','DISPATCHING','UNKNOWN') THEN RETURN NULL; END IF;
 known:=app_private.billing_known_invoices(c);
 IF jsonb_array_length(known)>500 THEN RAISE EXCEPTION 'Billing candidates exceed bound'; END IF;
 UPDATE public.billing_command SET fence=fence+1,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=c.id RETURNING * INTO c;
 RETURN jsonb_build_object('input',jsonb_build_object('outboxId',outbox,'tenantId',tenant),'commandCompleted',false,'fence',c.fence,
  'deadlineAtMs',floor(extract(epoch FROM c.lease_until)*1000),'event',event,'knownInvoiceIds',known,
  'manifestRevision',c.manifest_revision,'targetProgress',c.target_progress,
  'operation',jsonb_build_object('id',op.id,'workspaceId',op.workspace_id,'kind',op.kind,'phase',op.phase,'environment',op.environment,'accountId',op.account_id,
   'apiVersion',op.api_version,'idempotencyKey',op.idempotency_key,'requestHash',op.request_hash,'customerId',op.customer_id,'monthlyPriceId',op.monthly_price_id,
   'onboardingPriceId',op.onboarding_price_id,'currency',op.currency,'monthlyUnitAmount',op.monthly_unit_amount,'onboardingUnitAmount',op.onboarding_unit_amount,
   'integrationIdentifier',op.integration_identifier,'checkoutReferenceVersion',op.checkout_reference_version,'stripeObjectId',op.stripe_object_id,
   'checkoutUrl',op.checkout_url,'checkoutExpiresAt',op.checkout_expires_at,'createdAt',op.created_at,'updatedAt',op.updated_at),
  'customer',jsonb_build_object('id',customer.id,'workspaceId',customer.workspace_id,'environment',customer.environment,'accountId',customer.account_id,
   'stripeCustomerId',customer.stripe_customer_id,'knownSubscriptionId',customer.known_subscription_id,'createdAt',customer.created_at));
END $$;
CREATE FUNCTION app_private.billing_locked_command(outbox uuid,tenant uuid,p_fence bigint,extra text[]) RETURNS public.billing_command
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.billing_command; e text; a text; charges text[];
BEGIN
 SELECT cmd.* INTO c FROM public.billing_command cmd JOIN public.billing_outbox o ON o.command_id=cmd.id AND o.workspace_id=cmd.workspace_id
  WHERE o.id=outbox AND o.workspace_id=tenant;
 IF c.id IS NULL THEN RETURN NULL; END IF;
 SELECT environment,account_id INTO e,a FROM public.billing_event_receipt WHERE id=c.receipt_id;
 SELECT array_agg(DISTINCT ch ORDER BY ch) INTO charges FROM (
  SELECT unnest(extra) ch UNION SELECT b.charge_id FROM public.billing_charge_binding b
   WHERE b.environment=e AND b.account_id=a AND b.workspace_id=tenant AND c.identities ? b.invoice_id
 ) keys;
 IF cardinality(charges)>500 THEN RAISE EXCEPTION 'Billing retained graph exceeds bound'; END IF;
 PERFORM app_private.billing_lock_charges(e,a,charges);
 PERFORM app_private.billing_lock_workspace(tenant);
 SELECT * INTO c FROM public.billing_command WHERE id=c.id FOR UPDATE;
 IF c.fence IS DISTINCT FROM p_fence OR c.lease_until IS NULL OR c.lease_until<=clock_timestamp() OR c.completed_at IS NOT NULL THEN RETURN NULL; END IF;
 IF EXISTS(SELECT FROM public.billing_charge_binding b WHERE b.environment=e AND b.account_id=a AND b.workspace_id=tenant
   AND c.identities ? b.invoice_id AND NOT b.charge_id=ANY(coalesce(charges,ARRAY[]::text[]))) THEN
  RAISE EXCEPTION 'Billing graph changed during lock acquisition' USING ERRCODE='40001';
 END IF;
 RETURN c;
END $$;
CREATE FUNCTION app_private.billing_snapshot(c public.billing_command,lineage jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE edges jsonb; charges jsonb; revisions jsonb; pointer public.billing_current_agreement; ready boolean;
BEGIN
 SELECT coalesce(jsonb_agg(jsonb_build_object('chargeId',b.charge_id,'paymentIntentId',b.payment_intent_id,'invoiceId',b.invoice_id)
  ORDER BY b.charge_id,b.payment_intent_id,b.invoice_id),'[]') INTO edges FROM public.billing_charge_binding b
  WHERE b.workspace_id=c.workspace_id AND b.operation_id=c.operation_id AND b.invoice_id=lineage->>'invoiceId';
 SELECT coalesce(jsonb_agg(ch ORDER BY ch),'[]') INTO charges FROM (SELECT DISTINCT v->>'chargeId' ch FROM jsonb_array_elements(edges) v) x;
 SELECT coalesce(jsonb_agg(jsonb_build_object('chargeId',ch,'revision',
   (SELECT count(*) FROM public.billing_event_receipt r WHERE r.environment=lineage->>'environment' AND r.account_id=lineage->>'accountId' AND r.charge_id=ch)
   +(SELECT count(*) FROM public.billing_risk_observation r WHERE r.environment=lineage->>'environment' AND r.account_id=lineage->>'accountId' AND r.charge_id=ch)) ORDER BY ch),'[]')
  INTO revisions FROM jsonb_array_elements_text(charges) ch;
 IF jsonb_array_length(edges)>500 OR jsonb_array_length(charges)>500 THEN RAISE EXCEPTION 'Billing graph exceeds bound'; END IF;
 SELECT * INTO pointer FROM public.billing_current_agreement WHERE workspace_id=c.workspace_id;
 ready:=jsonb_array_length(c.target_progress)>0 AND NOT EXISTS(SELECT FROM jsonb_array_elements(c.target_progress) t WHERE t->>'identityValidated' IS DISTINCT FROM 'true');
 RETURN jsonb_build_object('lineage',lineage,'chargeIds',charges,'riskRevisions',revisions,'expectedAgreementVersion',coalesce(pointer.version,0),
  'expectedCurrentAgreementId',pointer.agreement_id,'manifestRevision',c.manifest_revision,'manifestReady',ready,'paymentEdges',edges);
END $$;
--> statement-breakpoint
CREATE FUNCTION app_private.billing_observe_command(outbox uuid,tenant uuid,p_fence bigint,lineage jsonb,input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.billing_command; op public.billing_operation; customer public.billing_customer; event jsonb; bound jsonb; edge jsonb;
 ids jsonb; inv text; t jsonb; next_targets jsonb:='[]'; changed boolean:=false; graph_changed boolean:=false; new_edges text[]:=ARRAY[]::text[];
 receipt record; risk_kind boolean; needs_risk boolean; existing_identity jsonb;
BEGIN
 IF NOT coalesce(app_private.billing_json_keys(input,ARRAY['candidateInvoiceIds','paymentEdges']),false)
  OR NOT coalesce(app_private.billing_string_ids(input->'candidateInvoiceIds','^in_[A-Za-z0-9]+$'),false)
  OR jsonb_array_length(input->'candidateInvoiceIds')=0 OR NOT coalesce(app_private.billing_json_array(input->'paymentEdges'),false)
  OR NOT coalesce(app_private.billing_json_keys(lineage,ARRAY['operationId','workspaceId','environment','accountId','customerId','checkoutSessionId','subscriptionId','invoiceId','boundInvoice']),false)
  OR lineage->>'workspaceId' IS DISTINCT FROM tenant::text THEN RAISE EXCEPTION 'Billing observation rejected'; END IF;
 bound:=lineage->'boundInvoice';
 IF jsonb_typeof(bound) IS DISTINCT FROM 'object' OR NOT bound ?& ARRAY['environment','accountId','customerId','subscriptionId','invoiceId','monthlyPriceId','currency','expectedAmount','periodStart','periodEnd']
  OR EXISTS(SELECT FROM jsonb_object_keys(bound) k WHERE k<>ALL(ARRAY['environment','accountId','customerId','subscriptionId','invoiceId','monthlyPriceId','currency','expectedAmount','periodStart','periodEnd','firstPeriod','onboarding']))
  OR NOT coalesce(app_private.billing_uint(bound->'expectedAmount') AND app_private.billing_uint(bound->'periodStart') AND app_private.billing_uint(bound->'periodEnd'),false)
  OR (bound->>'expectedAmount')::bigint<=0 OR (bound->>'periodStart')::bigint<=0 OR (bound->>'periodEnd')::bigint<=(bound->>'periodStart')::bigint
  OR EXISTS(SELECT FROM unnest(ARRAY['operationId','workspaceId','environment','accountId','customerId','checkoutSessionId','subscriptionId','invoiceId']) k
    WHERE jsonb_typeof(lineage->k) IS DISTINCT FROM 'string' OR length(lineage->>k)>255)
  OR bound ? 'firstPeriod' AND jsonb_typeof(bound->'firstPeriod') IS DISTINCT FROM 'boolean'
  OR bound ? 'onboarding' AND bound->'onboarding'<>'null'::jsonb AND NOT coalesce(app_private.billing_json_keys(bound->'onboarding',ARRAY['priceId','amount'])
    AND app_private.billing_uint(bound->'onboarding'->'amount'),false)
  OR NOT coalesce(lineage->>'invoiceId' ~ '^in_[A-Za-z0-9]+$' AND lineage->>'subscriptionId' ~ '^sub_[A-Za-z0-9]+$'
    AND lineage->>'customerId' ~ '^cus_[A-Za-z0-9]+$' AND lineage->>'checkoutSessionId' ~ '^cs_(test|live)_[A-Za-z0-9]+$',false)
  OR NOT (input->'candidateInvoiceIds') ? (lineage->>'invoiceId') THEN RAISE EXCEPTION 'Billing lineage shape rejected'; END IF;
 FOR edge IN SELECT value FROM jsonb_array_elements(input->'paymentEdges') LOOP
  IF NOT coalesce(app_private.billing_json_keys(edge,ARRAY['chargeId','paymentIntentId','invoiceId']),false)
   OR NOT coalesce(edge->>'chargeId' ~ '^ch_[A-Za-z0-9]+$' AND edge->>'paymentIntentId' ~ '^pi_[A-Za-z0-9]+$',false)
   OR edge->>'invoiceId' IS DISTINCT FROM lineage->>'invoiceId' THEN RAISE EXCEPTION 'Billing edge rejected'; END IF;
  new_edges:=array_append(new_edges,edge->>'chargeId');
 END LOOP;
 SELECT array_agg(DISTINCT ch ORDER BY ch) INTO new_edges FROM (
  SELECT unnest(new_edges) ch UNION SELECT b.charge_id FROM public.billing_charge_binding b
   WHERE b.workspace_id=tenant AND b.environment=lineage->>'environment' AND b.account_id=lineage->>'accountId'
    AND (input->'candidateInvoiceIds') ? b.invoice_id
 ) retained_keys;
 c:=app_private.billing_locked_command(outbox,tenant,p_fence,new_edges);
 IF c.id IS NULL THEN RAISE EXCEPTION 'Billing claim stale'; END IF;
 IF EXISTS(SELECT FROM public.billing_charge_binding b WHERE b.workspace_id=tenant AND b.environment=lineage->>'environment'
   AND b.account_id=lineage->>'accountId' AND (input->'candidateInvoiceIds') ? b.invoice_id
   AND NOT b.charge_id=ANY(coalesce(new_edges,ARRAY[]::text[]))) THEN RAISE EXCEPTION 'Billing candidate graph changed during lock wait' USING ERRCODE='40001'; END IF;
 SELECT * INTO op FROM public.billing_operation WHERE id=c.operation_id AND workspace_id=tenant;
 SELECT * INTO customer FROM public.billing_customer WHERE workspace_id=tenant AND environment=op.environment AND account_id=op.account_id AND stripe_customer_id=op.customer_id;
 SELECT projection INTO event FROM public.billing_event_receipt WHERE id=c.receipt_id;
 IF op.id::text IS DISTINCT FROM lineage->>'operationId' OR op.kind<>'CHECKOUT_CREATE' OR op.phase NOT IN ('DISPATCHING','UNKNOWN','SUCCEEDED')
  OR customer.id IS NULL OR op.environment IS DISTINCT FROM lineage->>'environment' OR op.account_id IS DISTINCT FROM lineage->>'accountId'
  OR op.customer_id IS DISTINCT FROM lineage->>'customerId' OR op.monthly_price_id IS DISTINCT FROM bound->>'monthlyPriceId'
  OR op.currency IS DISTINCT FROM bound->>'currency'
  OR op.monthly_unit_amount+(CASE WHEN bound->>'firstPeriod'='true' THEN coalesce(op.onboarding_unit_amount,0) ELSE 0 END) IS DISTINCT FROM (bound->>'expectedAmount')::bigint
  OR bound->>'firstPeriod'='true' AND op.onboarding_price_id IS NOT NULL AND
   (bound->'onboarding'->>'priceId' IS DISTINCT FROM op.onboarding_price_id OR (bound->'onboarding'->>'amount')::bigint IS DISTINCT FROM op.onboarding_unit_amount)
  OR (bound->>'firstPeriod' IS DISTINCT FROM 'true' OR op.onboarding_price_id IS NULL) AND bound->'onboarding' IS NOT NULL AND bound->'onboarding'<>'null'::jsonb
  OR op.stripe_object_id IS NOT NULL AND op.stripe_object_id IS DISTINCT FROM lineage->>'checkoutSessionId'
  OR op.stripe_object_id IS NULL AND op.checkout_reference_version<>'operation-v2'
  OR customer.known_subscription_id IS NOT NULL AND customer.known_subscription_id IS DISTINCT FROM lineage->>'subscriptionId'
  OR op.environment='sandbox' AND lineage->>'checkoutSessionId' !~'^cs_test_' OR op.environment='live' AND lineage->>'checkoutSessionId' !~'^cs_live_'
  OR EXISTS(SELECT FROM unnest(ARRAY['environment','accountId','customerId','subscriptionId','invoiceId']) k WHERE bound->k IS DISTINCT FROM lineage->k)
  OR event->'references'->>'customerId' IS NOT NULL AND event->'references'->>'customerId' IS DISTINCT FROM lineage->>'customerId'
  OR event->'references'->>'subscriptionId' IS NOT NULL AND event->'references'->>'subscriptionId' IS DISTINCT FROM lineage->>'subscriptionId'
  OR event->>'objectType'='invoice' AND event->>'objectId' IS DISTINCT FROM lineage->>'invoiceId'
  OR event->>'objectType'='subscription' AND event->>'objectId' IS DISTINCT FROM lineage->>'subscriptionId'
  OR event->>'objectType'='checkout.session' AND event->>'objectId' IS DISTINCT FROM lineage->>'checkoutSessionId'
  OR EXISTS(SELECT FROM public.billing_command other WHERE other.id<>c.id AND other.identities ? (lineage->>'invoiceId')
    AND (other.identities->(lineage->>'invoiceId'))->>'environment'=op.environment
    AND (other.identities->(lineage->>'invoiceId'))->>'accountId'=op.account_id
    AND (other.identities->(lineage->>'invoiceId'))->>'workspaceId' IS DISTINCT FROM tenant::text)
 THEN RAISE EXCEPTION 'Billing positive lineage disagrees with durable authority'; END IF;
 existing_identity:=c.identities->(lineage->>'invoiceId');
 IF existing_identity IS NOT NULL AND existing_identity IS DISTINCT FROM lineage THEN RAISE EXCEPTION 'Billing lineage changed'; END IF;
 SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') INTO ids FROM (
  SELECT jsonb_array_elements_text(input->'candidateInvoiceIds') id UNION SELECT jsonb_array_elements_text(app_private.billing_known_invoices(c))
 ) targets;
 IF jsonb_array_length(ids)>500 THEN RAISE EXCEPTION 'Billing cumulative target bound exceeded'; END IF;
 UPDATE public.billing_customer SET known_subscription_id=lineage->>'subscriptionId' WHERE id=customer.id AND known_subscription_id IS NULL;
 FOR edge IN SELECT value FROM jsonb_array_elements(input->'paymentEdges') ORDER BY value->>'chargeId',value->>'paymentIntentId' LOOP
  IF NOT EXISTS(SELECT FROM public.billing_charge_binding b WHERE b.environment=op.environment AND b.account_id=op.account_id
     AND b.charge_id=edge->>'chargeId' AND b.payment_intent_id=edge->>'paymentIntentId' AND b.invoice_id=edge->>'invoiceId') THEN
   INSERT INTO public.billing_charge_binding(workspace_id,operation_id,environment,account_id,customer_id,subscription_id,charge_id,payment_intent_id,invoice_id)
    VALUES(tenant,op.id,op.environment,op.account_id,op.customer_id,lineage->>'subscriptionId',edge->>'chargeId',edge->>'paymentIntentId',edge->>'invoiceId');
   graph_changed:=true;
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.billing_charge_binding b WHERE b.workspace_id=tenant AND b.operation_id=op.id AND ids ? b.invoice_id)>500 THEN RAISE EXCEPTION 'Billing retained edge bound exceeded'; END IF;
 risk_kind:=event->>'objectType' IN ('charge','dispute','radar.early_fraud_warning');
 IF risk_kind AND NOT EXISTS(SELECT FROM public.billing_charge_binding b WHERE b.workspace_id=tenant AND b.operation_id=op.id
   AND b.invoice_id=lineage->>'invoiceId' AND b.charge_id=event->'references'->>'chargeId'
   AND (event->'references'->>'paymentIntentId' IS NULL OR b.payment_intent_id=event->'references'->>'paymentIntentId')) THEN RAISE EXCEPTION 'Billing risk target has no proven edge'; END IF;
 FOR inv IN SELECT jsonb_array_elements_text(ids) LOOP
  SELECT value INTO t FROM jsonb_array_elements(c.target_progress) WHERE value->>'invoiceId'=inv;
  needs_risk:=risk_kind OR EXISTS(SELECT FROM public.billing_charge_binding b WHERE b.workspace_id=tenant AND b.operation_id=op.id AND b.invoice_id=inv
   AND (EXISTS(SELECT FROM public.billing_event_receipt r WHERE r.environment=op.environment AND r.account_id=op.account_id AND r.charge_id=b.charge_id)
    OR EXISTS(SELECT FROM public.billing_risk_observation r WHERE r.environment=op.environment AND r.account_id=op.account_id AND r.charge_id=b.charge_id)));
  IF t IS NULL THEN
   t:=jsonb_build_object('invoiceId',inv,'identityValidated',false,'requiredWorkRevision',1,'requiresMonetary',NOT risk_kind,'requiresRisk',needs_risk,'monetarySettlement',NULL,'riskSettlement',NULL); changed:=true;
  ELSIF inv=lineage->>'invoiceId' AND graph_changed OR needs_risk AND t->>'requiresRisk'<>'true' THEN
   t:=t||jsonb_build_object('requiredWorkRevision',(t->>'requiredWorkRevision')::bigint+1,'requiresRisk',needs_risk); changed:=true;
  END IF;
  IF inv=lineage->>'invoiceId' AND t->>'identityValidated'<>'true' THEN t:=t||jsonb_build_object('identityValidated',true); changed:=true; END IF;
  next_targets:=next_targets||jsonb_build_array(t);
 END LOOP;
 UPDATE public.billing_command SET target_progress=next_targets,identities=identities||jsonb_build_object(lineage->>'invoiceId',lineage),
  manifest_revision=manifest_revision+CASE WHEN changed THEN 1 ELSE 0 END WHERE id=c.id RETURNING * INTO c;
 FOR receipt IN SELECT DISTINCT r.id,r.charge_id,r.projection FROM public.billing_event_receipt r JOIN public.billing_charge_binding b
   ON b.environment=r.environment AND b.account_id=r.account_id AND b.charge_id=r.charge_id
   WHERE b.workspace_id=tenant AND b.operation_id=op.id AND ids ? b.invoice_id
    AND NOT EXISTS(SELECT FROM public.billing_receipt_assignment a WHERE a.receipt_id=r.id) ORDER BY r.id LOOP
  IF receipt.projection->'references'->>'chargeId' IS NOT NULL
    AND receipt.projection->'references'->>'chargeId' IS DISTINCT FROM receipt.charge_id
   OR EXISTS(SELECT FROM public.billing_charge_binding retained WHERE retained.environment=op.environment AND retained.account_id=op.account_id
    AND retained.charge_id=receipt.charge_id AND (retained.workspace_id<>tenant OR retained.operation_id<>op.id
     OR receipt.projection->'references'->>'paymentIntentId' IS NOT NULL
       AND receipt.projection->'references'->>'paymentIntentId' IS DISTINCT FROM retained.payment_intent_id
     OR receipt.projection->'references'->>'customerId' IS NOT NULL
       AND receipt.projection->'references'->>'customerId' IS DISTINCT FROM retained.customer_id
     OR receipt.projection->'references'->>'subscriptionId' IS NOT NULL
       AND receipt.projection->'references'->>'subscriptionId' IS DISTINCT FROM retained.subscription_id)) THEN
   RAISE EXCEPTION 'Billing retained receipt references contradict proven graph';
  END IF;
  PERFORM app_private.billing_associate_receipt(receipt.id,tenant,op.id);
  PERFORM app_private.billing_revise_risk(op.environment,op.account_id,receipt.charge_id);
 END LOOP;
 SELECT * INTO c FROM public.billing_command WHERE id=c.id;
 RETURN app_private.billing_snapshot(c,lineage);
END $$;
--> statement-breakpoint
CREATE FUNCTION app_private.billing_risk_adverse(f jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_array_length(f->'disputes')>0 OR jsonb_array_length(f->'earlyFraudWarnings')>0 OR EXISTS(
  SELECT FROM jsonb_array_elements(f->'chargeObservations') v WHERE (v->>'amountRefunded')::bigint>0
   OR v->>'refunded'='true' OR v->>'disputed'='true' OR v->>'stripeFraudReport'='fraudulent' OR v->>'userFraudReport'='fraudulent')
$$;
CREATE FUNCTION app_private.billing_has_adverse(e text,a text,charges jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT FROM public.billing_event_receipt r WHERE r.environment=e AND r.account_id=a AND charges ? r.charge_id)
 OR EXISTS(SELECT FROM public.billing_risk_observation r WHERE r.environment=e AND r.account_id=a AND charges ? r.charge_id AND app_private.billing_risk_adverse(r.facts))
$$;
CREATE FUNCTION app_private.billing_settle_target(c public.billing_command,invoice text,disposition text,is_risk boolean,agreement uuid,facts jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE t jsonb; targets jsonb:='[]'; finished boolean; retained_references jsonb; matched boolean:=false;
BEGIN
 FOR t IN SELECT value FROM jsonb_array_elements(c.target_progress) LOOP
  IF t->>'invoiceId'=invoice THEN
   matched:=true;
   IF is_risk THEN
    SELECT coalesce(jsonb_agg(v ORDER BY v),'[]') INTO retained_references FROM (
      SELECT jsonb_array_elements_text(coalesce(nullif(t->'riskSettlement'->'riskObservationIds','null'::jsonb),'[]')) v
      UNION SELECT jsonb_array_elements_text(facts)
    ) ids;
    IF jsonb_array_length(retained_references)>500 THEN RAISE EXCEPTION 'Billing retained risk facts exceed bound'; END IF;
    t:=t||jsonb_build_object('riskSettlement',jsonb_build_object('revision',(t->>'requiredWorkRevision')::bigint,'disposition',disposition,'riskObservationIds',retained_references));
   ELSE
    t:=t||jsonb_build_object('monetarySettlement',jsonb_build_object('revision',(t->>'requiredWorkRevision')::bigint,'disposition',disposition,
      'agreementId',coalesce(agreement::text,t->'monetarySettlement'->>'agreementId')));
   END IF;
  END IF;
  targets:=targets||jsonb_build_array(t);
 END LOOP;
 IF NOT matched THEN RAISE EXCEPTION 'Billing target missing'; END IF;
 finished:=jsonb_array_length(targets)>0 AND NOT EXISTS(SELECT FROM jsonb_array_elements(targets) v WHERE
  v->>'identityValidated'<>'true'
  OR v->>'requiresMonetary'='true' AND (v->'monetarySettlement'->>'revision')::bigint IS DISTINCT FROM (v->>'requiredWorkRevision')::bigint
  OR v->>'requiresRisk'='true' AND (v->'riskSettlement'->>'revision')::bigint IS DISTINCT FROM (v->>'requiredWorkRevision')::bigint);
 UPDATE public.billing_command SET target_progress=targets,completed_at=CASE WHEN finished THEN clock_timestamp() ELSE NULL END WHERE id=c.id;
 RETURN jsonb_build_object('targetDisposition',disposition,'commandCompleted',finished);
END $$;
CREATE FUNCTION app_private.billing_check_observation(p jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT coalesce(app_private.billing_json_keys(p,ARRAY['lineage','chargeIds','riskRevisions','expectedAgreementVersion','expectedCurrentAgreementId','manifestRevision','manifestReady','paymentEdges']),false)
  OR NOT coalesce(app_private.billing_string_ids(p->'chargeIds','^ch_[A-Za-z0-9]+$'),false)
  OR NOT coalesce(app_private.billing_json_array(p->'paymentEdges') AND app_private.billing_json_array(p->'riskRevisions'),false)
  OR NOT coalesce(app_private.billing_uint(p->'expectedAgreementVersion') AND app_private.billing_uint(p->'manifestRevision'),false)
  OR jsonb_typeof(p->'manifestReady') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Billing observation shape rejected'; END IF;
END $$;
CREATE FUNCTION app_private.billing_apply_command(outbox uuid,tenant uuid,p_fence bigint,observation jsonb,decision jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.billing_command; snapshot jsonb; lineage jsonb; bound jsonb; proof jsonb; amount bigint;
 agreement public.billing_agreement; pointer public.billing_current_agreement; current_end bigint;
 t jsonb; disposition text; duplicate boolean:=false; allowed boolean; adverse boolean; charge text; intent text;
BEGIN
 PERFORM app_private.billing_check_observation(observation);
 IF NOT coalesce(CASE decision->>'kind' WHEN 'paid' THEN app_private.billing_json_keys(decision,ARRAY['kind','proof'])
  WHEN 'observedNoGrant' THEN app_private.billing_json_keys(decision,ARRAY['kind','evidence'])
  WHEN 'unresolved' THEN app_private.billing_json_keys(decision,ARRAY['kind']) ELSE false END,false) THEN RAISE EXCEPTION 'Billing decision rejected'; END IF;
 c:=app_private.billing_locked_command(outbox,tenant,p_fence,ARRAY(SELECT jsonb_array_elements_text(observation->'chargeIds')));
 IF c.id IS NULL THEN RETURN jsonb_build_object('targetDisposition','stale','commandCompleted',false); END IF;
 lineage:=observation->'lineage'; bound:=lineage->'boundInvoice';
 IF c.identities->(lineage->>'invoiceId') IS DISTINCT FROM lineage THEN RAISE EXCEPTION 'Billing target authority changed'; END IF;
 snapshot:=app_private.billing_snapshot(c,lineage);
 IF observation IS DISTINCT FROM snapshot THEN RETURN jsonb_build_object('targetDisposition','stale','commandCompleted',false); END IF;
 IF snapshot->>'manifestReady'<>'true' THEN RETURN jsonb_build_object('targetDisposition','incomplete','commandCompleted',false); END IF;
 IF decision->>'kind'='unresolved' THEN RETURN jsonb_build_object('targetDisposition','unresolved','commandCompleted',false); END IF;
 SELECT value INTO t FROM jsonb_array_elements(c.target_progress) WHERE value->>'invoiceId'=lineage->>'invoiceId';
 IF t->>'requiresMonetary'<>'true' THEN RAISE EXCEPTION 'Billing monetary requirement absent'; END IF;
 proof:=CASE WHEN decision->>'kind'='paid' THEN decision->'proof' ELSE decision->'evidence' END;
 IF NOT coalesce(CASE decision->>'kind' WHEN 'paid' THEN app_private.billing_json_keys(proof,
   ARRAY['invoiceId','subscriptionId','customerId','currency','amount','periodStart','periodEnd','allocationIds','paymentIntentIds','chargeIds'])
  ELSE app_private.billing_json_keys(proof,ARRAY['kind','invoiceId','customerId','subscriptionId','currency','status','amountDue','amountPaid','amountRemaining','periodStart','periodEnd','invoicePaymentIds','observationDigest']) END,false)
  OR EXISTS(SELECT FROM unnest(ARRAY['invoiceId','customerId','subscriptionId']) k WHERE proof->k IS DISTINCT FROM lineage->k)
  OR EXISTS(SELECT FROM unnest(ARRAY['currency','periodStart','periodEnd']) k WHERE proof->k IS DISTINCT FROM bound->k)
 THEN RAISE EXCEPTION 'Billing monetary scope rejected'; END IF;
 allowed:=app_private.billing_lock_workspace(tenant);
 SELECT * INTO pointer FROM public.billing_current_agreement WHERE workspace_id=tenant;
 adverse:=app_private.billing_has_adverse(lineage->>'environment',lineage->>'accountId',snapshot->'chargeIds') OR pointer.held_at IS NOT NULL;
 IF decision->>'kind'='observedNoGrant' THEN
  IF proof->>'kind' IS DISTINCT FROM 'unpaid-invoice' OR NOT coalesce(proof->>'status' IN ('open','uncollectible'),false)
   OR proof->'amountPaid' IS DISTINCT FROM '0'::jsonb OR proof->'amountDue' IS DISTINCT FROM bound->'expectedAmount'
   OR proof->'amountRemaining' IS DISTINCT FROM bound->'expectedAmount'
   OR NOT coalesce(proof->>'observationDigest' ~ '^[0-9a-f]{64}$',false)
   OR NOT coalesce(app_private.billing_string_ids(proof->'invoicePaymentIds','^inpay_[A-Za-z0-9]+$'),false)
   THEN RAISE EXCEPTION 'Billing nonpayment evidence rejected'; END IF;
  disposition:='observed-no-grant';
 ELSE
  IF proof->'amount' IS DISTINCT FROM bound->'expectedAmount'
   OR NOT coalesce(app_private.billing_string_ids(proof->'allocationIds','^inpay_[A-Za-z0-9]+$')
    AND app_private.billing_string_ids(proof->'paymentIntentIds','^pi_[A-Za-z0-9]+$')
    AND app_private.billing_string_ids(proof->'chargeIds','^ch_[A-Za-z0-9]+$'),false)
   OR jsonb_array_length(proof->'allocationIds')=0 OR jsonb_array_length(proof->'paymentIntentIds')=0 OR jsonb_array_length(proof->'chargeIds')=0
   THEN RAISE EXCEPTION 'Billing positive payment proof rejected'; END IF;
  FOR charge IN SELECT jsonb_array_elements_text(proof->'chargeIds') LOOP
   IF NOT EXISTS(SELECT FROM jsonb_array_elements(snapshot->'paymentEdges') edge WHERE edge->>'chargeId'=charge AND (proof->'paymentIntentIds') ? (edge->>'paymentIntentId')) THEN
    RAISE EXCEPTION 'Billing payment Charge has no explicit edge'; END IF;
  END LOOP;
  FOR intent IN SELECT jsonb_array_elements_text(proof->'paymentIntentIds') LOOP
   IF NOT EXISTS(SELECT FROM jsonb_array_elements(snapshot->'paymentEdges') edge WHERE edge->>'paymentIntentId'=intent AND (proof->'chargeIds') ? (edge->>'chargeId')) THEN
    RAISE EXCEPTION 'Billing payment Intent has no explicit edge'; END IF;
  END LOOP;
  SELECT * INTO agreement FROM public.billing_agreement WHERE environment=lineage->>'environment' AND account_id=lineage->>'accountId'
    AND subscription_id=lineage->>'subscriptionId' AND period_start=(bound->>'periodStart')::bigint AND period_end=(bound->>'periodEnd')::bigint;
  IF agreement.id IS NOT NULL THEN
   IF agreement.workspace_id<>tenant OR agreement.operation_id<>c.operation_id OR agreement.invoice_id IS DISTINCT FROM lineage->>'invoiceId' OR agreement.proof IS DISTINCT FROM proof
    THEN RAISE EXCEPTION 'Billing paid period contradiction'; END IF;
   duplicate:=true;
  ELSE
   INSERT INTO public.billing_agreement(workspace_id,operation_id,environment,account_id,subscription_id,invoice_id,period_start,period_end,proof)
    VALUES(tenant,c.operation_id,lineage->>'environment',lineage->>'accountId',lineage->>'subscriptionId',lineage->>'invoiceId',
      (bound->>'periodStart')::bigint,(bound->>'periodEnd')::bigint,proof) RETURNING * INTO agreement;
  END IF;
  IF allowed AND NOT adverse THEN
   SELECT period_end INTO current_end FROM public.billing_agreement WHERE id=pointer.agreement_id;
   IF pointer.workspace_id IS NULL THEN
    INSERT INTO public.billing_current_agreement(workspace_id,agreement_id,version) VALUES(tenant,agreement.id,1);
   ELSIF agreement.period_end>current_end THEN
    UPDATE public.billing_current_agreement SET agreement_id=agreement.id,version=version+1 WHERE workspace_id=tenant
      AND version=(snapshot->>'expectedAgreementVersion')::bigint AND agreement_id::text IS NOT DISTINCT FROM snapshot->>'expectedCurrentAgreementId';
    IF NOT FOUND THEN RAISE EXCEPTION 'Billing pointer changed during application'; END IF;
   END IF;
  END IF;
  disposition:=CASE WHEN NOT allowed OR adverse THEN 'held' WHEN duplicate THEN 'duplicate' ELSE 'applied' END;
 END IF;
 -- Monetary facts may settle independently; a required risk handoff/read is
 -- still pending until recordRisk confirms its own current requirement.
 RETURN app_private.billing_settle_target(c,lineage->>'invoiceId',disposition,false,agreement.id,'[]');
END $$;
CREATE FUNCTION app_private.billing_record_risk(outbox uuid,tenant uuid,p_fence bigint,envelope jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.billing_command; observation jsonb; facts jsonb; lineage jsonb; snapshot jsonb; risk_value jsonb; charge jsonb;
 observed_charge_id text; pi text; scoped_facts jsonb; inserted uuid; fact_ids jsonb; known record; adverse boolean:=false; disposition text; event jsonb;
BEGIN
 IF NOT coalesce(app_private.billing_json_keys(envelope,ARRAY['observation','facts']),false) THEN RAISE EXCEPTION 'Billing risk envelope rejected'; END IF;
 observation:=envelope->'observation'; facts:=envelope->'facts'; lineage:=observation->'lineage';
 PERFORM app_private.billing_check_observation(observation);
 IF NOT coalesce(app_private.billing_json_keys(facts,ARRAY['chargeObservations','disputes','earlyFraudWarnings']),false)
  OR NOT coalesce(app_private.billing_json_array(facts->'chargeObservations') AND app_private.billing_json_array(facts->'disputes')
    AND app_private.billing_json_array(facts->'earlyFraudWarnings'),false) THEN RAISE EXCEPTION 'Billing risk facts rejected'; END IF;
 c:=app_private.billing_locked_command(outbox,tenant,p_fence,ARRAY(SELECT jsonb_array_elements_text(observation->'chargeIds')));
 IF c.id IS NULL THEN RETURN jsonb_build_object('targetDisposition','stale','commandCompleted',false); END IF;
 IF c.identities->(lineage->>'invoiceId') IS DISTINCT FROM lineage THEN RAISE EXCEPTION 'Billing risk lineage changed'; END IF;
 snapshot:=app_private.billing_snapshot(c,lineage);
 IF snapshot IS DISTINCT FROM observation THEN RETURN jsonb_build_object('targetDisposition','stale','commandCompleted',false); END IF;
 IF (SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') FROM (SELECT value->>'chargeId' id FROM jsonb_array_elements(facts->'chargeObservations')) x)
   IS DISTINCT FROM snapshot->'chargeIds' THEN RAISE EXCEPTION 'Billing risk Charge coverage incomplete'; END IF;
 FOR charge IN SELECT value FROM jsonb_array_elements(facts->'chargeObservations') LOOP
  IF NOT coalesce(app_private.billing_json_keys(charge,ARRAY['chargeId','paymentIntentId','customerId','currency','amountRefunded','refunded','disputed','stripeFraudReport','userFraudReport']),false)
   OR charge->>'customerId' IS DISTINCT FROM lineage->>'customerId' OR charge->>'currency' IS DISTINCT FROM lineage->'boundInvoice'->>'currency'
   OR NOT coalesce(app_private.billing_uint(charge->'amountRefunded'),false)
   OR jsonb_typeof(charge->'refunded') IS DISTINCT FROM 'boolean' OR jsonb_typeof(charge->'disputed') IS DISTINCT FROM 'boolean'
   OR NOT coalesce(charge->'stripeFraudReport'='null'::jsonb OR charge->>'stripeFraudReport'='fraudulent',false)
   OR NOT coalesce(charge->'userFraudReport'='null'::jsonb OR charge->>'userFraudReport' IN ('fraudulent','safe'),false)
   OR NOT EXISTS(SELECT FROM jsonb_array_elements(snapshot->'paymentEdges') edge WHERE edge->>'chargeId'=charge->>'chargeId' AND edge->>'paymentIntentId'=charge->>'paymentIntentId')
   THEN RAISE EXCEPTION 'Billing exact Charge facts rejected'; END IF;
 END LOOP;
 FOR risk_value IN SELECT v||jsonb_build_object('riskKind','dispute') FROM jsonb_array_elements(facts->'disputes') v
  UNION ALL SELECT v||jsonb_build_object('riskKind','warning') FROM jsonb_array_elements(facts->'earlyFraudWarnings') v LOOP
  IF NOT coalesce(CASE risk_value->>'riskKind' WHEN 'dispute' THEN app_private.billing_json_keys(risk_value,ARRAY['riskId','chargeId','paymentIntentId','status','riskKind'])
    ELSE app_private.billing_json_keys(risk_value,ARRAY['riskId','chargeId','paymentIntentId','actionable','riskKind']) END,false)
   OR NOT (snapshot->'chargeIds') ? (risk_value->>'chargeId')
   OR NOT coalesce(risk_value->>'riskId' ~ CASE WHEN risk_value->>'riskKind'='dispute' THEN '^dp_[A-Za-z0-9]+$' ELSE '^issfr_[A-Za-z0-9]+$' END,false)
   OR length(risk_value->>'riskId')>255
   OR risk_value->>'riskKind'='dispute' AND NOT coalesce(risk_value->>'status' IN ('lost','needs_response','prevented','under_review','warning_closed','warning_needs_response','warning_under_review','won'),false)
   OR risk_value->>'riskKind'='warning' AND jsonb_typeof(risk_value->'actionable') IS DISTINCT FROM 'boolean'
   OR EXISTS(SELECT FROM public.billing_event_receipt r WHERE r.environment=lineage->>'environment' AND r.account_id=lineage->>'accountId'
     AND r.risk_id=risk_value->>'riskId' AND r.charge_id IS DISTINCT FROM risk_value->>'chargeId')
   OR EXISTS(SELECT FROM public.billing_risk_observation r,LATERAL jsonb_array_elements((r.facts->'disputes')||(r.facts->'earlyFraudWarnings')) previous
     WHERE r.environment=lineage->>'environment' AND r.account_id=lineage->>'accountId'
      AND previous->>'riskId'=risk_value->>'riskId' AND r.charge_id IS DISTINCT FROM risk_value->>'chargeId')
   OR NOT EXISTS(SELECT FROM jsonb_array_elements(facts->'chargeObservations') ch WHERE ch->>'chargeId'=risk_value->>'chargeId'
      AND (risk_value->'paymentIntentId'='null'::jsonb OR risk_value->>'paymentIntentId'=ch->>'paymentIntentId')) THEN RAISE EXCEPTION 'Billing exact risk object rejected'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(facts->'disputes'))<>(SELECT count(DISTINCT v->>'riskId') FROM jsonb_array_elements(facts->'disputes') v)
  OR (SELECT count(*) FROM jsonb_array_elements(facts->'earlyFraudWarnings'))<>(SELECT count(DISTINCT v->>'riskId') FROM jsonb_array_elements(facts->'earlyFraudWarnings') v)
  THEN RAISE EXCEPTION 'Billing duplicate risk identities'; END IF;
 FOR known IN
  SELECT r.risk_id risk_id,r.charge_id charge_id FROM public.billing_event_receipt r WHERE r.environment=lineage->>'environment'
    AND r.account_id=lineage->>'accountId' AND (snapshot->'chargeIds') ? r.charge_id AND r.risk_id IS NOT NULL
  UNION SELECT v->>'riskId',r.charge_id FROM public.billing_risk_observation r,
    LATERAL jsonb_array_elements((r.facts->'disputes')||(r.facts->'earlyFraudWarnings')) v WHERE r.environment=lineage->>'environment'
    AND r.account_id=lineage->>'accountId' AND (snapshot->'chargeIds') ? r.charge_id
 LOOP
  IF NOT EXISTS(SELECT FROM jsonb_array_elements((facts->'disputes')||(facts->'earlyFraudWarnings')) v
    WHERE v->>'riskId'=known.risk_id AND v->>'chargeId'=known.charge_id) THEN RAISE EXCEPTION 'Billing retained risk identity missing'; END IF;
 END LOOP;
 SELECT projection INTO event FROM public.billing_event_receipt WHERE id=c.receipt_id;
 IF event->>'objectType' IN ('dispute','radar.early_fraud_warning') AND NOT EXISTS(
  SELECT FROM jsonb_array_elements((facts->'disputes')||(facts->'earlyFraudWarnings')) v
   WHERE v->>'riskId'=event->>'objectId' AND v->>'chargeId'=event->'references'->>'chargeId') THEN RAISE EXCEPTION 'Billing original risk identity missing'; END IF;
 FOR charge IN SELECT value FROM jsonb_array_elements(facts->'chargeObservations') ORDER BY value->>'chargeId' LOOP
  observed_charge_id:=charge->>'chargeId'; pi:=charge->>'paymentIntentId';
  scoped_facts:=jsonb_build_object('chargeObservations',jsonb_build_array(charge),
   'disputes',(SELECT coalesce(jsonb_agg(v ORDER BY v->>'riskId'),'[]') FROM jsonb_array_elements(facts->'disputes') v WHERE v->>'chargeId'=observed_charge_id),
   'earlyFraudWarnings',(SELECT coalesce(jsonb_agg(v ORDER BY v->>'riskId'),'[]') FROM jsonb_array_elements(facts->'earlyFraudWarnings') v WHERE v->>'chargeId'=observed_charge_id));
  inserted:=NULL;
  INSERT INTO public.billing_risk_observation(workspace_id,environment,account_id,charge_id,facts,facts_hash)
   VALUES(tenant,lineage->>'environment',lineage->>'accountId',observed_charge_id,scoped_facts,encode(sha256(convert_to(scoped_facts::text,'UTF8')),'hex'))
   ON CONFLICT(environment,account_id,charge_id,facts_hash) DO NOTHING RETURNING id INTO inserted;
  IF inserted IS NOT NULL AND app_private.billing_risk_adverse(scoped_facts) THEN
   PERFORM app_private.billing_revise_risk(lineage->>'environment',lineage->>'accountId',observed_charge_id);
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') INTO fact_ids FROM public.billing_risk_observation r
  WHERE r.environment=lineage->>'environment' AND r.account_id=lineage->>'accountId' AND (snapshot->'chargeIds') ? r.charge_id;
 IF jsonb_array_length(fact_ids)>500 THEN RAISE EXCEPTION 'Billing retained risk facts exceed bound'; END IF;
 SELECT * INTO c FROM public.billing_command WHERE id=c.id;
 adverse:=app_private.billing_has_adverse(lineage->>'environment',lineage->>'accountId',snapshot->'chargeIds');
 IF snapshot->>'manifestReady'<>'true' THEN RETURN jsonb_build_object('targetDisposition','incomplete','commandCompleted',false); END IF;
 disposition:=CASE WHEN adverse THEN 'held' ELSE 'risk-recorded' END;
 RETURN app_private.billing_settle_target(c,lineage->>'invoiceId',disposition,true,NULL,fact_ids);
END $$;
--> statement-breakpoint
CREATE FUNCTION app_private.billing_customer_binding_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF ROW(NEW.id,NEW.workspace_id,NEW.environment,NEW.account_id,NEW.stripe_customer_id,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.environment,OLD.account_id,OLD.stripe_customer_id,OLD.created_at)
  OR OLD.known_subscription_id IS NOT NULL AND NEW.known_subscription_id IS DISTINCT FROM OLD.known_subscription_id
  THEN RAISE EXCEPTION 'Billing Customer binding immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER billing_customer_binding_immutable BEFORE UPDATE ON public.billing_customer FOR EACH ROW EXECUTE FUNCTION app_private.billing_customer_binding_immutable();
ALTER FUNCTION app_private.billing_json_keys(jsonb,text[]) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_json_array(jsonb) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_uint(jsonb) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_string_ids(jsonb,text) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_lock_charges(text,text,text[]) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_lock_workspace(uuid) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_immutable() OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_binding_insert_guard() OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_reference_immutable() OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_customer_binding_immutable() OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_associate_receipt(uuid,uuid,uuid) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_revise_risk(text,text,text) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_receive_event(jsonb) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_claim_admission() OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_finalize_admission(uuid,uuid,bigint,jsonb) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_known_invoices(public.billing_command) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_claim_command(uuid,uuid) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_locked_command(uuid,uuid,bigint,text[]) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_snapshot(public.billing_command,jsonb) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_observe_command(uuid,uuid,bigint,jsonb,jsonb) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_risk_adverse(jsonb) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_has_adverse(text,text,jsonb) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_settle_target(public.billing_command,text,text,boolean,uuid,jsonb) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_check_observation(jsonb) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_apply_command(uuid,uuid,bigint,jsonb,jsonb) OWNER TO billing_definer;
ALTER FUNCTION app_private.billing_record_risk(uuid,uuid,bigint,jsonb) OWNER TO billing_definer;
REVOKE ALL ON FUNCTION app_private.billing_json_keys(jsonb,text[]),app_private.billing_json_array(jsonb),app_private.billing_uint(jsonb),
 app_private.billing_string_ids(jsonb,text),app_private.billing_lock_charges(text,text,text[]),app_private.billing_lock_workspace(uuid),
 app_private.billing_immutable(),app_private.billing_binding_insert_guard(),app_private.billing_reference_immutable(),app_private.billing_customer_binding_immutable(),
 app_private.billing_associate_receipt(uuid,uuid,uuid),app_private.billing_revise_risk(text,text,text),app_private.billing_receive_event(jsonb),
 app_private.billing_claim_admission(),app_private.billing_finalize_admission(uuid,uuid,bigint,jsonb),app_private.billing_known_invoices(public.billing_command),
 app_private.billing_claim_command(uuid,uuid),app_private.billing_locked_command(uuid,uuid,bigint,text[]),app_private.billing_snapshot(public.billing_command,jsonb),
 app_private.billing_observe_command(uuid,uuid,bigint,jsonb,jsonb),app_private.billing_risk_adverse(jsonb),app_private.billing_has_adverse(text,text,jsonb),
 app_private.billing_settle_target(public.billing_command,text,text,boolean,uuid,jsonb),app_private.billing_check_observation(jsonb),
 app_private.billing_apply_command(uuid,uuid,bigint,jsonb,jsonb),app_private.billing_record_risk(uuid,uuid,bigint,jsonb)
 FROM PUBLIC,runtime,billing_relay,billing_worker,auth_mail_relay,auth_mail_worker;
GRANT EXECUTE ON FUNCTION app_private.billing_receive_event(jsonb) TO runtime;
GRANT EXECUTE ON FUNCTION app_private.billing_claim_admission(),app_private.billing_finalize_admission(uuid,uuid,bigint,jsonb) TO billing_relay;
GRANT EXECUTE ON FUNCTION app_private.billing_claim_command(uuid,uuid),app_private.billing_observe_command(uuid,uuid,bigint,jsonb,jsonb),
 app_private.billing_apply_command(uuid,uuid,bigint,jsonb,jsonb),app_private.billing_record_risk(uuid,uuid,bigint,jsonb) TO billing_worker;
-- END billing reconciliation forward supplement (0019)
--> statement-breakpoint
ALTER TABLE "billing_operation" DROP CONSTRAINT "billing_operation_kind";--> statement-breakpoint
ALTER TABLE "billing_operation" DROP CONSTRAINT "billing_operation_shape";--> statement-breakpoint
ALTER TABLE "billing_operation" DROP CONSTRAINT "billing_operation_result";--> statement-breakpoint
ALTER TABLE "billing_operation" ADD CONSTRAINT "billing_operation_kind" CHECK ("billing_operation"."kind" in ('CUSTOMER_CREATE','CHECKOUT_CREATE','CANCEL_AT_PERIOD_END'));--> statement-breakpoint
ALTER TABLE "billing_operation" ADD CONSTRAINT "billing_operation_shape" CHECK ((
    "billing_operation"."kind"='CUSTOMER_CREATE' and "billing_operation"."customer_id" is null and "billing_operation"."monthly_price_id" is null
      and "billing_operation"."onboarding_price_id" is null and "billing_operation"."currency" is null and "billing_operation"."monthly_unit_amount" is null
      and "billing_operation"."onboarding_unit_amount" is null and "billing_operation"."integration_identifier" is null
    or "billing_operation"."kind"='CHECKOUT_CREATE' and "billing_operation"."customer_id" ~ '^cus_[A-Za-z0-9]+$'
      and "billing_operation"."monthly_price_id" ~ '^price_[A-Za-z0-9]+$' and "billing_operation"."currency" ~ '^[a-z]{3}$'
      and "billing_operation"."monthly_unit_amount" > 0 and ("billing_operation"."onboarding_price_id" is null and "billing_operation"."onboarding_unit_amount" is null
        or "billing_operation"."onboarding_price_id" ~ '^price_[A-Za-z0-9]+$' and "billing_operation"."onboarding_unit_amount" > 0)
      and "billing_operation"."integration_identifier" ~ '^[A-Za-z][A-Za-z0-9_-]*_[A-Za-z]{8}$'
    or "billing_operation"."kind"='CANCEL_AT_PERIOD_END' and "billing_operation"."customer_id" ~ '^cus_[A-Za-z0-9]+$'
      and "billing_operation"."monthly_price_id" is null and "billing_operation"."onboarding_price_id" is null and "billing_operation"."currency" is null
      and "billing_operation"."monthly_unit_amount" is null and "billing_operation"."onboarding_unit_amount" is null and "billing_operation"."integration_identifier" is null
  ) is true);--> statement-breakpoint
ALTER TABLE "billing_operation" ADD CONSTRAINT "billing_operation_result" CHECK ((
    "billing_operation"."phase"='SUCCEEDED' and "billing_operation"."stripe_object_id" is not null
      and ("billing_operation"."kind"='CUSTOMER_CREATE' and "billing_operation"."stripe_object_id" ~ '^cus_[A-Za-z0-9]+$' and "billing_operation"."checkout_url" is null and "billing_operation"."checkout_expires_at" is null
        or "billing_operation"."kind"='CHECKOUT_CREATE' and "billing_operation"."stripe_object_id" ~ '^cs_(test|live)_[A-Za-z0-9]+$'
          and "billing_operation"."checkout_url" is not null and "billing_operation"."checkout_expires_at" > 0
        or "billing_operation"."kind"='CANCEL_AT_PERIOD_END' and "billing_operation"."stripe_object_id" ~ '^sub_[A-Za-z0-9]+$'
          and "billing_operation"."checkout_url" is null and "billing_operation"."checkout_expires_at" is null)
    or "billing_operation"."phase"<>'SUCCEEDED' and "billing_operation"."stripe_object_id" is null and "billing_operation"."checkout_url" is null and "billing_operation"."checkout_expires_at" is null
  ) is true);
--> statement-breakpoint
-- Append only to the new forward migration after its generated constraint
-- changes. Existing0018/0019, their supplements and operation contracts remain.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname='workspace_bootstrap'
    AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls
    AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication)
    OR EXISTS (SELECT FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r
      ON r.oid=m.roleid OR r.oid=m.member WHERE r.rolname='workspace_bootstrap') THEN
    RAISE EXCEPTION 'Cancellation definer prerequisites not satisfied';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION app_private.billing_admit_cancellation(p_user text,p_session text,p_workspace uuid,
  p_environment text,p_account text,p_api text,p_id uuid,p_key text,p_hash text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.billing_customer; o public.billing_operation; admitted uuid;
BEGIN
  IF NOT app_private.billing_authority(p_user,p_session,p_workspace,false) THEN RETURN NULL; END IF;
  IF NOT coalesce(p_environment IN ('sandbox','live') AND p_account ~ '^acct_[A-Za-z0-9]+$'
    AND p_api='2026-09-30.endive' AND p_id IS NOT NULL AND p_id<>'00000000-0000-0000-0000-000000000000'::uuid
    AND p_key='cancel:'||p_id::text
    AND p_hash='0f24603155ba15a8137f54f0e3afde8d9c07629a85b86968f5baa121ab06ba00',false) THEN RETURN NULL; END IF;
  -- Authority locks User -> Session -> Workspace first. Both operation slots
  -- are then locked in one deterministic order, before the fresh-clock reread.
  PERFORM x.id FROM public.billing_operation x WHERE x.workspace_id=p_workspace
    AND x.environment=p_environment AND x.account_id=p_account
    AND x.kind IN ('CHECKOUT_CREATE','CANCEL_AT_PERIOD_END') ORDER BY x.id FOR UPDATE;
  IF NOT app_private.billing_authority(p_user,p_session,p_workspace,false) THEN RETURN NULL; END IF;
  SELECT * INTO c FROM public.billing_customer WHERE workspace_id=p_workspace
    AND environment=p_environment AND account_id=p_account;
  -- Only the existing closed lineage path can set this immutable nonnull
  -- binding. Browser metadata/status/return URLs cannot establish it.
  IF c.id IS NULL OR c.known_subscription_id IS NULL OR c.known_subscription_id !~ '^sub_[A-Za-z0-9]+$'
    OR NOT EXISTS (SELECT FROM public.billing_operation x WHERE x.workspace_id=p_workspace
      AND x.environment=p_environment AND x.account_id=p_account AND x.customer_id=c.stripe_customer_id
      AND x.kind='CHECKOUT_CREATE' AND x.phase IN ('DISPATCHING','SUCCEEDED','UNKNOWN') AND x.api_version=p_api)
    THEN RETURN NULL; END IF;
  SELECT * INTO o FROM public.billing_operation WHERE workspace_id=p_workspace
    AND environment=p_environment AND account_id=p_account AND kind='CANCEL_AT_PERIOD_END';
  IF o.id IS NOT NULL THEN
    IF o.customer_id IS DISTINCT FROM c.stripe_customer_id OR o.api_version IS DISTINCT FROM p_api
      OR o.request_hash IS DISTINCT FROM p_hash OR o.idempotency_key IS DISTINCT FROM 'cancel:'||o.id::text
      THEN RETURN NULL; END IF;
    RETURN o.id;
  END IF;
  INSERT INTO public.billing_operation(id,workspace_id,kind,environment,account_id,api_version,
    idempotency_key,request_hash,customer_id)
    VALUES(p_id,p_workspace,'CANCEL_AT_PERIOD_END',p_environment,p_account,p_api,p_key,p_hash,c.stripe_customer_id)
    RETURNING id INTO admitted;
  RETURN admitted;
END $$;
ALTER FUNCTION app_private.billing_admit_cancellation(text,text,uuid,text,text,text,uuid,text,text) OWNER TO workspace_bootstrap;
REVOKE ALL ON FUNCTION app_private.billing_admit_cancellation(text,text,uuid,text,text,text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.billing_admit_cancellation(text,text,uuid,text,text,text,uuid,text,text) TO runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.billing_claim_cancellation(p_user text,p_session text,p_workspace uuid,p_id uuid,
  p_environment text,p_account text,p_subscription text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.billing_customer; o public.billing_operation;
BEGIN
  IF NOT app_private.billing_authority(p_user,p_session,p_workspace,false) THEN RETURN false; END IF;
  SELECT * INTO o FROM public.billing_operation WHERE id=p_id AND workspace_id=p_workspace FOR UPDATE;
  -- These are the same User/Session/Workspace rows already held above, never
  -- a first authority lock taken after an operation lock.
  IF NOT app_private.billing_authority(p_user,p_session,p_workspace,false) THEN RETURN false; END IF;
  IF o.id IS NULL OR NOT coalesce(o.kind='CANCEL_AT_PERIOD_END' AND o.phase='ADMITTED'
    AND o.environment=p_environment AND o.account_id=p_account AND o.api_version='2026-09-30.endive'
    AND o.idempotency_key='cancel:'||o.id::text
    AND o.request_hash='0f24603155ba15a8137f54f0e3afde8d9c07629a85b86968f5baa121ab06ba00'
    AND p_subscription ~ '^sub_[A-Za-z0-9]+$',false) THEN RETURN false; END IF;
  SELECT * INTO c FROM public.billing_customer WHERE workspace_id=p_workspace
    AND environment=o.environment AND account_id=o.account_id AND stripe_customer_id=o.customer_id;
  IF c.id IS NULL OR c.known_subscription_id IS DISTINCT FROM p_subscription
    OR NOT EXISTS (SELECT FROM public.billing_operation x WHERE x.workspace_id=p_workspace
      AND x.environment=o.environment AND x.account_id=o.account_id AND x.customer_id=o.customer_id
      AND x.kind='CHECKOUT_CREATE' AND x.phase IN ('DISPATCHING','SUCCEEDED','UNKNOWN') AND x.api_version=o.api_version)
    THEN RETURN false; END IF;
  -- Original transition/outcome function, with this row already locked and
  -- the cancellation target/fresh authority revalidated after all waits.
  RETURN app_private.billing_claim_operation(p_user,p_session,p_workspace,p_id);
END $$;
ALTER FUNCTION app_private.billing_claim_cancellation(text,text,uuid,uuid,text,text,text) OWNER TO workspace_bootstrap;
REVOKE ALL ON FUNCTION app_private.billing_claim_cancellation(text,text,uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.billing_claim_cancellation(text,text,uuid,uuid,text,text,text) TO runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.billing_complete_cancellation(p_user text,p_session text,p_workspace uuid,p_id uuid,
  p_subscription text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.billing_customer; o public.billing_operation;
BEGIN
  IF NOT app_private.billing_authority(p_user,p_session,p_workspace,false) THEN RETURN false; END IF;
  SELECT * INTO o FROM public.billing_operation WHERE id=p_id AND workspace_id=p_workspace FOR UPDATE;
  IF NOT app_private.billing_authority(p_user,p_session,p_workspace,false) THEN RETURN false; END IF;
  IF o.id IS NULL OR NOT coalesce(o.kind='CANCEL_AT_PERIOD_END' AND o.phase='DISPATCHING'
    AND o.api_version='2026-09-30.endive' AND o.idempotency_key='cancel:'||o.id::text
    AND o.request_hash='0f24603155ba15a8137f54f0e3afde8d9c07629a85b86968f5baa121ab06ba00'
    AND p_subscription ~ '^sub_[A-Za-z0-9]+$',false) THEN RETURN false; END IF;
  SELECT * INTO c FROM public.billing_customer WHERE workspace_id=p_workspace
    AND environment=o.environment AND account_id=o.account_id AND stripe_customer_id=o.customer_id;
  IF c.id IS NULL OR c.known_subscription_id IS DISTINCT FROM p_subscription
    OR NOT EXISTS (SELECT FROM public.billing_operation x WHERE x.workspace_id=p_workspace
      AND x.environment=o.environment AND x.account_id=o.account_id AND x.customer_id=o.customer_id
      AND x.kind='CHECKOUT_CREATE' AND x.phase IN ('DISPATCHING','SUCCEEDED','UNKNOWN') AND x.api_version=o.api_version)
    THEN RETURN false; END IF;
  UPDATE public.billing_operation SET phase='SUCCEEDED',stripe_object_id=p_subscription,updated_at=clock_timestamp()
    WHERE id=o.id;
  INSERT INTO public.billing_operation_outcome(operation_id,workspace_id,outcome,stripe_object_id)
    VALUES(o.id,p_workspace,'SUCCEEDED',p_subscription);
  RETURN true;
END $$;
ALTER FUNCTION app_private.billing_complete_cancellation(text,text,uuid,uuid,text) OWNER TO workspace_bootstrap;
REVOKE ALL ON FUNCTION app_private.billing_complete_cancellation(text,text,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.billing_complete_cancellation(text,text,uuid,uuid,text) TO runtime;
