CREATE TABLE "sparra_knowledge_revision" (
	"workspace_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"business_name" text NOT NULL,
	"sector" text NOT NULL,
	"opening_hours" text NOT NULL,
	"services" text NOT NULL,
	"prices" text NOT NULL,
	"faq" text NOT NULL,
	"instructions" text NOT NULL,
	"transfer_destination" text,
	"saved_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "sparra_knowledge_revision_workspace_id_revision_pk" PRIMARY KEY("workspace_id","revision"),
	CONSTRAINT "sparra_revision_positive" CHECK ("sparra_knowledge_revision"."revision" > 0),
	CONSTRAINT "sparra_revision_nonzero_workspace" CHECK ("sparra_knowledge_revision"."workspace_id" <> '00000000-0000-0000-0000-000000000000'::uuid),
	CONSTRAINT "sparra_revision_business_name" CHECK (length("sparra_knowledge_revision"."business_name") + length(regexp_replace("sparra_knowledge_revision"."business_name", U&'[\0001-\FFFF]', '', 'g')) between 1 and 80 and "sparra_knowledge_revision"."business_name" = btrim("sparra_knowledge_revision"."business_name") and "sparra_knowledge_revision"."business_name" !~ U&'[\0001-\001F\007F-\009F\2028\2029]'),
	CONSTRAINT "sparra_revision_sector" CHECK ("sparra_knowledge_revision"."sector" in ('garage','controle-technique')),
	CONSTRAINT "sparra_revision_opening_hours" CHECK (length("sparra_knowledge_revision"."opening_hours") + length(regexp_replace("sparra_knowledge_revision"."opening_hours", U&'[\0001-\FFFF]', '', 'g')) <= 1000 and "sparra_knowledge_revision"."opening_hours" !~ U&'[\0001-\0008\000B\000C\000E-\001F\007F-\009F]'),
	CONSTRAINT "sparra_revision_services" CHECK (length("sparra_knowledge_revision"."services") + length(regexp_replace("sparra_knowledge_revision"."services", U&'[\0001-\FFFF]', '', 'g')) <= 2000 and "sparra_knowledge_revision"."services" !~ U&'[\0001-\0008\000B\000C\000E-\001F\007F-\009F]'),
	CONSTRAINT "sparra_revision_prices" CHECK (length("sparra_knowledge_revision"."prices") + length(regexp_replace("sparra_knowledge_revision"."prices", U&'[\0001-\FFFF]', '', 'g')) <= 1500 and "sparra_knowledge_revision"."prices" !~ U&'[\0001-\0008\000B\000C\000E-\001F\007F-\009F]'),
	CONSTRAINT "sparra_revision_faq" CHECK (length("sparra_knowledge_revision"."faq") + length(regexp_replace("sparra_knowledge_revision"."faq", U&'[\0001-\FFFF]', '', 'g')) <= 3000 and "sparra_knowledge_revision"."faq" !~ U&'[\0001-\0008\000B\000C\000E-\001F\007F-\009F]'),
	CONSTRAINT "sparra_revision_instructions" CHECK (length("sparra_knowledge_revision"."instructions") + length(regexp_replace("sparra_knowledge_revision"."instructions", U&'[\0001-\FFFF]', '', 'g')) <= 2000 and "sparra_knowledge_revision"."instructions" !~ U&'[\0001-\0008\000B\000C\000E-\001F\007F-\009F]'),
	CONSTRAINT "sparra_revision_transfer" CHECK ("sparra_knowledge_revision"."transfer_destination" is null or "sparra_knowledge_revision"."transfer_destination" ~ '^\+[1-9][0-9]{1,14}$'),
	CONSTRAINT "sparra_revision_saved_at" CHECK (isfinite("sparra_knowledge_revision"."saved_at"))
);
--> statement-breakpoint
ALTER TABLE "sparra_knowledge_revision" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sparra_knowledge_revision" ADD CONSTRAINT "sparra_knowledge_revision_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "sparra_revision_read" ON "sparra_knowledge_revision" AS PERMISSIVE FOR SELECT TO "runtime" USING ("sparra_knowledge_revision"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE POLICY "sparra_revision_insert" ON "sparra_knowledge_revision" AS PERMISSIVE FOR INSERT TO "runtime" WITH CHECK ("sparra_knowledge_revision"."workspace_id"::text = current_setting('app.tenant_id',true) and current_setting('app.tenant_id',true) <> '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
ALTER TABLE public.sparra_knowledge_revision OWNER TO workspace_owner;
ALTER TABLE public.sparra_knowledge_revision FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sparra_knowledge_revision FROM PUBLIC, runtime, workspace_bootstrap;
GRANT SELECT, INSERT ON public.sparra_knowledge_revision TO runtime;
--> statement-breakpoint
CREATE FUNCTION app_private.sparra_revision_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Activity revision is immutable' USING ERRCODE='23514';
END $$;
ALTER FUNCTION app_private.sparra_revision_immutable() OWNER TO workspace_owner;
REVOKE ALL ON FUNCTION app_private.sparra_revision_immutable() FROM PUBLIC;
CREATE TRIGGER sparra_revision_immutable BEFORE UPDATE OR DELETE ON public.sparra_knowledge_revision
FOR EACH ROW EXECUTE FUNCTION app_private.sparra_revision_immutable();
