import { expect, test } from 'vitest'
import { parseListRequestsInput, parseRequestInput } from '../../src/modules/sparra/requests.server'
test('strict cursor and request ID boundaries reject extra tenant authority and noncanonical dates',()=>{
  expect(parseListRequestsInput(undefined)).toEqual({})
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  expect(parseListRequestsInput({cursor:{id,admittedAt:'2026-10-01T10:00:00.000Z'}})).toEqual({cursor:{id,admittedAt:'2026-10-01T10:00:00.000Z'}})
  for(const input of [{workspaceId:id},{cursor:{id,admittedAt:'2026-10-01T10:00:00Z'}},{cursor:{id,admittedAt:'2026-02-31T10:00:00.000Z'}},{cursor:{id:'bad',admittedAt:'2026-10-01T10:00:00.000Z'}}])expect(()=>parseListRequestsInput(input)).toThrow('Invalid request input')
  expect(parseRequestInput({requestId:id})).toEqual({requestId:id})
  expect(parseRequestInput({requestId:id.toUpperCase()})).toEqual({requestId:id})
  for(const input of [{requestId:'bad'},{requestId:id,workspaceId:id},undefined])expect(()=>parseRequestInput(input)).toThrow('Invalid request input')
})
