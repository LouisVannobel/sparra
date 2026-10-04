import { expect, test } from 'vitest'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import { InvalidActivityInput, parseSaveActivityInput } from '../../src/modules/sparra/activity.server'
import { sparraKnowledgeRevision } from '../../src/modules/sparra/schema.server'

const input = () => ({ expectedRevision: 0, businessName: ' Garage Dupont ', sector: 'garage', knowledge: { openingHours: '', services: '', prices: '', faq: '', instructions: '' }, transferDestination: null, recordingEnabled: false })
test('company recording defaults OFF for legacy input and accepts only explicit Boolean policy', () => {
  const { recordingEnabled: _, ...legacy } = input()
  expect(parseSaveActivityInput(legacy)).toMatchObject({ recordingEnabled: false })
  for (const recordingEnabled of [false,true]) expect(parseSaveActivityInput({ ...input(), recordingEnabled })).toMatchObject({ recordingEnabled })
  for (const recordingEnabled of ['true','false',null,0,1]) expect(() => parseSaveActivityInput({ ...input(), recordingEnabled })).toThrow(InvalidActivityInput)
})
test('strict editable input trims the greeting and normalizes line endings', () => {
  expect(parseSaveActivityInput({ ...input(), knowledge: { ...input().knowledge, services: 'Vidange\r\nPneus' }, transferDestination: '+33123456789' })).toEqual({ ...input(), businessName: 'Garage Dupont', knowledge: { ...input().knowledge, services: 'Vidange\nPneus' }, transferDestination: '+33123456789' })
  expect(parseSaveActivityInput({ ...input(), transferDestination: undefined }).transferDestination).toBeNull()
})
test.each([
  { expectedRevision: -1 }, { expectedRevision: 2147483647 }, { expectedRevision: 0.5 },
  { businessName: ' ' }, { businessName: 'x'.repeat(81) }, { businessName: 'line\nbreak' }, { businessName: '\ud800' },
  { sector: 'restaurant' }, { workspaceId: 'forged' }, { sessionId: 'forged' }, { transferDestination: '0123456789' },
  { knowledge: { ...input().knowledge, extra: 'ignored' } },
  ...Object.entries({ openingHours: 1000, services: 2000, prices: 1500, faq: 3000, instructions: 2000 }).map(([field,limit]) => ({ knowledge: { ...input().knowledge, [field]: 'x'.repeat(limit+1) } })),
  ...['\u0000', '\u0001', '\u007f', '\u0085', '\ud800', '\udc00'].map(value => ({ knowledge: { ...input().knowledge, faq: value } })),
])('rejects invalid or extra input %#', changes => {
  expect(() => parseSaveActivityInput({ ...input(), ...changes })).toThrow(InvalidActivityInput)
})
test('accepts exact UTF16 section bounds and valid supplementary scalars', () => {
  const knowledge = { openingHours: 'x'.repeat(1000), services: 'x'.repeat(2000), prices: 'x'.repeat(1500), faq: 'x'.repeat(3000), instructions: 'x'.repeat(2000) }
  expect(parseSaveActivityInput({ ...input(), knowledge }).knowledge).toEqual(knowledge)
  expect(parseSaveActivityInput({ ...input(), businessName: '😀'.repeat(40) }).businessName.length).toBe(80)
  expect(parseSaveActivityInput({ ...input(), knowledge: { ...input().knowledge, faq: '😀\t\r\n' } }).knowledge.faq).toBe('😀\t\n')
})

test.each(['select','insert'])('native %s policy requires the matching active Workspace', operation => {
  const policy = getTableConfig(sparraKnowledgeRevision).policies.find(candidate => candidate.for === operation && candidate.to === 'runtime')
  expect(policy?.to).toBe('runtime')
  const predicate = operation === 'select' ? policy?.using : policy?.withCheck
  expect(predicate).toBeDefined()
  if (!predicate) throw new Error('Missing policy')
  const emitted = new PgDialect().sqlToQuery(predicate).sql
  expect(emitted).toContain('exists')
  expect(emitted).toContain('public.workspace')
  expect(emitted).toContain("lifecycle = 'active'")
  expect(emitted).toContain('sparra_knowledge_revision"."workspace_id"')
  expect(emitted).toContain("current_setting('app.tenant_id',true)")
})
