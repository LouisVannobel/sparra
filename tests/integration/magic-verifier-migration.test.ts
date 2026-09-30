import { expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { startDisposableStores } from '../fixtures/db/disposable-stores'

for (const mode of ['malformed', 'duplicate', 'valid-nullable'] as const) {
  test(`forward verifier migration ${mode} preserves historical data and journal atomicity`, async () => {
    const stores = await startDisposableStores()
    try {
      if (typeof stores.evidence.directory !== 'string') throw new Error('Owned fixture directory missing')
      const prefix = join(stores.evidence.directory, 'magic-migration-prefix')
      await mkdir(join(prefix, 'meta'), { recursive: true })
      const journal = JSON.parse(await readFile(resolve('drizzle/meta/_journal.json'), 'utf8'))
      journal.entries = journal.entries.slice(0, 6)
      const tags = ['0000_auth_storage', '0001_cheerful_sharon_carter', '0002_worthless_newton_destine',
        '0003_auth_mail_polling_candidates', '0004_wealthy_impossible_man', '0005_account_provider_key']
      if (JSON.stringify(journal.entries.map((entry: { tag: string }) => entry.tag)) !== JSON.stringify(tags)) throw new Error('Unexpected migration prefix')
      for (const tag of tags) await cp(resolve('drizzle', tag + '.sql'), join(prefix, tag + '.sql'))
      await writeFile(join(prefix, 'meta/_journal.json'), JSON.stringify(journal))
      await migrate(drizzle(stores.administrator, { logger: false }), { migrationsFolder: prefix })
      const hashes = mode === 'malformed' ? ['A'.repeat(64)] : mode === 'duplicate' ? ['a'.repeat(64), 'a'.repeat(64)] : ['a'.repeat(64), null, null]
      async function insertDelivery(hash: string | null) {
        const requestId = randomUUID(), commandId = randomUUID(), deliveryId = randomUUID(), recipient = randomUUID() + '@example.test'
        await stores.administrator.query("INSERT INTO auth_email_request(id,email,purpose,generation,state) VALUES($1,$2,'magic-link',1,'active')", [requestId, recipient])
        await stores.administrator.query(`INSERT INTO auth_email_command(id,request_id,generation,purpose,recipient,locale,created_at,expires_at)
          VALUES($1,$2,1,'magic-link',$3,'en',clock_timestamp(),clock_timestamp()+interval '5 minutes')`, [commandId, requestId, recipient])
        await stores.administrator.query("INSERT INTO email_delivery(id,command_id,state,key_id,verifier_hash) VALUES($1,$2,'active','fixture',$3)", [deliveryId, commandId, hash])
      }
      for (const hash of hashes) await insertDelivery(hash)
      const before = (await stores.administrator.query('SELECT id,verifier_hash FROM email_delivery ORDER BY id')).rows
      const applied = await stores.migrate().then(() => true, error => {
        if (!(error instanceof Error) || error.message !== 'Disposable migration command failed') throw new Error('Unexpected migration failure')
        return false
      })
      expect(applied).toBe(mode === 'valid-nullable')
      expect(JSON.stringify((await stores.administrator.query('SELECT id,verifier_hash FROM email_delivery ORDER BY id')).rows) === JSON.stringify(before)).toBe(true)
      expect((await stores.administrator.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n).toBe(mode === 'valid-nullable' ? 8 : 6)
      const exists = (await stores.administrator.query("SELECT to_regclass('public.email_delivery_verifier_unique') IS NOT NULL AS present")).rows[0].present
      expect(exists).toBe(mode === 'valid-nullable')
      if (mode === 'valid-nullable') {
        const rejected = await insertDelivery('A'.repeat(64)).then(() => false,
          error => error.code === '23514' && error.constraint === 'email_delivery_verifier_canonical')
        expect(rejected).toBe(true)
        const duplicate = await insertDelivery('a'.repeat(64)).then(() => false,
          error => error.code === '23505' && error.constraint === 'email_delivery_verifier_unique')
        expect(duplicate).toBe(true)
        expect((await stores.administrator.query('SELECT count(*)::int AS n FROM email_delivery WHERE verifier_hash IS NULL')).rows[0].n).toBe(2)
      }
    } finally {
      try { await stores.cleanup() }
      finally {
        const directory = resolve('.output/test-evidence/magic-core'); await mkdir(directory, { recursive: true })
        await writeFile(resolve(directory, `migration-${mode}-${stores.evidence.runId}.json`), JSON.stringify(stores.evidence, null, 2) + '\n')
      }
    }
  }, 180000)
}
