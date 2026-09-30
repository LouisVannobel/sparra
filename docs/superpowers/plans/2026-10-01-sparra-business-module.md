# Sparra Native Business Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking. The user adopted the design and explicitly requires autonomous execution without further human approval gates; do not stop for plan/execution confirmation.

**Goal:** A real private knowledge editor and persistent owner-scoped inbox with read/treat/erase, ready for the native Voice SQL bridge.

**Architecture:** Use the existing admitted principal and physical personal-Workspace transaction. Product tables and functions live in one vertical sparra module; append-only configuration revisions, a call/inbox row with immutable revision pin, and a minimal erasure fence/queue. No result-producing owner endpoint, fake calls, extra pool, transaction service or authentication.

**Tech Stack:** R1 Node24.14.0/pnpm10.32.1/TypeScript7.0.2/Effect4.0.0-rc.111/Drizzle0.45.2/BetterAuth1.7.4/Astryx0.5.4; native PostgreSQL16.15 fixtures.

**Spec:** docs/superpowers/specs/2026-09-30-sparra-pilot-integration-design.md (adopted1October), and adopted first-delivery design. Source references: external R1_BUSINESS_CONTRACT_EVIDENCE.md and VOICE_INGEST_CONTRACT_EVIDENCE.md at C:/Users/louis/.codex/artifacts/sparra/2026-09-30.

## Global Constraints

- Approot C:/Users/louis/Documents/ChatGPT/sparra; dedicated isolated derivative, one writer, preserve producer/dirtyinfra/staleVoice checkouts. Baseline beforeplan2cc2114.
- Keep pins, lockfile and nice-grpc patch; no new package/SDK/service/designsystem. Generated route tree from native generator only.
- Native principal->withPersonalWorkspacePromise(options,principal,false,callback)->ownedconnection; no client principal/session/Workspace authority. GET never creates an espace; nativePOST ensurePersonalWorkspace remains creation action.
- CSRF native/no-store/noindex/privateCSP, strict Effect schema/onExcessProperty error, actual callerAbortSignal, bounded public errors and COMMIT-aware success.
- FORCE RLS/USING/WITH CHECK/PUBLIC revoked/nativeworkspace_owner; bootstrap zero-sentinel has no business grant. Never widen personal delete/execute/pool/transaction capabilities.
- Forward migrations after0012, frozen0000–0012 byte-identical. Migrationrunner and generator native; test preexisting data on owned disposable stores only. No sharedmigration/deployment/DNS/push/inframutation in this localconsumer plan.
- 30days =2592000seconds from admission, no audio recordings. Sensitive expired/deleted data never returned; remote/local erasure remains queued until actual future Voice ack. No GDPR/France/complete-message/transfer/booking claim from this lot.
- Existing public Grok demos and site remain. PrivateFR/EN retained; businesscopy plain and UIAstryx. No charts/CRM/calendar/SMS/team/billing subsystem.
- Secrets never logs/source/Oracle; no.env read. Test keyrings/random credentials generated per fixture; no live providers by workers.
- Sequential tests/integration one worker, resourcefloors2GiBphysical/6GiBvirtual, ownedcleanup/inventory preserveforeign resources. No full unchangedsuite replay unless newchanges/failures justify it.

## Review Focus

- Same owner two tabs save same revision: one commit/one409; retain conflicted draft and correct latestversion.
- Deleted/expired/foreign request and missing key: no sensitive leak, no fake empty-success or transcript fallback; ciphertext authenticated before UTF8fatal decode.
- Erase versus late ingest: atomic scoped fence, no caller-supplied erase scope; current owner cannot claim copies erased before realworkerack.
- Loader/unmount/cancel and ambiguousCOMMIT: no stale success/draftloss/blindretry; readback of actual DB state.
- Native compiler/RPC/locale/roles: realbuilt functions, privateheaders/CSRF, rolegrants/migration compatibility rather than copied mock predicates.

## Data/DTO choices shared by tasks

Configuration contains businessName (trimmed1..80UTF16, single line), sector garage|controle-technique, five textsections and optional typed transferDestination E.164. This is a concrete greeting/transfer consumer, not another organization model. Knowledge textlimits: openingHours1000,services2000,prices1500,faq3000,instructions2000; string.length/total9500. NormalizeCRLF toLF; reject NUL/control exceptLF/CR/tab and invalid surrogate scalars. Transfer remains disabled operationally until qualified non-looping destination; never extracted from prose.

ActivityConfigurationDto: {workspaceId,revision:number>0,savedAt:ISOString,businessName,sector,knowledge:{openingHours,services,prices,faq,instructions},transferDestination:string|null}. SaveActivityInput sameeditable fields+expectedRevision integer0..2147483646, noworkspaceId/principal/session. ActivityState {workspace:WorkspaceDto|null,configuration:ActivityConfigurationDto|null}. AbsentWorkspace uses nativeensurePOST; sourcecaller mustnot create inread/savefalse mode.

Inbox row represents actual call: UUIDid,workspaceId,configurationRevision nullable until begin, deploymentId, immutable providerCallControlId/leg/session, admittedAt,retentionUntil, technicalstatus pending|active|closing|closed|failed, disclosure evidence timestamps/facts, encryptedTurns JSON object, optional encryptedMessageResult JSON, treatedAt nullable and dedicated erasureRequestedAt nullable. Unique(deploymentId,providerCallControlId); composite FK(workspaceId,configurationRevision)->knowledgeRevision. No runtime INSERT/UPDATE result grants. UI never reports a pending unpinned shell as messagecomplete.

Stored turns match exact Voice TurnUpsertPayloadV1; nonce12, ciphertext||tag16, keyversionpositive,AAD ASCIIturn:<turnUUID>. Optional result envelope version1,AADresult:<callUUID>; business innerDTO asadoptedspec, partial/unverified atthisstage. EncryptedTurnMap≤524288bytes; encryptedresult≤16384bytes; list50/page ordered admittedAt desc,id desc; detail≤200turns, otherwise bounded explicit truncation indicator. Datesareobservations, never invent measuredturndurationfromstart=end.

RequestSummaryDto {id,admittedAt,endedAt,status,configurationRevision,treatedAt,resultAvailability:available|unavailable|partial,category,summary,contact,nextAction}; no ciphertext,key,providerIDs inbrowserDTO. RequestDetailDto adds configuration snapshot,transcript withturnid/ordinal/role/text/interrupted/startedAt,moreTurns:boolean,erasureState nullable. Missing/key/authenticated-content error returns explicitunavailable body state while metadata remainsowned; never fabricated text. EraseReceipt {requestId,state:queued|completed}; no immediate claim allcopiesgone.

## Task 1: Native configuration revision and server functions

**Files:** create src/modules/sparra/schema.server.ts, activity.server.ts, sparra.functions.ts, messages.ts; modify drizzle.config.ts, tests/helpers/auth-rpc.ts narrowbuiltmodule/name union; create tests/sparra/activity.test.ts and tests/integration/sparra-activity.test.ts; native generated forward0013/meta artifacts; contextualAGENTS onlyif needed.

**Consumes:** current AuthTransactions/AdmittedPrincipal and WorkspaceDto; nativeR1fixtures andRPC. **Produces:** getActivity GET,saveActivity POST, createActivityOperations(owner) withread/save usingfalsepersonallease; ActivityConfigurationDto/ActivityState/SaveActivityInput exportedtype-only.

- [ ] Write behaviorRED: absentGET hasnoWorkspace/create; invalid/extrafields fail400; firstsaveexpected0 createsrev1 onlywithexistingnativeWorkspace; read/reloadreturnsstoredvalues; identicalexpectedversionconcurrent saves yieldone revnext andone409; earlierrevisionunchanged. NativeSQLcrossowner guessedids/tenantabsentzeroinvalid/sessionrevoked/deleting deny, fulltransactionabort leavesnosavedfeedback.
- [ ] Run source tests beforecode, observe missingconsumer/schema failure. Build selected tests only asneeded fornativeSQL/RPC runner; no substitute endpoints.
- [ ] Add public.sparra_knowledge_revision compositePK(workspace_id,revision), name/sector/knowledge/typedtransfer/saved timestamp checks. RuntimeSELECT/INSERTonly, ownerrolepolicies withmatchingnonzero tenant; nozero bootstrap. Generate0013 withnativeDrizzle; append necessaryownership/FORCERLS/privilegeSQL and metadatajournal exactly once, nooldmigrationchange.
- [ ] Implement existingWorkspace-lock readlatest/compare/insert; no mutablehead/CAS framework. Optionsdeadline≤10000ms/statement≤1000/cleanup≤1000/correlationUUID/requestsignal. Domain InvalidActivityInput and ActivityRevisionConflict safefixednames crossSSR/Nitro;404unavailable/409conflict/400invalid, generic500otherwise. Handlernativeprincipal thenoperations; runtimeResource poolunchanged.
- [ ] ImplementnarrowbuiltRPC helpername/module addition, actualdisposableDB owner/sessionfixtures. Testnative migration withpreexistingUser/session/Workspace/audit andno sourceoldmigrationhashchanges. Run targetedsource+nativeintegration (1worker), pnpmtypecheck/lint/build ifneeded; record commands/results/limits andcommit intendedfiles only.

## Task 2: Native inbox reader, authenticated crypto and erase transition

**Files:** extend src/modules/sparra/schema.server.ts,sparra.functions.ts; create requests.server.ts,message-crypto.server.ts; newforward0014/generatedmeta; tests/sparra/requests.test.ts,message-crypto.test.ts; tests/integration/sparra-requests.test.ts; fixturehelpersnarrowextension; docs/qa/business-module.md.

**Consumes:** Task1configurationtables/types, nativeownedtransaction andprivateRPC. **Produces:** listRequests GET {cursor?};getRequestDetail GET {requestIdUUID};markRequestTreated POST {requestId};eraseRequest POST {requestId};getRequestErasure GET {requestId}; moduleownedreadKeyring fromexplicitprocesspath andcrypto decoder. Newcall andminimalerasuretables arefutureVoiceSQL targets, no ownerresult-producer endpoint.

- [ ] RED consumers: twoownersreads/treat/erase cannotcross, expireddetails unreadable, treatedrepeat keepsstamp; pinFKcannotborrowforeignWorkspace revision; keyless/badtag/badAAD/keyversion/invalidUTF8 returnsunavailable, no textfallback. Crosslanguagefixture actualPythonAES turn/result readbyNode; no provider needed.
- [ ] Add public.sparra_call fields sharedabove, FORCE RLS+owner/runtimepolicies. runtimeSELECTonlyandcolumnlimitedUPDATEtreated_at,erasure_requested_at; no INSERT, immutablecaller/config/resultfields. Add public.sparra_erasure withworkspace/call/deployment/provideridentityhash, originalretention,fenceUntilretention+900s,statequeued|completed,leasefields/future ack. ScopedruntimeSELECTonly, no facadegenericdelete.
- [ ] Create narrowAFTERUPDATEerase trigger derivingOLDscope, settingimmutableerasurefence anddeletingcallcontent in sameDBtransaction. Fixedsearch_path/fullqualifiedtables/PUBLICEXECUTErevoked/definerrole underexplicitFORCERLSpolicy, noauth/audittabletouch. SQLnativegate provesUPDATEreturnthenphysicalrowabsence/fence, repeatidempotent, rollbackandcancellation, twoowners scoped. Observe actualbehavior ratherthan assume PostgreSQLtriggersemantics. Laterbridgeconsultsfence; no currentliveingeststub.
- [ ] Readerafterprincipal/lease, selectnonexpiredownedrow, validateencryptedstructure/keyringboundedregularnon-symlinkfile (no.env), authenticateciphertextwithseparatedtag, UTF8fatal thenstrictinnerSchema. No secret/rawcause leakage inerror. ReadonlyUI data includeexplicitquality/missing/truncationstate, notcipher/key/providerIDs. No empty keyring replacement; withnoactivecalls keyringabsence doesnotblockconfiguration/emptyinbox. Runtimeprivatekeyringpathconfiguredonlywhenactualencryptedconsumer needed, generatedfixturekeysneverpersist.
- [ ] Treat updatecondition ownedpending only, same timestamp onrepeat. Erase returnsqueue receipt afterconfirmedcommit; frontendstate separatefuturebridgecleanup. Reads blockretention immediately regardlessworker. Actualfixtures insertciphertext underownedtestprivilegeonly; testsarenotruntimefakecall generation.
- [ ] Verify21style meaningfulsource testsplusselectednativePG/RPC fornewconsumers, existingbackendrolegrants/meta/migrationoldunchanged, lint/typecheck; no authsuite replayunlessaffected. Recordactualresultandcommit. Documentno serviceingest/livecall/physicalremoteerase proof yet.

## Task 3: Private Astryx app flow and compiled native acceptance

**Files:** create src/routes/app.tsx,app.index.tsx,app.entreprise.tsx,app.demandes.$requestId.tsx; src/ui/sparra/app-shell.tsx,activity-panel.tsx,inbox-panel.tsx,request-panel.tsx,sparra.css; messages inexistingmodule; tests/ui/sparra-*.test.tsx; tests/integration/sparra-browser.test.ts. Modify account navigationonlywhere realappLinkconsumed; generatedroute tree frombuild.

**Consumes:** nativegetWorkspace/ensurePOST +Task1/2serverFns, theirDTOs andFR/ENerrors; **Produces:** /app inbox,/app/entrepriseeditor,/app/demandes/$requestIddetail usingexistingauth/route machinery andserverreturnedDTOs. Authshellisnotnewauthwrapper.

- [ ] RED UI/nativecases: GETnevercreatesWorkspace; createPOSTthenbusinesssave persistsafterreload/serverrestart; notconfigured/zeroactualrequests showusefulemptystate. Conflictingtab keepsdraft409 andlatestversionnotice. Realdbfixturecall displaysknownsnapshot/summarysource/partialstates; treat/erase persists andshowqueuederasure withoutfalsecomplete. Foreign/invalidsession route no data andnative loginredirect.
- [ ] Follow Astryx nativeinstalledtypes/theme andadoptedpalette; usepublishedTextarea/input/select/Button/Icon, noshadowdesignsystem/fontdependency. Titleversion/statuslabel+decorativeicon, navigationBoîte d’appels/Entreprise/Compte, mobileonecolumn andFR/ENnative locale. Fiveknowledgefields +name/sector +optionaltypedhumanline; contenteditableonlyprivateowner. No bookings/audio/transferclaim.
- [ ] LoaderpassnativeabortController.signal; mutationsownAbortController abortedonunmount/newattempt; monotonicattemptidentityignoresstalereturn; preserveconflictdraft, no blindretry/optimisticsavedbeforeCOMMIT. NativeuseServerFn/rawResponse errors handleconsistentlySSR/RPC. Keyboardlabels/errors/status announcewithoutcontinualtranscriptupdates.
- [ ] Buildnativegeneratedroutes; runnormativetypecheck/lint/build oncefinalcode, targetedUItests, selectedcompilednativebrowser1worker/owneddisposablestore: save/restart+inboxdetail/treat/erase, twoowners, revokedSession,csrf, cancellationnetworkwitness,320px/keyfocus/axe/privateheaders. Testshimfixtures only, realcompiledserver/client/SQL, notstaticmockUI. Preservepublicreader behavior withcoveringexistingmarketingtests onlywhenroutechanges warrant; no arbitrarybroad repeat.
- [ ] Independentreview/fixgateperTask, finalwholebranchmostcapable andOracle milestone onminimalnon-sensitivebundle. Reportsignored, noforceadd. Commit andkeepworkingtowardVoiceSQL/runtime/actualFrenchpilot; do notmarkfullgoalcompletefromthismodule.

## Self-review and execution

Parent spec scope mapped: currentplanowns realnative businesspersistence/UI/ownererasure; bridge/runtime/functions/remoteerasure/pilotremainexplicitnextplans, not omittedorclaimedready. Allcross-taskDTO/function/table names definedabove. The fiveReviewFocus rows have testsinTasks1/2/3. Plansneednocustomerconfirmationafter1Octoberautonomy instruction. Execute sequentialfreshimplementer+independentreview per task, recordBASEbeforeeach; one writer. Thisplanmustnotintroduceinstantphysicalremoteeraseorcallcompleteclaims to compensatefor missingdownstreamconsumers.

## Concrete verification commands

Task1: pnpm exec vitest run tests/sparra/activity.test.ts --maxWorkers=1 ; pnpm exec vitest run --config vitest.integration.config.ts tests/integration/sparra-activity.test.ts --maxWorkers=1.
Task2: pnpm exec vitest run tests/sparra/requests.test.ts tests/sparra/message-crypto.test.ts --maxWorkers=1 ; pnpm exec vitest run --config vitest.integration.config.ts tests/integration/sparra-requests.test.ts --maxWorkers=1.
Task3: pnpm exec vitest run tests/ui/sparra-*.test.tsx --maxWorkers=1 ; pnpm exec vitest run --config vitest.integration.config.ts tests/integration/sparra-browser.test.ts --maxWorkers=1. Shell-glob handling must be native/observed; use explicit emitted filenames if needed.
Each task: normative pnpm typecheck ; pnpm build when generated/built consumers need it. Add new scoped sparra module to pnpm lint atTask1, UI/routes/tests when createdTask3; no blanket R1 qualification or newtool.
