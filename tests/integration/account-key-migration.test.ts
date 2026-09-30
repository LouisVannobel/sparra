import { afterAll, beforeAll, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { startDisposableStores } from '../fixtures/db/disposable-stores'

let stores: Awaited<ReturnType<typeof startDisposableStores>>
const receipts: { case: string; before: string; after: string }[] = []
beforeAll(async () => {
  stores = await startDisposableStores()
  await stores.migrateAccountKeyPrefix()
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n).toBe(5)
  await stores.administrator.query(`
    INSERT INTO "user" (id,name,email,recovery_generation,recovering) VALUES
      ('legacy-owner','Legacy owner','legacy@example.test',17,true),
      ('other-owner','Other owner','other@example.test',3,false);
    INSERT INTO session (id,token,user_id,expires_at,auth_state,auth_method,authenticated_at,recovery_generation,last_activity_at,provider_identity)
      VALUES ('legacy-session','synthetic-storage-value','legacy-owner','2027-01-01','RECOVERY_RESTRICTED','google','2026-09-10',17,'2026-09-10','{"issuer":"https://accounts.google.com","subject":"0009007199254740993"}');
    INSERT INTO auth_email_request (id,user_id,purpose,email,generation,state)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','legacy-owner','magic-link','legacy@example.test',1,'active');
  `)
})
afterAll(async () => {
  if (!stores) return
  try { await stores.cleanup() }
  finally {
    const directory = resolve('.output/test-evidence/account-key')
    await mkdir(directory, { recursive: true })
    await writeFile(resolve(directory, `migration-${stores.evidence.runId}.json`), JSON.stringify({ cases: receipts, fixture: stores.evidence }, null, 2))
  }
})

async function snapshot() {
  const db = stores.administrator
  const accounts = (await db.query('SELECT to_jsonb(a) AS row FROM account a ORDER BY id')).rows
  const users = (await db.query('SELECT to_jsonb(u) AS row FROM "user" u ORDER BY id')).rows
  const sessions = (await db.query('SELECT to_jsonb(s) AS row FROM session s ORDER BY id')).rows
  const mail = (await db.query('SELECT to_jsonb(m) AS row FROM auth_email_request m ORDER BY id')).rows
  const columns = (await db.query("SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='account' ORDER BY ordinal_position")).rows
  const constraints = (await db.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.account'::regclass ORDER BY conname")).rows
  const indexes = (await db.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='account' ORDER BY indexname")).rows
  const journal = (await db.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows
  return { accounts, users, sessions, mail, columns, constraints, indexes, journal }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function insert(id: string, issuer = 'https://accounts.google.com', provider = 'google', subject = '0009007199254740993', user = 'legacy-owner') {
  await stores.administrator.query(`INSERT INTO account
    (id,issuer,provider_id,account_id,user_id,access_token,refresh_token,id_token,scope,access_token_expires_at,refresh_token_expires_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,'synthetic-access','synthetic-refresh','synthetic-id','openid email','2027-01-01','2027-02-01','2026-09-09','2026-09-10')`, [id, issuer, provider, subject, user])
}

test.each([
  { name: 'foreign issuer', issuer: 'https://other.example' },
  { name: 'noncanonical stored issuer', issuer: 'accounts.google.com' },
  { name: 'unknown issuer', issuer: '' },
  { name: 'foreign provider', provider: 'other' },
  { name: 'empty subject', subject: '' },
  { name: 'blank subject', subject: ' \t\n' },
  { name: 'BOM-only subject', subject: '\uFEFF' },
  { name: 'null subject spelling', subject: 'null' },
  { name: 'undefined subject spelling', subject: 'undefined' },
  { name: 'empty row identifier', id: '' },
])('refuses $name atomically without data, schema or journal changes', async fixture => {
  await insert(fixture.id ?? 'invalid-account', fixture.issuer, fixture.provider, fixture.subject)
  try {
    const before = await snapshot()
    await expect(stores.migrate()).rejects.toThrow('Disposable migration command failed')
    const after = await snapshot()
    expect(after).toEqual(before)
    receipts.push({ case: fixture.name, before: digest(before), after: digest(after) })
  } finally { await stores.administrator.query('DELETE FROM account') }
})

test.each(['legacy-owner', 'other-owner'])('refuses duplicate native pairs with owner %s under intact old uniqueness', async owner => {
  await insert('duplicate-a')
  await insert('duplicate-b', 'https://foreign.example', 'google', '0009007199254740993', owner)
  try {
    const before = await snapshot()
    await expect(stores.migrate()).rejects.toThrow('Disposable migration command failed')
    const after = await snapshot()
    expect(after).toEqual(before)
    receipts.push({ case: `duplicate-${owner}`, before: digest(before), after: digest(after) })
  } finally { await stores.administrator.query('DELETE FROM account') }
})

test('a legacy column consumer refuses final DDL and rolls back every preceding constraint change', async () => {
  await insert('view-bound-account')
  await stores.administrator.query('CREATE VIEW fixture_legacy_issuer AS SELECT issuer FROM account')
  try {
    const before = await snapshot()
    await expect(stores.migrate()).rejects.toThrow('Disposable migration command failed')
    const after = await snapshot()
    expect(after).toEqual(before)
    expect((await stores.administrator.query('SELECT issuer FROM fixture_legacy_issuer')).rows).toEqual([{ issuer: 'https://accounts.google.com' }])
    receipts.push({ case: 'dependent-view-ddl-rollback', before: digest(before), after: digest(after) })
  } finally { await stores.administrator.query('DROP VIEW fixture_legacy_issuer; DELETE FROM account') }
})

test('preflight waits for the account lock and refuses a newly committed foreign binding', async () => {
  await insert('locked-account')
  let locked = false
  let migrating: Promise<unknown> | undefined
  try {
    await stores.administrator.query("BEGIN; UPDATE account SET issuer='https://foreign.example' WHERE id='locked-account'")
    locked = true
    migrating = stores.migrate().then(() => 'unexpected-success', () => 'refused')
    let waiting = false
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = (await stores.administrator.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation='account'::regclass AND mode='AccessExclusiveLock' AND NOT granted) AS waiting")).rows[0].waiting
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(waiting).toBe(true)
    await stores.administrator.query('COMMIT')
    locked = false
    const before = await snapshot()
    expect(await migrating).toBe('refused')
    const after = await snapshot()
    expect(after).toEqual(before)
    receipts.push({ case: 'lock-before-preflight', before: digest(before), after: digest(after) })
  } finally {
    if (locked) await stores.administrator.query('ROLLBACK')
    await migrating
    await stores.administrator.query('DELETE FROM account')
  }
})

test('migrates canonical N-1 bindings exactly and preserves unrelated state with native constraints', async () => {
  await insert('legacy-account')
  const before = await snapshot()
  await stores.migrate()
  const after = await snapshot()
  const { issuer: _issuer, ...retained } = before.accounts[0].row
  expect(after.accounts).toEqual([{ row: retained }])
  expect(after.users).toEqual(before.users)
  expect(after.sessions).toEqual(before.sessions)
  expect(after.mail).toEqual(before.mail)
  expect(after.journal.slice(0, 5)).toEqual(before.journal)
  expect(after.journal).toHaveLength(8)
  expect(after.columns.some(column => column.column_name === 'issuer')).toBe(false)
  expect(after.constraints).toEqual(expect.arrayContaining([
    { conname: 'account_provider_account_id_unique', definition: 'UNIQUE (provider_id, account_id)' },
    { conname: 'account_provider_google', definition: "CHECK ((provider_id = 'google'::text))" },
  ]))
  expect(after.constraints.some(item => item.conname === 'account_issuer_account_id_unique')).toBe(false)
  const stable = await snapshot()
  await expect(stores.administrator.query("UPDATE account SET provider_id='other' WHERE id='legacy-account'")).rejects.toMatchObject({ code: '23514' })
  await expect(stores.administrator.query("INSERT INTO account (id,provider_id,account_id,user_id) VALUES ('foreign','other','subject','legacy-owner')")).rejects.toMatchObject({ code: '23514' })
  await expect(stores.administrator.query("INSERT INTO account (id,provider_id,account_id,user_id) VALUES ('duplicate','google','0009007199254740993','other-owner')")).rejects.toMatchObject({ code: '23505' })
  expect(await snapshot()).toEqual(stable)
  receipts.push({ case: 'canonical-forward', before: digest(before), after: digest(after) })
})
