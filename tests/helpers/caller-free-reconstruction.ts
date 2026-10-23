// Synthetic, non-serving qualification only. No runtime graph imports this file.
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { Schema } from 'effect'
import type { Client } from 'pg'
import { normalizeAuthEmail } from '../../src/modules/auth/auth-email-normalization.server'

const text = (max: number, multiline = false) => Schema.String.check(Schema.isMaxLength(max), Schema.isPattern(multiline
  ? /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]*$/u
  : /^[^\u0000-\u001f\u007f-\u009f\ud800-\udfff\u2028\u2029]*$/u))
const id = text(128).check(Schema.isPattern(/^[A-Za-z0-9_-]+$/), Schema.isMinLength(1))
const uuid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
const integer = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(2147483647))
const instant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  Schema.makeFilter(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value))
const hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const phone = Schema.NullOr(Schema.String.check(Schema.isPattern(/^\+[1-9][0-9]{1,14}$/)))
const user = Schema.Struct({ id, name: text(256), email: text(254), email_verified: Schema.Boolean, image: Schema.NullOr(text(2048)),
  created_at: instant, updated_at: instant, recovering: Schema.Boolean, recovery_generation: integer, hold_until: Schema.NullOr(instant) })
const account = Schema.Struct({ id, account_id: text(256).check(Schema.isMinLength(1)), provider_id: Schema.Literal('google'), user_id: id, created_at: instant, updated_at: instant })
const passkey = Schema.Struct({ id, name: Schema.NullOr(text(256)), public_key: text(4096).check(Schema.isPattern(/^[A-Za-z0-9+/=_-]+$/)), user_id: id,
  credential_id: text(1024).check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)), counter: integer, device_type: Schema.Literals(['singleDevice','multiDevice']),
  backed_up: Schema.Boolean, transports: Schema.NullOr(text(256).check(Schema.isPattern(/^(usb|nfc|ble|internal|hybrid)(,(usb|nfc|ble|internal|hybrid))*$/))), created_at: Schema.NullOr(instant), aaguid: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/))) })
const batch = Schema.Struct({ user_id: id, batch_id: uuid, format_version: Schema.Literal(1), recovery_generation: integer, issued_at: instant })
const code = Schema.Struct({ id: uuid, user_id: id, batch_id: uuid, digest: hex, spent_at: Schema.NullOr(instant) })
const workspace = Schema.Struct({ id: uuid, kind: Schema.Literal('personal'), lifecycle: Schema.Literal('active'), owner_user_id: id,
  auth_organization_id: Schema.Null, display_name: text(80).check(Schema.isMinLength(1)), created_at: instant, updated_at: instant })
const revision = Schema.Struct({ workspace_id: uuid, revision: integer.check(Schema.isGreaterThanOrEqualTo(1)), business_name: text(80).check(Schema.isMinLength(1)),
  sector: Schema.Literals(['garage','controle-technique','diagnostic-immobilier']), opening_hours: text(1000,true), services: text(2000,true), prices: text(1500,true), faq: text(3000,true), instructions: text(2000,true),
  transfer_destination: phone, recording_enabled: Schema.Boolean, recording_policy: Schema.Literals(['off','local_30d']), recording_contact_phone: phone, saved_at: instant })
export const reconstructionMigrationCount = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) }).length
const rows = <S extends Schema.Top>(schema: S) => Schema.Array(schema).check(Schema.isMaxLength(256))
const source = Schema.Struct({ app_commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)), app_tree: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  web_digest: hex, migrator_digest: hex, migration_source_hash: hex, postgres_version: Schema.Literal('160015'),
  journal: rows(Schema.Struct({ id: integer, hash: hex, created_at: Schema.String.check(Schema.isPattern(/^[0-9]+$/)) })).check(Schema.isMinLength(reconstructionMigrationCount),Schema.isMaxLength(reconstructionMigrationCount)) })
const relations = Schema.Struct({ user: rows(user), account: rows(account), passkey: rows(passkey), recovery_code_batch: rows(batch), recovery_code: rows(code), workspace: rows(workspace), sparra_knowledge_revision: rows(revision) })
const envelope = Schema.Struct({ schema_version: Schema.Literal(1), purpose: Schema.Literal('caller-free-service-reconstruction'),
  qualification: Schema.Literal('synthetic-closed-admission'), capture_id: uuid, captured_at: instant, source, relations })
export type SyntheticReconstruction = typeof envelope.Type
export type SyntheticSourceBinding = typeof source.Type
export type SyntheticRelations = typeof relations.Type
export type ClassifiedFields = ReadonlyMap<string, string>
export function fieldHash(value: string) { return createHash('sha256').update(value).digest('hex') }
function refuse(): never { throw new Error('Synthetic reconstruction refused') }

// Classification is supplied separately by the trusted synthetic fixture author.
// A bundle never supplies its own approval. Every retained string is byte-bound.
export function classifiedSyntheticFields(data: SyntheticRelations): Map<string,string> {
  const result = new Map<string,string>()
  for (const [relation, selected] of Object.entries(data)) for (const [index,row] of selected.entries())
    for (const [field,value] of Object.entries(row)) if (typeof value === 'string') result.set(`${relation}/${index}/${field}`,fieldHash(JSON.stringify([row,field,value])))
  return result
}
function assertSourceBinding(actual: SyntheticSourceBinding, expected: SyntheticSourceBinding) {
  const binding=Schema.decodeUnknownSync(source,{onExcessProperty:'error'})(expected)
  if(JSON.stringify(actual)!==JSON.stringify(binding))refuse()
  if(binding.journal.some((entry,index)=>entry.id!==index+1 || index>0 && BigInt(entry.created_at)<=BigInt(binding.journal[index-1].created_at)))refuse()
}
function assertClassifiedFields(data: SyntheticRelations, classified: ClassifiedFields) {
  const fields=classifiedSyntheticFields(data)
  if(fields.size!==classified.size || [...fields].some(([key,hash])=>classified.get(key)!==hash))refuse()
}
function unique(values: readonly string[]) {
  if(new Set(values).size!==values.length)refuse()
}
function assertUniqueIdentities(data: SyntheticRelations) {
  unique(data.user.map(row=>row.id)); unique(data.user.map(row=>row.email)); unique(data.account.map(row=>row.id)); unique(data.account.map(row=>row.account_id))
  unique(data.passkey.map(row=>row.id)); unique(data.passkey.map(row=>row.credential_id)); unique(data.workspace.map(row=>row.id)); unique(data.workspace.map(row=>row.owner_user_id))
  unique(data.recovery_code_batch.map(row=>row.user_id)); unique(data.recovery_code_batch.map(row=>row.batch_id)); unique(data.recovery_code.map(row=>row.id)); unique(data.recovery_code.map(row=>row.digest))
  unique(data.sparra_knowledge_revision.map(row=>row.workspace_id))
}
function assertSelectedOwners(data: SyntheticRelations) {
  const users=new Map(data.user.map(row=>[row.id,row]))
  if(!users.size || users.size!==data.workspace.length || data.recovery_code_batch.length!==users.size || data.sparra_knowledge_revision.length!==data.workspace.length)refuse()
  for(const row of data.user)if(normalizeAuthEmail(row.email)!==row.email || !data.workspace.some(w=>w.owner_user_id===row.id))refuse()
  for(const row of data.workspace)if(!users.has(row.owner_user_id))refuse()
  for(const row of [...data.account,...data.passkey])if(!users.has(row.user_id))refuse()
}
function assertCurrentSecurityBatches(data: SyntheticRelations) {
  const users=new Map(data.user.map(row=>[row.id,row])), batches=new Map(data.recovery_code_batch.map(row=>[row.user_id,row]))
  for(const row of data.recovery_code_batch)if(users.get(row.user_id)?.recovery_generation!==row.recovery_generation || data.recovery_code.filter(c=>c.user_id===row.user_id && c.batch_id===row.batch_id).length!==8)refuse()
  for(const row of data.recovery_code)if(batches.get(row.user_id)?.batch_id!==row.batch_id)refuse()
}
function assertCurrentConfigurations(data: SyntheticRelations) {
  const workspaces=new Set(data.workspace.map(row=>row.id))
  for(const row of data.sparra_knowledge_revision)if(!workspaces.has(row.workspace_id) || row.recording_policy==='local_30d' && row.recording_enabled)refuse()
}
export function validateSyntheticReconstruction(input: unknown, expected: SyntheticSourceBinding, classified: ClassifiedFields): SyntheticReconstruction {
  try {
    if(Buffer.byteLength(JSON.stringify(input))>1024*1024)refuse()
    const bundle=Schema.decodeUnknownSync(envelope,{onExcessProperty:'error'})(input),data=bundle.relations
    assertSourceBinding(bundle.source,expected)
    assertClassifiedFields(data,classified)
    assertUniqueIdentities(data)
    assertSelectedOwners(data)
    assertCurrentSecurityBatches(data)
    assertCurrentConfigurations(data)
    return bundle
  } catch { return refuse() }
}

// Exactly seven positive SQL projections: unknown fields/history never enter JS.
export async function projectSyntheticReconstruction(client: Client, owners: readonly string[], workspaces: readonly string[], capture: Omit<SyntheticReconstruction,'relations'>, classified: ClassifiedFields): Promise<SyntheticReconstruction> {
  if(!owners.length || owners.length>16 || workspaces.length!==owners.length)refuse()
  const selected = {
    user: (await client.query('SELECT id,name,email,email_verified,image,created_at,updated_at,recovering,recovery_generation,hold_until FROM public."user" WHERE id=ANY($1::text[]) ORDER BY id LIMIT 257',[owners])).rows,
    account: (await client.query('SELECT id,account_id,provider_id,user_id,created_at,updated_at FROM public.account WHERE user_id=ANY($1::text[]) ORDER BY id LIMIT 257',[owners])).rows,
    passkey: (await client.query('SELECT id,name,public_key,user_id,credential_id,counter,device_type,backed_up,transports,created_at,aaguid FROM public.passkey WHERE user_id=ANY($1::text[]) ORDER BY id LIMIT 257',[owners])).rows,
    recovery_code_batch: (await client.query('SELECT user_id,batch_id,format_version,recovery_generation,issued_at FROM public.recovery_code_batch WHERE user_id=ANY($1::text[]) ORDER BY user_id LIMIT 257',[owners])).rows,
    recovery_code: (await client.query('SELECT id,user_id,batch_id,digest,spent_at FROM public.recovery_code WHERE user_id=ANY($1::text[]) ORDER BY id LIMIT 257',[owners])).rows,
    workspace: (await client.query("SELECT id,kind,lifecycle,owner_user_id,auth_organization_id,display_name,created_at,updated_at FROM public.workspace WHERE id=ANY($1::uuid[]) AND kind='personal' AND lifecycle='active' ORDER BY id LIMIT 257",[workspaces])).rows,
    sparra_knowledge_revision: (await client.query('SELECT DISTINCT ON (workspace_id) workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,transfer_destination,recording_enabled,recording_policy,recording_contact_phone,saved_at FROM public.sparra_knowledge_revision WHERE workspace_id=ANY($1::uuid[]) ORDER BY workspace_id,revision DESC LIMIT 257',[workspaces])).rows,
  }
  return validateSyntheticReconstruction({...capture,relations:JSON.parse(JSON.stringify(selected))},capture.source,classified)
}

// Existing explicitly owned disposable administrator transport only. No retry,
// upsert, RLS/constraint disabling or grants; an uncertain commit stays refused.
async function assertEmptyTarget(client: Client) {
  await client.query(`LOCK TABLE public."user",public.account,public.passkey,public.recovery_code_batch,public.recovery_code,public.workspace,public.sparra_knowledge_revision,
      public.session,public.verification,public.additional_passkey_intent,public.first_google_passkey_intent,public.google_account_intent,public.recovery_attempt,
      public.auth_session_revocation,public.recovery_code_rotation_fact,public.workspace_audit,public.auth_email_request,public.auth_email_command,public.email_delivery,public.auth_email_outbox,
      public.sparra_call,public.sparra_erasure,public.sparra_audio_chunk,public.sparra_audio_quota,public.sparra_audio_reader,
      voice_private.deployment_binding,voice_private.operation_receipt,voice_private.recording_purge IN SHARE ROW EXCLUSIVE MODE`)
  const occupied=(await client.query(`SELECT EXISTS(SELECT 1 FROM public."user") OR EXISTS(SELECT 1 FROM public.account) OR EXISTS(SELECT 1 FROM public.passkey) OR EXISTS(SELECT 1 FROM public.recovery_code_batch) OR EXISTS(SELECT 1 FROM public.recovery_code) OR EXISTS(SELECT 1 FROM public.workspace) OR EXISTS(SELECT 1 FROM public.sparra_knowledge_revision)
      OR EXISTS(SELECT 1 FROM public.session) OR EXISTS(SELECT 1 FROM public.verification) OR EXISTS(SELECT 1 FROM public.additional_passkey_intent) OR EXISTS(SELECT 1 FROM public.first_google_passkey_intent) OR EXISTS(SELECT 1 FROM public.google_account_intent) OR EXISTS(SELECT 1 FROM public.recovery_attempt)
      OR EXISTS(SELECT 1 FROM public.auth_session_revocation) OR EXISTS(SELECT 1 FROM public.recovery_code_rotation_fact) OR EXISTS(SELECT 1 FROM public.workspace_audit) OR EXISTS(SELECT 1 FROM public.auth_email_request) OR EXISTS(SELECT 1 FROM public.auth_email_command) OR EXISTS(SELECT 1 FROM public.email_delivery) OR EXISTS(SELECT 1 FROM public.auth_email_outbox)
      OR EXISTS(SELECT 1 FROM public.sparra_call) OR EXISTS(SELECT 1 FROM public.sparra_erasure) OR EXISTS(SELECT 1 FROM public.sparra_audio_chunk) OR EXISTS(SELECT 1 FROM public.sparra_audio_quota) OR EXISTS(SELECT 1 FROM public.sparra_audio_reader)
      OR EXISTS(SELECT 1 FROM voice_private.deployment_binding) OR EXISTS(SELECT 1 FROM voice_private.operation_receipt) OR EXISTS(SELECT 1 FROM voice_private.recording_purge) AS occupied`)).rows[0].occupied
  if(occupied)refuse()
}
async function assertInstalledTarget(client: Client, expected: SyntheticSourceBinding) {
  const installed=(await client.query('SELECT id,hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')).rows
  if(JSON.stringify(installed)!==JSON.stringify(expected.journal) || (await client.query("SELECT current_setting('server_version_num') AS version")).rows[0].version!==expected.postgres_version)refuse()
}
async function insertIdentityRows(client: Client, data: SyntheticRelations) {
  for(const r of data.user)await client.query('INSERT INTO public."user"(id,name,email,email_verified,image,created_at,updated_at,recovering,recovery_generation,hold_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[r.id,r.name,r.email,r.email_verified,r.image,r.created_at,r.updated_at,r.recovering,r.recovery_generation,r.hold_until])
  for(const r of data.account)await client.query('INSERT INTO public.account(id,account_id,provider_id,user_id,created_at,updated_at,access_token,refresh_token,id_token,access_token_expires_at,refresh_token_expires_at,scope,password) VALUES($1,$2,$3,$4,$5,$6,NULL,NULL,NULL,NULL,NULL,NULL,NULL)',[r.id,r.account_id,r.provider_id,r.user_id,r.created_at,r.updated_at])
  for(const r of data.passkey)await client.query('INSERT INTO public.passkey(id,name,public_key,user_id,credential_id,counter,device_type,backed_up,transports,created_at,aaguid) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[r.id,r.name,r.public_key,r.user_id,r.credential_id,r.counter,r.device_type,r.backed_up,r.transports,r.created_at,r.aaguid])
}
async function insertSecurityRows(client: Client, data: SyntheticRelations) {
  for(const r of data.recovery_code_batch)await client.query('INSERT INTO public.recovery_code_batch(user_id,batch_id,format_version,recovery_generation,issued_at) VALUES($1,$2,$3,$4,$5)',[r.user_id,r.batch_id,r.format_version,r.recovery_generation,r.issued_at])
  for(const r of data.recovery_code)await client.query('INSERT INTO public.recovery_code(id,user_id,batch_id,digest,spent_at) VALUES($1,$2,$3,$4,$5)',[r.id,r.user_id,r.batch_id,r.digest,r.spent_at])
}
async function insertConfigurationRows(client: Client, data: SyntheticRelations) {
  for(const r of data.workspace)await client.query('INSERT INTO public.workspace(id,kind,lifecycle,owner_user_id,auth_organization_id,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[r.id,r.kind,r.lifecycle,r.owner_user_id,r.auth_organization_id,r.display_name,r.created_at,r.updated_at])
  for(const r of data.sparra_knowledge_revision)await client.query('INSERT INTO public.sparra_knowledge_revision(workspace_id,revision,business_name,sector,opening_hours,services,prices,faq,instructions,transfer_destination,recording_enabled,recording_policy,recording_contact_phone,saved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[r.workspace_id,r.revision,r.business_name,r.sector,r.opening_hours,r.services,r.prices,r.faq,r.instructions,r.transfer_destination,r.recording_enabled,r.recording_policy,r.recording_contact_phone,r.saved_at])
}
export async function rebuildSyntheticReconstruction(client: Client, input: unknown, expected: SyntheticSourceBinding, classified: ClassifiedFields) {
  const bundle=validateSyntheticReconstruction(input,expected,classified)
  let begun=false
  try {
    await client.query('BEGIN');begun=true
    await client.query("SET LOCAL statement_timeout='1000ms'; SET LOCAL lock_timeout='1000ms'")
    await assertEmptyTarget(client)
    await assertInstalledTarget(client,bundle.source)
    await insertIdentityRows(client,bundle.relations)
    await insertSecurityRows(client,bundle.relations)
    await insertConfigurationRows(client,bundle.relations)
    await client.query('COMMIT');begun=false
  } catch {
    if(begun)await client.query('ROLLBACK').catch(()=>{})
    return refuse()
  }
}
