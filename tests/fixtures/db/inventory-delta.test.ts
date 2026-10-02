import { expect, test } from 'vitest'
import { inventoryDelta } from './disposable-stores'

test('inventory diagnostics disclose categories and changed fields without projected values', () => {
  const before = {
    states: ['container-id|/fixture-name|fixture-image|running|old-start|old-finish|0|private-ports|private-networks'],
    networks: ['network-id|private-network-name|bridge'],
    volumes: ['distinctive-private-client-project-backup-volume|local'],
  }
  const after = {
    states: ['container-id|/fixture-name|fixture-image|exited|new-start|new-finish|1|changed-private-ports|private-networks'],
    networks: ['network-id|changed-private-network-name|bridge'],
    volumes: [],
  }
  const delta = inventoryDelta(before, after, new Set(['container-id', 'network-id']))
  expect(delta).toEqual([
    { kind: 'container', id: 'container-id', ownership: 'owned', change: 'changed', fields: ['State.Status', 'State.StartedAt', 'State.FinishedAt', 'RestartCount', 'HostConfig.PortBindings'] },
    { kind: 'network', id: 'network-id', ownership: 'owned', change: 'changed', fields: ['Name'] },
    { kind: 'volume', id: expect.stringMatching(/^volume-sha256:[a-f0-9]{64}$/), ownership: 'foreign', change: 'removed', fields: ['Name', 'Driver'] },
  ])
  expect(JSON.stringify(delta)).not.toContain('private')
  expect(JSON.stringify(delta)).not.toContain('distinctive-private-client-project-backup-volume')
  expect(JSON.stringify(before)).not.toBe(JSON.stringify(after))
})

test('equal projections remain equal while an added foreign resource is classified', () => {
  const before = { states: [], networks: [], volumes: [] }
  expect(inventoryDelta(before, before, new Set())).toEqual([])
  expect(inventoryDelta(before, { ...before, networks: ['foreign-id|fixture-name|bridge'] }, new Set())).toEqual([
    { kind: 'network', id: 'foreign-id', ownership: 'foreign', change: 'added', fields: ['Id', 'Name', 'Driver'] },
  ])
})

test('opaque volume diagnostics keep raw ownership and exact projections in memory', () => {
  const name = 'distinctive-private-owner-volume'
  const before = { states: [], networks: [], volumes: [`${name}|local`] }
  const after = { ...before, volumes: [`${name}|changed-driver`] }
  const oldProjection = JSON.stringify(before)
  const newProjection = JSON.stringify(after)
  const delta = inventoryDelta(before, after, new Set([name]))
  expect(delta).toEqual([
    { kind: 'volume', id: expect.stringMatching(/^volume-sha256:[a-f0-9]{64}$/), ownership: 'owned', change: 'changed', fields: ['Driver'] },
  ])
  expect(JSON.stringify(delta)).not.toContain(name)
  expect(JSON.stringify(before)).toBe(oldProjection)
  expect(JSON.stringify(after)).toBe(newProjection)
  expect(oldProjection).not.toBe(newProjection)
  expect(inventoryDelta(before, after, new Set([name]))).toEqual(delta)
})
