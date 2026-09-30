LOCK TABLE "email_delivery" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "email_delivery" WHERE verifier_hash IS NOT NULL AND verifier_hash !~ '^[0-9a-f]{64}$')
    OR EXISTS (SELECT 1 FROM "email_delivery" WHERE verifier_hash IS NOT NULL GROUP BY verifier_hash HAVING count(*) > 1)
  THEN RAISE EXCEPTION 'Magic verifier migration preflight failed' USING ERRCODE='23514'; END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "email_delivery_verifier_unique" ON "email_delivery" USING btree ("verifier_hash") WHERE "email_delivery"."verifier_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "email_delivery" ADD CONSTRAINT "email_delivery_verifier_canonical" CHECK ("email_delivery"."verifier_hash" IS NULL OR "email_delivery"."verifier_hash" ~ '^[0-9a-f]{64}$');
