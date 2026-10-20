import { Redacted } from 'effect'
import { describe, expect, it } from 'vitest'
import { readCalendarConfig } from '../../src/modules/calendar/config.server'

export const calendarEnv = {
  APP_ORIGIN: 'https://sparra.example',
  SPARRA_GOOGLE_CALENDAR_CLIENT_ID: 'calendar-client.apps.googleusercontent.com',
  SPARRA_GOOGLE_CALENDAR_CLIENT_SECRET: 'test-calendar-secret',
  SPARRA_CALENDAR_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64url'),
}

describe('dedicated Calendar config', () => {
  it('is absent independently of login Google and APP_ORIGIN', () => {
    expect(readCalendarConfig({ APP_ORIGIN: 'https://sparra.example', GOOGLE_CLIENT_ID: 'login' })).toBeNull()
  })
  it('normalizes the origin and redacts all dedicated credentials', () => {
    const config = readCalendarConfig({ ...calendarEnv, APP_ORIGIN: `${calendarEnv.APP_ORIGIN}/` })!
    expect(config.origin).toBe(calendarEnv.APP_ORIGIN)
    expect(Redacted.value(config.clientId)).toBe(calendarEnv.SPARRA_GOOGLE_CALENDAR_CLIENT_ID)
    expect(JSON.stringify(config)).not.toContain('test-calendar-secret')
    expect(JSON.stringify(config)).not.toContain(calendarEnv.SPARRA_CALENDAR_TOKEN_KEY)
  })
  it.each([
    { SPARRA_GOOGLE_CALENDAR_CLIENT_ID: 'only-one' },
    { ...calendarEnv, SPARRA_CALENDAR_TOKEN_KEY: `${calendarEnv.SPARRA_CALENDAR_TOKEN_KEY}=` },
    { ...calendarEnv, SPARRA_CALENDAR_TOKEN_KEY: Buffer.alloc(31).toString('base64url') },
    { ...calendarEnv, APP_ORIGIN: 'https://user:secret@sparra.example' },
    { ...calendarEnv, APP_ORIGIN: 'https://sparra.example/path' },
    { ...calendarEnv, APP_ORIGIN: 'http://sparra.example' },
    { ...calendarEnv, SPARRA_GOOGLE_CALENDAR_CLIENT_SECRET: '' },
  ])('rejects partial or invalid dedicated config safely', env => {
    expect(() => readCalendarConfig(env)).toThrow('Invalid Calendar configuration')
    try { readCalendarConfig(env) } catch (error) {
      expect(String(error)).not.toContain('test-calendar-secret')
      expect(error).not.toHaveProperty('cause')
    }
  })
  it('permits explicit loopback HTTP development', () => {
    expect(readCalendarConfig({ ...calendarEnv, APP_ORIGIN: 'http://127.0.0.1:3000' })?.origin).toBe('http://127.0.0.1:3000')
  })
})
