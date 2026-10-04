import { expect, test } from 'vitest'
import { classifyActivityFailure } from '../../src/ui/sparra/activity-panel'

test.each(['ensure','save','latest'] as const)('activity %s keeps native refusal, conflict and validation outcomes distinct',async mode=>{
  expect(classifyActivityFailure,'activity failure classification is required before applying UI effects').toBeTypeOf('function')
  expect(classifyActivityFailure(mode,new Response(null,{status:401}))).toEqual({kind:'refused'})
  expect(classifyActivityFailure(mode,new Response(null,{status:409}))).toEqual({kind:'error',reason:'conflict'})
  expect(classifyActivityFailure(mode,new Response(null,{status:400}))).toEqual({kind:'error',reason:'invalid'})
})

test.each([
  {mode:'ensure' as const,expected:{kind:'error',reason:'unavailable'}},
  {mode:'save' as const,expected:{kind:'uncertain'}},
  {mode:'latest' as const,expected:{kind:'error',reason:'unavailable'}},
])('activity $mode treats an unconfirmed outcome according to the attempted operation',async({mode,expected})=>{
  expect(classifyActivityFailure,'activity failure classification is required before applying UI effects').toBeTypeOf('function')
  for(const failure of [Response.error(),new Response(null,{status:500}),new Error('Response delivery failed'),{status:401},null]){
    expect(classifyActivityFailure(mode,failure)).toEqual(expected)
  }
})
