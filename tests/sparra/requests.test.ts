import { expect, test } from 'vitest'
import { parseListRequestsInput, parseRequestInput, parseUpdateRequestFollowUpInput } from '../../src/modules/sparra/requests.server'
test('strict cursor and request ID boundaries reject extra tenant authority and noncanonical dates',()=>{
  expect(parseListRequestsInput(undefined)).toEqual({})
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  expect(parseListRequestsInput({cursor:{id,admittedAt:'2026-10-01T10:00:00.000Z'}})).toEqual({cursor:{id,admittedAt:'2026-10-01T10:00:00.000Z'}})
  for(const input of [{workspaceId:id},{cursor:{id,admittedAt:'2026-10-01T10:00:00Z'}},{cursor:{id,admittedAt:'2026-02-31T10:00:00.000Z'}},{cursor:{id:'bad',admittedAt:'2026-10-01T10:00:00.000Z'}}])expect(()=>parseListRequestsInput(input)).toThrow('Invalid request input')
  expect(parseRequestInput({requestId:id})).toEqual({requestId:id})
  expect(parseRequestInput({requestId:id.toUpperCase()})).toEqual({requestId:id})
  for(const input of [{requestId:'bad'},{requestId:id,workspaceId:id},undefined])expect(()=>parseRequestInput(input)).toThrow('Invalid request input')
})
test('follow-up requires the displayed publication and token and refuses ID-only and tenant authority',()=>{
  const requestId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',expectedDecisionToken='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const input={requestId,expectedPublicationRevision:1,expectedDecisionToken,treated:true}
  expect(parseUpdateRequestFollowUpInput(input)).toEqual(input)
  expect(parseUpdateRequestFollowUpInput({...input,expectedPublicationRevision:0})).toMatchObject({expectedPublicationRevision:0})
  expect(parseListRequestsInput({view:'all'})).toEqual({view:'all'})
  for(const value of [{requestId},{...input,expectedPublicationRevision:-1},{...input,expectedPublicationRevision:1.5},{...input,expectedDecisionToken:'bad'},{...input,treated:'true'},{...input,workspaceId:requestId}])expect(()=>parseUpdateRequestFollowUpInput(value)).toThrow('Invalid request input')
})
