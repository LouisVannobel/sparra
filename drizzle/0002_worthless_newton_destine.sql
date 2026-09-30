ALTER TABLE "auth_email_outbox" ADD COLUMN "admission_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_email_outbox" ADD COLUMN "admission_fence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_email_outbox" ADD COLUMN "admission_lease_until" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "auth_email_outbox" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "email_delivery" ADD COLUMN "snapshot_format" text;--> statement-breakpoint
ALTER TABLE "email_delivery" ADD COLUMN "snapshot_hash" text;--> statement-breakpoint
ALTER TABLE "email_delivery" ADD COLUMN "replay_window_seconds" integer;--> statement-breakpoint
ALTER TABLE "email_delivery" ADD COLUMN "provider_state" text DEFAULT 'unattempted' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_delivery" ADD COLUMN "provider_fence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_delivery" ADD COLUMN "provider_lease_until" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "email_delivery" ADD COLUMN "first_attempt_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "email_delivery" ADD COLUMN "replay_not_after" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "email_delivery" ADD COLUMN "queued_evidence" text;--> statement-breakpoint
ALTER TABLE "email_delivery" ADD COLUMN "plunk_email_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_email_outbox" ADD CONSTRAINT "auth_email_outbox_admission" CHECK ("auth_email_outbox"."admission_state" in ('pending','admitting','admitted','admission_unknown') and "auth_email_outbox"."admission_fence" >= 0);--> statement-breakpoint
ALTER TABLE "email_delivery" ADD CONSTRAINT "email_delivery_snapshot" CHECK (("email_delivery"."snapshot_format" is null and "email_delivery"."snapshot_hash" is null and "email_delivery"."replay_window_seconds" is null) or ("email_delivery"."snapshot_format" = 'auth-plunk-v1' and "email_delivery"."snapshot_hash" ~ '^[0-9a-f]{64}$' and ("email_delivery"."replay_window_seconds" is null or "email_delivery"."replay_window_seconds" between 1 and 600)));--> statement-breakpoint
ALTER TABLE "email_delivery" ADD CONSTRAINT "email_delivery_provider_state" CHECK ("email_delivery"."provider_state" in ('unattempted','attempting','effect_unknown','plunk_queued','held') and "email_delivery"."provider_fence" >= 0);
--> statement-breakpoint
-- Native auth-mail confinement supplement. Roles must be provisioned explicitly
-- before this migration; it never creates or repairs operator roles.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('auth_mail_owner','auth_mail_definer','auth_mail_relay','auth_mail_worker')
    AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolinherit
    AND rolcanlogin = (rolname IN ('auth_mail_relay','auth_mail_worker'))) <> 4
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid
      WHERE r.rolname IN ('auth_mail_owner','auth_mail_definer'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member
      WHERE r.rolname IN ('auth_mail_owner','auth_mail_definer','auth_mail_relay','auth_mail_worker')) THEN
    RAISE EXCEPTION 'Auth mail role prerequisites not satisfied';
  END IF;
END $$;
ALTER TABLE public.auth_email_request OWNER TO auth_mail_owner;
ALTER TABLE public.auth_email_command OWNER TO auth_mail_owner;
ALTER TABLE public.email_delivery OWNER TO auth_mail_owner;
ALTER TABLE public.auth_email_outbox OWNER TO auth_mail_owner;
GRANT USAGE ON SCHEMA public TO auth_mail_owner,auth_mail_definer,auth_mail_relay,auth_mail_worker;
GRANT SELECT,UPDATE ON public.auth_email_request,public.email_delivery,public.auth_email_outbox TO auth_mail_definer;
GRANT SELECT ON public.auth_email_command TO auth_mail_definer;
GRANT SELECT,UPDATE(id) ON public."user" TO auth_mail_definer;
REVOKE ALL ON public.auth_email_request,public.auth_email_command,public.email_delivery,public.auth_email_outbox FROM auth_mail_relay,auth_mail_worker;
--> statement-breakpoint
DROP TRIGGER auth_email_outbox_immutable ON public.auth_email_outbox;
CREATE FUNCTION public.auth_mail_outbox_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Auth mail transition rejected' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.admission_state <> 'pending' OR NEW.admission_fence <> 0 OR NEW.run_id IS NOT NULL OR NEW.admission_lease_until IS NOT NULL THEN
      RAISE EXCEPTION 'Auth mail transition rejected' USING ERRCODE='23514';
    END IF;
  ELSIF current_user <> 'auth_mail_definer' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
    OR NEW.admission_fence < OLD.admission_fence OR (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id) THEN
    RAISE EXCEPTION 'Auth mail transition rejected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.auth_mail_outbox_guard() FROM PUBLIC;
CREATE TRIGGER auth_mail_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON public.auth_email_outbox FOR EACH ROW EXECUTE FUNCTION public.auth_mail_outbox_guard();
CREATE FUNCTION public.auth_mail_delivery_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.provider_state <> 'unattempted' OR NEW.provider_fence <> 0 OR NEW.first_attempt_at IS NOT NULL OR NEW.replay_not_after IS NOT NULL
      OR NEW.provider_lease_until IS NOT NULL OR NEW.queued_evidence IS NOT NULL OR NEW.plunk_email_id IS NOT NULL THEN
      RAISE EXCEPTION 'Auth mail transition rejected' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.snapshot_format IS DISTINCT FROM OLD.snapshot_format OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
      OR NEW.replay_window_seconds IS DISTINCT FROM OLD.replay_window_seconds
      OR (OLD.first_attempt_at IS NOT NULL AND NEW.first_attempt_at IS DISTINCT FROM OLD.first_attempt_at)
      OR (OLD.first_attempt_at IS NOT NULL AND NEW.replay_not_after IS DISTINCT FROM OLD.replay_not_after)
      OR (ROW(NEW.provider_state,NEW.provider_fence,NEW.provider_lease_until,NEW.first_attempt_at,NEW.replay_not_after,NEW.queued_evidence,NEW.plunk_email_id)
        IS DISTINCT FROM ROW(OLD.provider_state,OLD.provider_fence,OLD.provider_lease_until,OLD.first_attempt_at,OLD.replay_not_after,OLD.queued_evidence,OLD.plunk_email_id)
        AND current_user <> 'auth_mail_definer') THEN
      RAISE EXCEPTION 'Auth mail transition rejected' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.auth_mail_delivery_guard() FROM PUBLIC;
CREATE TRIGGER auth_mail_delivery_guard BEFORE INSERT OR UPDATE ON public.email_delivery FOR EACH ROW EXECUTE FUNCTION public.auth_mail_delivery_guard();
--> statement-breakpoint
-- Internal operation, no login can execute it. One lock order everywhere:
-- bound User -> Request -> Delivery -> Outbox, then authoritative DB time.
CREATE FUNCTION public.auth_mail_locked(p_id uuid)
RETURNS TABLE(command public.auth_email_command,delivery public.email_delivery,outbox public.auth_email_outbox,authorized boolean,observed_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.auth_email_request; u public."user"; valid_user boolean := true;
BEGIN
  IF current_setting('app.tenant_id',true) IS DISTINCT FROM '00000000-0000-0000-0000-000000000000' THEN RETURN; END IF;
  SELECT c.* INTO command FROM public.auth_email_command c JOIN public.email_delivery d ON d.command_id=c.id
    JOIN public.auth_email_outbox o ON o.delivery_id=d.id WHERE o.id=p_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF command.user_id IS NOT NULL THEN
    SELECT * INTO u FROM public."user" WHERE id=command.user_id FOR UPDATE;
    valid_user := FOUND AND NOT u.recovering AND u.recovery_generation=command.recovery_generation AND lower(btrim(u.email))=command.recipient;
  END IF;
  SELECT * INTO r FROM public.auth_email_request WHERE id=command.request_id FOR UPDATE;
  SELECT * INTO delivery FROM public.email_delivery WHERE command_id=command.id FOR UPDATE;
  SELECT * INTO outbox FROM public.auth_email_outbox WHERE id=p_id FOR UPDATE;
  observed_at := clock_timestamp();
  authorized := coalesce(valid_user AND r.generation=command.generation AND r.state='active' AND r.user_id IS NOT DISTINCT FROM command.user_id
    AND r.email=command.recipient AND r.purpose=command.purpose AND command.purpose='magic-link' AND command.expires_at>observed_at AND delivery.state='active',false);
  IF NOT authorized THEN
    UPDATE public.email_delivery SET ciphertext=NULL,nonce=NULL,tag=NULL,verifier_hash=NULL,
      state=CASE WHEN state <> 'active' THEN state WHEN command.expires_at<=observed_at THEN 'expired' WHEN r.state='consumed' THEN 'consumed' ELSE 'superseded' END
      WHERE id=delivery.id RETURNING * INTO delivery;
  END IF;
  RETURN NEXT;
END $$;
ALTER FUNCTION public.auth_mail_locked(uuid) OWNER TO auth_mail_definer;
REVOKE ALL ON FUNCTION public.auth_mail_locked(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.auth_mail_claim_admission() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE candidate uuid; s record;
BEGIN
  IF current_setting('app.tenant_id',true) IS DISTINCT FROM '00000000-0000-0000-0000-000000000000' THEN RETURN NULL; END IF;
  FOR candidate IN SELECT id FROM public.auth_email_outbox WHERE admission_state='pending'
    OR (admission_state='admitting' AND admission_lease_until<=clock_timestamp()) ORDER BY id LIMIT 100 LOOP
    SELECT * INTO s FROM public.auth_mail_locked(candidate);
    IF s.outbox IS NULL THEN CONTINUE; END IF;
    IF (s.outbox).admission_state='admitting' AND (s.outbox).admission_lease_until<=s.observed_at THEN
      UPDATE public.auth_email_outbox SET admission_state='admission_unknown',admission_lease_until=NULL WHERE id=candidate;
      CONTINUE;
    END IF;
    IF NOT s.authorized OR (s.delivery).snapshot_format IS DISTINCT FROM 'auth-plunk-v1' OR (s.delivery).ciphertext IS NULL
      OR (s.delivery).provider_state IN ('held','plunk_queued') THEN
      IF (s.outbox).admission_state='pending' THEN UPDATE public.auth_email_outbox SET admission_state='admission_unknown' WHERE id=candidate; END IF;
      CONTINUE;
    END IF;
    IF (s.outbox).admission_state='pending' THEN
      UPDATE public.auth_email_outbox SET admission_state='admitting',admission_fence=admission_fence+1,
        admission_lease_until=least((s.command).expires_at,s.observed_at+interval '30 seconds') WHERE id=candidate;
      RETURN jsonb_build_object('outboxId',candidate,'fence',(s.outbox).admission_fence+1);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
ALTER FUNCTION public.auth_mail_claim_admission() OWNER TO auth_mail_definer;
REVOKE ALL ON FUNCTION public.auth_mail_claim_admission() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_mail_claim_admission() TO auth_mail_relay;
CREATE FUNCTION public.auth_mail_finalize_admission(p_id uuid,p_fence integer,p_run uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE s record;
BEGIN
  IF p_fence IS NULL OR p_fence <= 0 THEN RETURN false; END IF;
  SELECT * INTO s FROM public.auth_mail_locked(p_id);
  IF s.outbox IS NULL OR (s.outbox).admission_state<>'admitting' OR (s.outbox).admission_fence IS DISTINCT FROM p_fence OR (s.outbox).admission_lease_until<=s.observed_at THEN RETURN false; END IF;
  UPDATE public.auth_email_outbox SET admission_state=CASE WHEN p_run IS NULL THEN 'admission_unknown' ELSE 'admitted' END,
    run_id=p_run,admission_lease_until=NULL WHERE id=p_id;
  RETURN true;
END $$;
ALTER FUNCTION public.auth_mail_finalize_admission(uuid,integer,uuid) OWNER TO auth_mail_definer;
REVOKE ALL ON FUNCTION public.auth_mail_finalize_admission(uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_mail_finalize_admission(uuid,integer,uuid) TO auth_mail_relay;
--> statement-breakpoint
CREATE FUNCTION public.auth_mail_claim_delivery(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE s record; d public.email_delivery;
BEGIN
  SELECT * INTO s FROM public.auth_mail_locked(p_id);
  IF s.delivery IS NULL OR NOT s.authorized THEN RETURN NULL; END IF;
  d := s.delivery;
  IF d.snapshot_format IS DISTINCT FROM 'auth-plunk-v1' OR d.ciphertext IS NULL OR d.provider_state IN ('plunk_queued','held') THEN RETURN NULL; END IF;
  IF d.provider_lease_until>s.observed_at THEN RETURN NULL; END IF;
  IF d.first_attempt_at IS NOT NULL AND (d.replay_not_after IS NULL OR d.replay_not_after<=s.observed_at) THEN
    UPDATE public.email_delivery SET provider_state='held',ciphertext=NULL,nonce=NULL,tag=NULL,provider_lease_until=NULL WHERE id=d.id;
    RETURN NULL;
  END IF;
  UPDATE public.email_delivery SET provider_state='attempting',provider_fence=provider_fence+1,
    provider_lease_until=least((s.command).expires_at,s.observed_at+interval '15 seconds',
      CASE WHEN d.first_attempt_at IS NULL THEN (s.command).expires_at ELSE d.replay_not_after END),
    first_attempt_at=coalesce(first_attempt_at,s.observed_at),
    replay_not_after=CASE WHEN first_attempt_at IS NOT NULL THEN replay_not_after WHEN replay_window_seconds IS NULL THEN NULL
      ELSE least((s.command).expires_at,s.observed_at+make_interval(secs=>replay_window_seconds)) END
    WHERE id=d.id RETURNING * INTO d;
  RETURN jsonb_build_object('outboxId',p_id,'deliveryId',d.id,'fence',d.provider_fence,'format',d.snapshot_format,'hash',d.snapshot_hash,
    'keyId',d.key_id,'ciphertext',d.ciphertext,'nonce',d.nonce,'tag',d.tag,'purpose',(s.command).purpose,'generation',(s.command).generation,
    'expiresAt',(s.command).expires_at,'databaseTime',s.observed_at,'leaseUntil',d.provider_lease_until,
    'replayNotAfter',d.replay_not_after,'replayWindowSeconds',d.replay_window_seconds);
END $$;
ALTER FUNCTION public.auth_mail_claim_delivery(uuid) OWNER TO auth_mail_definer;
REVOKE ALL ON FUNCTION public.auth_mail_claim_delivery(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_mail_claim_delivery(uuid) TO auth_mail_worker;
CREATE FUNCTION public.auth_mail_finalize_delivery(p_id uuid,p_fence integer,p_state text,p_evidence text,p_email uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE s record;
BEGIN
  IF p_fence IS NULL OR p_fence <= 0 THEN RETURN false; END IF;
  IF ((p_state='effect_unknown' AND p_evidence IS NULL AND p_email IS NULL)
    OR (p_state='held' AND p_evidence IS NULL AND p_email IS NULL)
    OR (p_state='plunk_queued' AND ((p_evidence='response_200' AND p_email IS NOT NULL) OR (p_evidence='duplicate_409' AND p_email IS NULL)))) IS NOT TRUE THEN RETURN false; END IF;
  SELECT * INTO s FROM public.auth_mail_locked(p_id);
  IF s.delivery IS NULL OR NOT s.authorized OR (s.delivery).provider_state<>'attempting'
    OR (s.delivery).provider_fence IS DISTINCT FROM p_fence OR (s.delivery).provider_lease_until<=s.observed_at THEN RETURN false; END IF;
  UPDATE public.email_delivery SET provider_state=p_state,provider_lease_until=NULL,queued_evidence=p_evidence,plunk_email_id=p_email,
    ciphertext=CASE WHEN p_state IN ('plunk_queued','held') THEN NULL ELSE ciphertext END,
    nonce=CASE WHEN p_state IN ('plunk_queued','held') THEN NULL ELSE nonce END,
    tag=CASE WHEN p_state IN ('plunk_queued','held') THEN NULL ELSE tag END WHERE id=(s.delivery).id;
  RETURN true;
END $$;
ALTER FUNCTION public.auth_mail_finalize_delivery(uuid,integer,text,text,uuid) OWNER TO auth_mail_definer;
REVOKE ALL ON FUNCTION public.auth_mail_finalize_delivery(uuid,integer,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_mail_finalize_delivery(uuid,integer,text,text,uuid) TO auth_mail_worker;
CREATE FUNCTION public.auth_mail_purge() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE candidate uuid; s record; count integer := 0;
BEGIN
  IF current_setting('app.tenant_id',true) IS DISTINCT FROM '00000000-0000-0000-0000-000000000000' THEN RETURN 0; END IF;
  FOR candidate IN SELECT o.id FROM public.auth_email_outbox o JOIN public.email_delivery d ON d.id=o.delivery_id JOIN public.auth_email_command c ON c.id=d.command_id
    WHERE (c.expires_at<=clock_timestamp() AND (d.ciphertext IS NOT NULL OR d.verifier_hash IS NOT NULL))
      OR (d.ciphertext IS NOT NULL AND d.first_attempt_at IS NOT NULL AND d.provider_state IN ('attempting','effect_unknown')
        AND (d.provider_lease_until IS NULL OR d.provider_lease_until<=clock_timestamp()) AND (d.replay_not_after IS NULL OR d.replay_not_after<=clock_timestamp()))
    ORDER BY c.expires_at,o.id LIMIT 100 LOOP
    SELECT * INTO s FROM public.auth_mail_locked(candidate);
    IF s.authorized AND (s.delivery).provider_state IN ('attempting','effect_unknown')
      AND ((s.delivery).provider_lease_until IS NULL OR (s.delivery).provider_lease_until<=s.observed_at)
      AND ((s.delivery).replay_not_after IS NULL OR (s.delivery).replay_not_after<=s.observed_at) THEN
      UPDATE public.email_delivery SET provider_state='held',provider_lease_until=NULL,ciphertext=NULL,nonce=NULL,tag=NULL WHERE id=(s.delivery).id;
    END IF;
    count := count+1;
  END LOOP;
  RETURN count;
END $$;
ALTER FUNCTION public.auth_mail_purge() OWNER TO auth_mail_definer;
REVOKE ALL ON FUNCTION public.auth_mail_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_mail_purge() TO auth_mail_worker;
