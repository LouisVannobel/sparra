-- Offline local-candidate transition: quiesce old writers before this runner.
-- The native Drizzle runner holds this lock, preflight, DDL and journal insert
-- in one transaction. Never reconcile ambiguous bindings inside a migration.
LOCK TABLE "account" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "account" GROUP BY "provider_id", "account_id" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Account provider key migration refused: duplicate binding' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "account" a LEFT JOIN "user" u ON u."id" = a."user_id"
    WHERE a."provider_id" IS DISTINCT FROM 'google'
      OR a."issuer" IS DISTINCT FROM 'https://accounts.google.com'
      OR a."id" !~ '[^[:space:]]'
      -- Exact ECMAScript String.trim whitespace used by native account-key
      -- validation; POSIX [:space:] misses e.g. BOM. This never rewrites data.
      OR btrim(a."account_id", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') = ''
      OR a."account_id" IN ('null', 'undefined')
      OR a."user_id" !~ '[^[:space:]]'
      OR u."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Account provider key migration refused: noncanonical binding' USING ERRCODE = '23514';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_provider_account_id_unique" UNIQUE("provider_id","account_id");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_provider_google" CHECK ("account"."provider_id" = 'google');--> statement-breakpoint
ALTER TABLE "account" DROP CONSTRAINT "account_issuer_account_id_unique";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "issuer";
