CREATE TABLE "sparra_calendar_command" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"call_id" uuid,
	"deployment_id" text,
	"kind" text NOT NULL,
	"request" jsonb,
	"digest" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"policy_revision" integer NOT NULL,
	"google_subject" text NOT NULL,
	"calendar_id" text NOT NULL,
	"policy" jsonb,
	"service_id" text NOT NULL,
	"service_name" text NOT NULL,
	"window_start" timestamp (3) with time zone NOT NULL,
	"window_end" timestamp (3) with time zone NOT NULL,
	"offer_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"fence" bigint DEFAULT 0 NOT NULL,
	"lease_until" timestamp (3) with time zone,
	"retry_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"first_send_deadline" timestamp (3) with time zone NOT NULL,
	"possible_send_fence" bigint,
	"event_id" text,
	"current_start" timestamp (3) with time zone,
	"current_end" timestamp (3) with time zone,
	"observed_state" text,
	"observed_at" timestamp (3) with time zone,
	"result" jsonb,
	CONSTRAINT "calendar_command_kind" CHECK ("sparra_calendar_command"."kind" in ('find_slots','book_appointment')),
	CONSTRAINT "calendar_command_state" CHECK ("sparra_calendar_command"."state" in ('waiting_evidence',
    'pending','running','offered','confirmed','refused','unknown')),
	CONSTRAINT "calendar_command_bounds" CHECK (isfinite("sparra_calendar_command"."window_start") and
    isfinite("sparra_calendar_command"."window_end") and
    "sparra_calendar_command"."window_start"<"sparra_calendar_command"."window_end" and
    "sparra_calendar_command"."fence">=0)
);
--> statement-breakpoint
ALTER TABLE "sparra_calendar_command" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "sparra_calendar_offer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"deployment_id" text NOT NULL,
	"start" timestamp (3) with time zone NOT NULL,
	"end" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "calendar_offer_bounds" CHECK (isfinite("sparra_calendar_offer"."start") and
    isfinite("sparra_calendar_offer"."end") and "sparra_calendar_offer"."start"<"sparra_calendar_offer"."end"
    and isfinite("sparra_calendar_offer"."expires_at"))
);
--> statement-breakpoint
ALTER TABLE "sparra_calendar_offer" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "calendar_command_ready" ON "sparra_calendar_command" USING btree ("retry_at");
--> statement-breakpoint
CREATE POLICY "calendar_command_owner" ON "sparra_calendar_command" AS PERMISSIVE FOR SELECT TO "runtime"
    USING ("sparra_calendar_command"."workspace_id"::text=current_setting('app.tenant_id',true));
--> statement-breakpoint
CREATE POLICY "calendar_command_voice" ON "sparra_calendar_command" AS PERMISSIVE FOR ALL TO
    "sparra_voice_definer" USING ("sparra_calendar_command"."workspace_id"=voice_private.bound_workspace()
    and "sparra_calendar_command"."deployment_id"=voice_private.bound_deployment()) WITH CHECK
    ("sparra_calendar_command"."workspace_id"=voice_private.bound_workspace() and
    "sparra_calendar_command"."deployment_id"=voice_private.bound_deployment());
--> statement-breakpoint
CREATE POLICY "calendar_command_worker" ON "sparra_calendar_command" AS PERMISSIVE FOR ALL TO
    "calendar_definer" USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "calendar_offer_voice" ON "sparra_calendar_offer" AS PERMISSIVE FOR SELECT TO
    "sparra_voice_definer" USING ("sparra_calendar_offer"."workspace_id"=voice_private.bound_workspace() and
    "sparra_calendar_offer"."deployment_id"=voice_private.bound_deployment());
--> statement-breakpoint
CREATE POLICY "calendar_offer_worker" ON "sparra_calendar_offer" AS PERMISSIVE FOR ALL TO "calendar_definer"
    USING (true) WITH CHECK (true);
--> statement-breakpoint
-- Native Calendar authority. Roles are provisioned by the operator, never by runtime.
DO $$BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('calendar_worker','calendar_definer')
    AND rolcanlogin=(rolname='calendar_worker')
    AND NOT rolinherit
    AND NOT rolsuper
    AND NOT rolbypassrls
    AND NOT rolcreatedb
    AND NOT rolcreaterole
    AND NOT rolreplication)<>2
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member
    OR r.oid=m.roleid WHERE r.rolname IN ('calendar_worker','calendar_definer')) THEN
    RAISE EXCEPTION 'Calendar role prerequisites unavailable';
  END IF;
END$$;
ALTER TABLE public.sparra_calendar_connection OWNER TO workspace_owner;
ALTER TABLE public.sparra_calendar_command OWNER TO workspace_owner;
ALTER TABLE public.sparra_calendar_offer OWNER TO workspace_owner;
ALTER TABLE public.sparra_calendar_command FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sparra_calendar_offer FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sparra_calendar_command,public.sparra_calendar_offer FROM PUBLIC,calendar_worker;
GRANT USAGE ON SCHEMA app_private,public TO calendar_definer;
GRANT USAGE ON SCHEMA voice TO sparra_voice_definer;
GRANT USAGE ON SCHEMA app_private TO calendar_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.sparra_calendar_command,public.sparra_calendar_offer TO calendar_definer;
GRANT SELECT ON public.sparra_calendar_connection,public.sparra_call TO calendar_definer;
GRANT UPDATE(work_id,work_expires_at,token_envelope,status,enabled,policy_revision) ON
    public.sparra_calendar_connection TO calendar_definer;
GRANT SELECT(id,lifecycle),UPDATE(id) ON public.workspace TO calendar_definer;
GRANT SELECT ON public.sparra_calendar_command TO runtime;
GRANT SELECT,INSERT ON public.sparra_calendar_command TO sparra_voice_definer;
GRANT UPDATE(state,current_start,current_end) ON public.sparra_calendar_command TO sparra_voice_definer;
GRANT SELECT ON public.sparra_calendar_offer TO sparra_voice_definer;
GRANT SELECT(id,workspace_id,generation,status,google_subject,policy_revision,policy,calendar_id,enabled) ON
    public.sparra_calendar_connection TO sparra_voice_definer;
-- Private helpers run only underneath their narrow, execute-only public entrypoints.

CREATE FUNCTION voice_private.calendar_call(cid uuid) RETURNS public.sparra_call LANGUAGE plpgsql SET
    search_path=pg_catalog,pg_temp AS $$
DECLARE b voice_private.deployment_binding;
c public.sparra_call;
BEGIN
  b=voice_private.lock_binding();
  SELECT * INTO c FROM public.sparra_call WHERE id=cid
    AND workspace_id=b.workspace_id
    AND deployment_id=b.deployment_id
    AND configuration_revision IS NOT NULL
    AND retention_until>clock_timestamp()
    AND erasure_requested_at IS NULL;
  IF NOT FOUND
    OR NOT b.admission_enabled
    OR NOT EXISTS(SELECT 1 FROM public.workspace WHERE id=b.workspace_id
    AND lifecycle='active') THEN
    RAISE EXCEPTION 'Calendar call unavailable' USING ERRCODE='PV202';
  END IF;
  RETURN c;
END$$;

CREATE FUNCTION voice.calendar_catalog_v1(cid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET
    search_path=pg_catalog,pg_temp AS $$
DECLARE c public.sparra_call;
n record;
BEGIN
  c=voice_private.calendar_call(cid);
  SELECT policy,policy_revision INTO n FROM public.sparra_calendar_connection WHERE workspace_id=c.workspace_id
    AND enabled
    AND status='connected';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object('schema_version',1,'call_id',cid,'policy_revision',n.policy_revision,'timezone',
  n.policy->>'timeZone','services',(SELECT jsonb_agg(jsonb_build_object('service_id',s->>'id','name',
  s->>'name','duration_minutes',s->'durationMinutes')) FROM jsonb_array_elements(n.policy->'services') s));
END$$;

CREATE FUNCTION voice.calendar_result_v1(cid uuid,op uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.sparra_call;
q public.sparra_calendar_command;
BEGIN
  c=voice_private.calendar_call(cid);
  SELECT * INTO q FROM public.sparra_calendar_command WHERE id=op
    AND call_id=cid
    AND workspace_id=c.workspace_id
    AND deployment_id=c.deployment_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state','missing','operationId',op);
  END IF;
  RETURN jsonb_build_object('state',q.state,'operationId',q.id)||coalesce(q.result,'{}'::jsonb);
END$$;

CREATE FUNCTION voice.calendar_submit_v1(cid uuid,op uuid,p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY
    DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.sparra_call;
n record;
q public.sparra_calendar_command;
o public.sparra_calendar_offer;
source public.sparra_calendar_command;
s jsonb;
kind text;
digest text;
a timestamptz;
z timestamptz;
cf jsonb;
recap jsonb;
answer jsonb;
ack timestamptz;
recap_id uuid;
answer_id uuid;
waiting boolean=false;
BEGIN
  c=voice_private.calendar_call(cid);
  IF op IS NULL
    OR octet_length(p::text)>4096 THEN
    RAISE EXCEPTION 'Calendar command invalid' USING ERRCODE='PV202';
  END IF;
  kind=voice_private.string_value(p->'kind',32);
  IF kind='find_slots' THEN
    PERFORM voice_private.object_keys(p,ARRAY['kind','serviceId','policyRevision','windowStart','windowEnd']);
    PERFORM voice_private.integer_value(p->'policyRevision',1,2147483647);
    PERFORM voice_private.string_value(p->'serviceId',80);
    a=voice_private.instant(p->'windowStart');
    z=voice_private.instant(p->'windowEnd');
    IF a>=z
      OR z-a>interval '30 days'
      OR z>clock_timestamp()+interval '30 days'
      OR z<=clock_timestamp() THEN
      RAISE EXCEPTION 'Calendar window invalid' USING ERRCODE='PV202';
    END IF;
  ELSIF kind='book_appointment' THEN
    PERFORM voice_private.object_keys(p,ARRAY['kind','offerId','confirmation']);
    PERFORM voice_private.uuid_value(p->'offerId');
    cf=p->'confirmation';
    PERFORM voice_private.object_keys(cf,ARRAY['recapTurnId','confirmationTurnId','playbackMark','playbackAcknowledgedAt']);
    recap_id=voice_private.uuid_value(cf->'recapTurnId');
    answer_id=voice_private.uuid_value(cf->'confirmationTurnId');
    ack=voice_private.instant(cf->'playbackAcknowledgedAt');
    IF voice_private.string_value(cf->'playbackMark',128) !~ '^sparra-calendar-recap-[0-9a-f-]{36}$'
      OR recap_id=answer_id THEN
      RAISE EXCEPTION 'Calendar confirmation invalid' USING ERRCODE='PV202';
    END IF;
    ELSE RAISE EXCEPTION 'Calendar kind invalid' USING ERRCODE='PV202';
  END IF;
  digest=encode(sha256(convert_to(p::text,'UTF8')),'hex');
  SELECT * INTO q FROM public.sparra_calendar_command WHERE id=op
    AND call_id=cid;
  IF FOUND THEN
    IF q.digest<>digest THEN
      RAISE EXCEPTION 'Calendar replay conflict' USING ERRCODE='PV202';
    END IF;
    IF q.state<>'waiting_evidence' THEN
      RETURN voice.calendar_result_v1(cid,op);
    END IF;
  END IF;
  SELECT id,workspace_id,generation,status,google_subject,policy_revision,policy,calendar_id,enabled INTO n
  FROM public.sparra_calendar_connection WHERE workspace_id=c.workspace_id
    AND enabled
    AND status='connected';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Calendar disabled' USING ERRCODE='PV202';
  END IF;
  IF kind='find_slots' THEN
    IF n.policy_revision<>(p->>'policyRevision')::int THEN
      RAISE EXCEPTION 'Calendar policy changed' USING ERRCODE='PV202';
    END IF;
    SELECT value INTO s FROM jsonb_array_elements(n.policy->'services') WHERE value->>'id'=p->>'serviceId';
    IF s IS NULL THEN
      RAISE EXCEPTION 'Calendar service unavailable' USING ERRCODE='PV202';
    END IF;
    ELSE SELECT * INTO o FROM public.sparra_calendar_offer WHERE id=(p->>'offerId')::uuid
      AND call_id=cid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Calendar offer unavailable' USING ERRCODE='PV202';
    END IF;
    SELECT * INTO source FROM public.sparra_calendar_command WHERE id=o.command_id;
    SELECT * INTO q FROM public.sparra_calendar_command existing WHERE call_id=cid
      AND existing.kind='book_appointment'
      AND existing.state<>'waiting_evidence'
      AND service_id=source.service_id
      AND window_start=o.start
      AND window_end=o."end" ORDER BY created_at LIMIT 1;
    IF FOUND THEN
      RETURN voice.calendar_result_v1(cid,q.id);
    END IF;
    IF o.expires_at<=clock_timestamp()
      OR o.start<clock_timestamp()+make_interval(mins=>(n.policy->>'noticeMinutes')::int)
      OR ROW(n.id,n.generation,n.policy_revision,n.google_subject,n.calendar_id) IS DISTINCT FROM
    ROW(source.connection_id,source.generation,source.policy_revision,source.google_subject,source.calendar_id) THEN
      RAISE EXCEPTION 'Calendar offer expired' USING ERRCODE='PV202';
    END IF;
    recap=c.encrypted_turns->recap_id::text;
    answer=c.encrypted_turns->answer_id::text;
    IF recap IS NULL
      OR answer IS NULL THEN
      waiting=true;
      ELSE IF recap->>'role'<>'assistant'
        OR answer->>'role'<>'user'
        OR recap->>'source'<>'pipecat_assistant'
        OR answer->>'source'<>'stt_final'
        OR recap->>'interrupted'<>'false'
        OR answer->>'interrupted'<>'false'
        OR (recap->>'turn_no')::bigint >= (answer->>'turn_no')::bigint
        OR voice_private.instant(recap->'ended_at')>ack
        OR ack>voice_private.instant(answer->'started_at')
        OR ack<source.created_at
        OR ack>clock_timestamp()
        OR voice_private.instant(answer->'ended_at')>clock_timestamp()
        OR EXISTS(SELECT 1 FROM jsonb_each(c.encrypted_turns) t WHERE
      (t.value->>'turn_no')::bigint>(recap->>'turn_no')::bigint
        AND (t.value->>'turn_no')::bigint<(answer->>'turn_no')::bigint) THEN
      RAISE EXCEPTION 'Calendar confirmation invalid' USING ERRCODE='PV202';
    END IF;
  END IF;
  a=o.start;
  z=o."end";
  s=jsonb_build_object('id',source.service_id,'name',source.service_name);
  IF NOT waiting
    AND EXISTS(SELECT 1 FROM public.sparra_calendar_command reserved WHERE reserved.workspace_id=c.workspace_id
    AND reserved.kind='book_appointment'
    AND reserved.state IN ('pending','running','unknown')
    AND reserved.current_start<z+make_interval(mins=>(n.policy->>'bufferMinutes')::int)
    AND reserved.current_end>a) THEN
    RAISE EXCEPTION 'Calendar interval reserved' USING ERRCODE='PV202';
  END IF;
END IF;
INSERT INTO public.sparra_calendar_command(id,workspace_id,call_id,deployment_id,kind,request,digest,
connection_id,generation,policy_revision,google_subject,calendar_id,policy,service_id,service_name,
window_start,window_end,offer_id,first_send_deadline,event_id,current_start,current_end,state)
VALUES(op,c.workspace_id,cid,c.deployment_id,kind,p,digest,n.id,n.generation,n.policy_revision,
n.google_subject,n.calendar_id,n.policy,s->>'id',s->>'name',a,z,CASE WHEN kind='book_appointment' THEN
o.id END,clock_timestamp()+interval '30 seconds',CASE WHEN kind='book_appointment' THEN
'sparra'||replace(op::text,'-','') END,CASE WHEN kind='book_appointment'
  AND NOT waiting THEN
a END,CASE WHEN kind='book_appointment'
  AND NOT waiting THEN
z+make_interval(mins=>(n.policy->>'bufferMinutes')::int) END,CASE WHEN waiting THEN 'waiting_evidence'
ELSE 'pending' END)
ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,current_start=EXCLUDED.current_start,
current_end=EXCLUDED.current_end WHERE public.sparra_calendar_command.state='waiting_evidence'
  AND public.sparra_calendar_command.digest=EXCLUDED.digest
  AND public.sparra_calendar_command.call_id=cid;
IF NOT FOUND THEN
  RAISE EXCEPTION 'Calendar replay conflict' USING ERRCODE='PV202';
END IF;
RETURN jsonb_build_object('state',CASE WHEN waiting THEN 'waiting_evidence'
ELSE 'pending' END,'operationId',op);
END$$;
ALTER FUNCTION voice_private.calendar_call(uuid) OWNER TO sparra_voice_definer;
REVOKE ALL ON FUNCTION voice_private.calendar_call(uuid) FROM PUBLIC;
ALTER FUNCTION voice.calendar_catalog_v1(uuid) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice.calendar_submit_v1(uuid,uuid,jsonb) OWNER TO sparra_voice_definer;
ALTER FUNCTION voice.calendar_result_v1(uuid,uuid) OWNER TO sparra_voice_definer;
REVOKE ALL ON FUNCTION voice.calendar_catalog_v1(uuid),voice.calendar_submit_v1(uuid,uuid,jsonb),
    voice.calendar_result_v1(uuid,uuid) FROM PUBLIC,runtime,calendar_worker;

--> statement-breakpoint

CREATE FUNCTION app_private.calendar_view_v1(q public.sparra_calendar_command) RETURNS jsonb LANGUAGE sql
    STABLE SET search_path=pg_catalog,pg_temp AS $$
SELECT jsonb_build_object('id',q.id,'workspaceId',q.workspace_id,'callId',q.call_id,'kind',q.kind,
'connectionId',q.connection_id,'generation',q.generation,'policyRevision',q.policy_revision,
'googleSubject',q.google_subject,'calendarId',q.calendar_id,'policy',q.policy,'serviceId',q.service_id,
'serviceName',q.service_name,'windowStart',q.window_start,'windowEnd',q.window_end,'state',q.state,
'fence',q.fence,'leaseUntil',q.lease_until,'firstSendDeadline',q.first_send_deadline,'possibleSendFence',
q.possible_send_fence,'eventId',q.event_id,'createdAt',q.created_at,'result',q.result)
$$;

CREATE FUNCTION app_private.calendar_read_v1(op uuid,f bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY
    DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE q public.sparra_calendar_command;
token text;
BEGIN
  SELECT * INTO q FROM public.sparra_calendar_command WHERE id=op
    AND fence=f
    AND f>0;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT token_envelope INTO token FROM public.sparra_calendar_connection WHERE id=q.connection_id
    AND workspace_id=q.workspace_id
    AND generation=q.generation
    AND google_subject=q.google_subject
    AND calendar_id=q.calendar_id
    AND status='connected';
  RETURN app_private.calendar_view_v1(q)||jsonb_build_object('tokenEnvelope',token,'blockers',coalesce((SELECT
  jsonb_agg(jsonb_build_object('id',b.id,'eventId',b.event_id,'calendarId',b.calendar_id,'googleSubject',
  b.google_subject,'state',b.state,'start',b.current_start,'end',b.current_end,'observedState',
  b.observed_state)) FROM public.sparra_calendar_command b WHERE b.workspace_id=q.workspace_id
    AND b.id<>q.id
    AND b.kind='book_appointment'
    AND b.state IN ('pending','running','unknown','confirmed')
    AND b.observed_state IS DISTINCT FROM 'cancelled'
    AND b.current_start<q.window_end+make_interval(mins=>(q.policy->>'bufferMinutes')::int)
    AND b.current_end>q.window_start),'[]'::jsonb));
END$$;

CREATE FUNCTION app_private.calendar_claim_v1() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET
    search_path=pg_catalog,pg_temp AS $$
DECLARE q public.sparra_calendar_command;
BEGIN
  SELECT * INTO q FROM public.sparra_calendar_command WHERE state IN ('pending','running','unknown')
    AND retry_at<=clock_timestamp()
    AND (lease_until IS NULL
    OR lease_until<clock_timestamp()) ORDER BY retry_at,created_at LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM id FROM public.workspace WHERE id=q.workspace_id FOR UPDATE;
  SELECT * INTO q FROM public.sparra_calendar_command WHERE id=q.id
    AND state IN ('pending','running','unknown')
    AND (lease_until IS NULL
    OR lease_until<clock_timestamp()) FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  UPDATE public.sparra_calendar_command SET fence=fence+1,lease_until=clock_timestamp()+interval '30 seconds',
  state=CASE WHEN possible_send_fence IS NULL THEN 'running'
  ELSE 'unknown' END WHERE id=q.id RETURNING * INTO q;
  RETURN app_private.calendar_read_v1(q.id,q.fence);
END$$;

CREATE FUNCTION app_private.calendar_prepare_create_v1(op uuid,f bigint) RETURNS boolean LANGUAGE plpgsql
    SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE q public.sparra_calendar_command;
n public.sparra_calendar_connection;
BEGIN
  SELECT * INTO q FROM public.sparra_calendar_command WHERE id=op
    AND fence=f;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM id FROM public.workspace WHERE id=q.workspace_id
    AND lifecycle='active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT * INTO q FROM public.sparra_calendar_command WHERE id=op
    AND fence=f FOR UPDATE;
  IF NOT FOUND
    OR q.kind<>'book_appointment'
    OR q.state<>'running'
    OR q.possible_send_fence IS NOT NULL
    OR q.lease_until<=clock_timestamp()
    OR q.first_send_deadline<=clock_timestamp() THEN
    RETURN false;
  END IF;
  IF q.window_start<clock_timestamp()+make_interval(mins=>(q.policy->>'noticeMinutes')::int) THEN
    RETURN false;
  END IF;
  SELECT * INTO n FROM public.sparra_calendar_connection WHERE id=q.connection_id
    AND workspace_id=q.workspace_id;
  IF NOT FOUND
    OR NOT n.enabled
    OR n.status<>'connected'
    OR ROW(n.generation,n.policy_revision,n.calendar_id,n.google_subject) IS DISTINCT FROM ROW(q.generation,
  q.policy_revision,q.calendar_id,q.google_subject)
    OR NOT EXISTS(SELECT 1 FROM public.sparra_call WHERE id=q.call_id
    AND workspace_id=q.workspace_id
    AND erasure_requested_at IS NULL
    AND retention_until>clock_timestamp()) THEN
    RETURN false;
  END IF;
  IF EXISTS(SELECT 1 FROM public.sparra_calendar_command b WHERE b.workspace_id=q.workspace_id
    AND b.id<>q.id
    AND b.kind='book_appointment'
    AND b.state IN ('pending','running','unknown','confirmed')
    AND b.observed_state IS DISTINCT FROM 'cancelled'
    AND b.current_start<q.current_end
    AND b.current_end>q.current_start) THEN
    RETURN false;
  END IF;
  UPDATE public.sparra_calendar_command SET possible_send_fence=f,state='unknown' WHERE id=op;
  RETURN true;
END$$;

CREATE FUNCTION app_private.calendar_observe_v1(op uuid,f bigint,booking uuid,p jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE q public.sparra_calendar_command;
b public.sparra_calendar_command;
a timestamptz;
z timestamptz;
BEGIN
  SELECT * INTO q FROM public.sparra_calendar_command WHERE id=op
    AND fence=f
    AND lease_until>clock_timestamp();
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM id FROM public.workspace WHERE id=q.workspace_id FOR UPDATE;
  SELECT * INTO b FROM public.sparra_calendar_command WHERE id=booking
    AND workspace_id=q.workspace_id
    AND state='confirmed'
    AND google_subject=q.google_subject
    AND calendar_id=q.calendar_id FOR UPDATE;
  IF NOT FOUND
    OR p->>'eventId' IS DISTINCT FROM b.event_id THEN
    RETURN false;
  END IF;
  IF p->>'status'='cancelled' THEN
    UPDATE public.sparra_calendar_command SET observed_state='cancelled',observed_at=clock_timestamp(),
    current_start=NULL,current_end=NULL WHERE id=booking;
  ELSIF p->>'status' IN ('confirmed','tentative') THEN
    a=(p->>'start')::timestamptz;
    z=(p->>'end')::timestamptz;
    IF a IS NULL
      OR z IS NULL
      OR NOT isfinite(a)
      OR NOT isfinite(z)
      OR a>=z THEN
      RETURN false;
    END IF;
    UPDATE public.sparra_calendar_command SET observed_state=p->>'status',observed_at=clock_timestamp(),
    current_start=a,current_end=z+make_interval(mins=>(b.policy->>'bufferMinutes')::int) WHERE id=booking;
    ELSE RETURN false;
  END IF;
  RETURN true;
END$$;

CREATE FUNCTION app_private.calendar_finish_v1(op uuid,f bigint,p jsonb) RETURNS boolean LANGUAGE plpgsql
    SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE q public.sparra_calendar_command;
n public.sparra_calendar_connection;
x jsonb;
a timestamptz;
z timestamptz;
oid uuid;
offers jsonb='[]';
retained boolean;
BEGIN
  SELECT * INTO q FROM public.sparra_calendar_command WHERE id=op
    AND fence=f;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM id FROM public.workspace WHERE id=q.workspace_id FOR UPDATE;
  SELECT * INTO q FROM public.sparra_calendar_command WHERE id=op
    AND fence=f FOR UPDATE;
  IF NOT FOUND
    OR q.lease_until<=clock_timestamp()
    OR q.state NOT IN ('running','unknown') THEN
    RETURN false;
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.sparra_call WHERE id=q.call_id
    AND workspace_id=q.workspace_id
    AND erasure_requested_at IS NULL
    AND retention_until>clock_timestamp()) INTO retained;
  IF p->>'state'='offered'
    AND q.kind='find_slots'
    AND retained THEN
    SELECT * INTO n FROM public.sparra_calendar_connection WHERE id=q.connection_id
      AND workspace_id=q.workspace_id;
    IF NOT FOUND
      OR NOT n.enabled
      OR n.status<>'connected'
      OR ROW(n.generation,n.policy_revision,n.calendar_id,n.google_subject) IS DISTINCT FROM ROW(q.generation,
    q.policy_revision,q.calendar_id,q.google_subject) THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(p->'slots') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p->'slots')>3 THEN
      RETURN false;
    END IF;
    FOR x IN SELECT value FROM jsonb_array_elements(p->'slots') LOOP
      a=(x->>'start')::timestamptz;
      z=(x->>'end')::timestamptz;
      IF a IS NULL
        OR z IS NULL
        OR NOT isfinite(a)
        OR NOT isfinite(z)
        OR a<q.window_start
        OR z>q.window_end
        OR a>=z
        OR z-a<>make_interval(mins=>(SELECT (s->>'durationMinutes')::int FROM
      jsonb_array_elements(q.policy->'services') s WHERE s->>'id'=q.service_id)) THEN
        RETURN false;
      END IF;
      IF NOT EXISTS(SELECT 1 FROM public.sparra_calendar_command b WHERE b.workspace_id=q.workspace_id
        AND b.kind='book_appointment'
        AND b.state IN ('pending','running','unknown','confirmed')
        AND b.observed_state IS DISTINCT FROM 'cancelled'
        AND b.current_start<z+make_interval(mins=>(q.policy->>'bufferMinutes')::int)
        AND b.current_end>a) THEN
        oid=gen_random_uuid();
        INSERT INTO public.sparra_calendar_offer(id,command_id,workspace_id,call_id,deployment_id,start,"end",
        expires_at) VALUES(oid,op,q.workspace_id,q.call_id,q.deployment_id,a,z,clock_timestamp()+interval '5 minutes');
        offers=offers||jsonb_build_array(jsonb_build_object('offerId',oid,'start',a,'end',z,'expiresAt',
        clock_timestamp()+interval '5 minutes','serviceId',q.service_id,'serviceName',q.service_name,'timezone',
        q.policy->>'timeZone'));
      END IF;
    END LOOP;
    UPDATE public.sparra_calendar_command SET state='offered',result=jsonb_build_object('offers',offers),
    lease_until=NULL WHERE id=op;
  ELSIF p->>'state'='confirmed'
    AND q.kind='book_appointment'
    AND q.possible_send_fence IS NOT NULL THEN
    IF p->>'eventId' IS DISTINCT FROM q.event_id
      OR (p->>'start')::timestamptz IS DISTINCT FROM q.window_start
      OR (p->>'end')::timestamptz IS DISTINCT FROM q.window_end
      OR p->>'operationId' IS DISTINCT FROM q.id::text THEN
      RETURN false;
    END IF;
    IF retained THEN
      UPDATE public.sparra_calendar_command SET state='confirmed',observed_state='confirmed',
      observed_at=clock_timestamp(),lease_until=NULL,result=jsonb_build_object('booking',
      jsonb_build_object('serviceId',q.service_id,'serviceName',q.service_name,'start',q.window_start,'end',
      q.window_end,'timezone',q.policy->>'timeZone','providerReference',q.event_id)) WHERE id=op;
      ELSE DELETE FROM public.sparra_calendar_command WHERE id=op;
    END IF;
  ELSIF p->>'state'='refused'
    AND q.possible_send_fence IS NULL THEN
    UPDATE public.sparra_calendar_command SET state='refused',lease_until=NULL,
    result=jsonb_build_object('reason','appointment_to_confirm') WHERE id=op;
  ELSIF p->>'state' IN ('retry','unknown') THEN
    UPDATE public.sparra_calendar_command SET state=CASE WHEN possible_send_fence IS NULL THEN 'pending'
    ELSE 'unknown' END,lease_until=NULL,retry_at=clock_timestamp()+CASE WHEN possible_send_fence IS NULL THEN
    interval '1 second'
    ELSE interval '60 seconds' END,result=jsonb_build_object('reason','appointment_to_confirm') WHERE id=op;
    ELSE RETURN false;
  END IF;
  RETURN true;
END$$;

CREATE FUNCTION app_private.calendar_token_claim_v1(op uuid,f bigint) RETURNS uuid LANGUAGE plpgsql SECURITY
    DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE q public.sparra_calendar_command;
n public.sparra_calendar_connection;
wid uuid=gen_random_uuid();
BEGIN
  SELECT * INTO q FROM public.sparra_calendar_command WHERE id=op
    AND fence=f
    AND lease_until>clock_timestamp();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM id FROM public.workspace WHERE id=q.workspace_id FOR UPDATE;
  SELECT * INTO n FROM public.sparra_calendar_connection WHERE id=q.connection_id
    AND workspace_id=q.workspace_id
    AND generation=q.generation
    AND google_subject=q.google_subject
    AND status='connected' FOR UPDATE;
  IF NOT FOUND
    OR (n.work_id IS NOT NULL
    AND n.work_expires_at>clock_timestamp()) THEN
    RETURN NULL;
  END IF;
  UPDATE public.sparra_calendar_connection SET work_id=wid,work_expires_at=clock_timestamp()+interval
  '30 seconds' WHERE id=n.id;
  RETURN wid;
END$$;

CREATE FUNCTION app_private.calendar_token_finish_v1(op uuid,f bigint,wid uuid,envelope text,lost boolean)
    RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE q public.sparra_calendar_command;
BEGIN
  SELECT * INTO q FROM public.sparra_calendar_command WHERE id=op
    AND fence=f;
  IF NOT FOUND
    OR wid IS NULL THEN
    RETURN false;
  END IF;
  PERFORM id FROM public.workspace WHERE id=q.workspace_id FOR UPDATE;
  IF envelope IS NOT NULL
    AND (length(envelope)>524288
    OR envelope !~ '^v1\.[A-Za-z0-9_-]+$') THEN
    RETURN false;
  END IF;
  UPDATE public.sparra_calendar_connection SET work_id=NULL,work_expires_at=NULL,
  token_envelope=coalesce(envelope,token_envelope),status=CASE WHEN lost THEN 'reconnect_required'
  ELSE status END,enabled=CASE WHEN lost THEN
  false
  ELSE enabled END,policy_revision=policy_revision+CASE WHEN lost THEN
  1
  ELSE 0 END
  WHERE id=q.connection_id
    AND workspace_id=q.workspace_id
    AND generation=q.generation
    AND google_subject=q.google_subject
    AND status='connected'
    AND work_id=wid;
  RETURN FOUND;
END$$;

CREATE FUNCTION app_private.calendar_erase_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET
    search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE'
    OR NEW.erasure_requested_at IS NOT NULL
    OR NEW.retention_until<=clock_timestamp() THEN
    DELETE FROM public.sparra_calendar_offer WHERE call_id=OLD.id;
    DELETE FROM public.sparra_calendar_command WHERE call_id=OLD.id
      AND (possible_send_fence IS NULL
      OR state IN ('confirmed','refused','offered'));
    UPDATE public.sparra_calendar_command SET call_id=NULL,deployment_id=NULL,request=NULL,result=NULL,
    policy=NULL,service_name='',service_id='' WHERE call_id=OLD.id;
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END$$;
CREATE TRIGGER calendar_erasure AFTER UPDATE OF erasure_requested_at,retention_until
  OR DELETE ON public.sparra_call FOR EACH ROW EXECUTE FUNCTION app_private.calendar_erase_v1();
-- Exact execute allowlist; no grants to PUBLIC or table rights for the login.
DO $$DECLARE sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY['calendar_view_v1(public.sparra_calendar_command)',
  'calendar_read_v1(uuid,bigint)','calendar_claim_v1()','calendar_prepare_create_v1(uuid,bigint)',
  'calendar_observe_v1(uuid,bigint,uuid,jsonb)','calendar_finish_v1(uuid,bigint,jsonb)',
  'calendar_token_claim_v1(uuid,bigint)','calendar_token_finish_v1(uuid,bigint,uuid,text,boolean)',
  'calendar_erase_v1()'] LOOP
  EXECUTE 'ALTER FUNCTION app_private.'||sig||' OWNER TO calendar_definer';
  EXECUTE 'REVOKE ALL ON FUNCTION app_private.'||sig||' FROM PUBLIC,runtime,calendar_worker';
END LOOP;
END$$;
GRANT EXECUTE ON FUNCTION app_private.calendar_read_v1(uuid,bigint),app_private.calendar_claim_v1(),
    app_private.calendar_prepare_create_v1(uuid,bigint),app_private.calendar_observe_v1(uuid,bigint,uuid,
    jsonb),app_private.calendar_finish_v1(uuid,bigint,jsonb),app_private.calendar_token_claim_v1(uuid,bigint),
    app_private.calendar_token_finish_v1(uuid,bigint,uuid,text,boolean) TO calendar_worker;



--> statement-breakpoint
CREATE POLICY "calendar_workspace_worker" ON "workspace" AS PERMISSIVE FOR ALL TO "calendar_definer" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "calendar_call_worker" ON "sparra_call" AS PERMISSIVE FOR SELECT TO "calendar_definer" USING (true);--> statement-breakpoint
CREATE POLICY "calendar_connection_voice" ON "sparra_calendar_connection" AS PERMISSIVE FOR SELECT TO "sparra_voice_definer" USING (workspace_id = voice_private.bound_workspace());--> statement-breakpoint
CREATE POLICY "calendar_connection_worker" ON "sparra_calendar_connection" AS PERMISSIVE FOR ALL TO "calendar_definer" USING (true) WITH CHECK (true);
