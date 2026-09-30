import { expect, test } from 'vitest'

import {
  ConfigurationError,
  readWebConfig,
} from '../../src/platform/config.server'

const validOrigin = 'https://template.example'

test('returns frozen bounded startup settings without mutating the supplied environment', () => {
  const env = Object.freeze({ APP_ORIGIN: validOrigin })

  const config = readWebConfig(env)

  expect(config).toEqual({
    environment: 'development',
    origin: validOrigin,
    hostname: '127.0.0.1',
    port: 3000,
    requestTimeoutMs: 10000,
    shutdownTimeoutMs: 5000,
  })
  expect(Object.isFrozen(config)).toBe(true)
  expect(env).toEqual({ APP_ORIGIN: validOrigin })
})

test.each([
  ['development', 'development'],
  ['test', 'test'],
  ['production', 'production'],
] as const)('accepts NODE_ENV=%s', (value, expected) => {
  expect(readWebConfig({ APP_ORIGIN: validOrigin, NODE_ENV: value }).environment).toBe(
    expected,
  )
})

test.each(['', 'Development', 'staging', ' production '])(
  'rejects NODE_ENV=%j',
  value => {
    expectInvalidKeys({ APP_ORIGIN: validOrigin, NODE_ENV: value }, ['NODE_ENV'])
  },
)

test.each([
  ['HTTPS://Template.Example:443', 'https://template.example'],
  ['https://template.example/', 'https://template.example'],
  ['https://Template.Example:8443', 'https://template.example:8443'],
] as const)('canonicalizes APP_ORIGIN=%s', (value, expected) => {
  expect(readWebConfig({ APP_ORIGIN: value }).origin).toBe(expected)
})

test.each([
  ['development', 'http://localhost', 'http://localhost'],
  ['development', 'http://127.0.0.1', 'http://127.0.0.1'],
  ['development', 'http://[::1]', 'http://[::1]'],
  ['development', 'HTTP://LOCALHOST:8080', 'http://localhost:8080'],
  ['test', 'http://localhost:8080', 'http://localhost:8080'],
] as const)(
  'accepts loopback HTTP in %s for %s',
  (environment, origin, expected) => {
    expect(readWebConfig({ APP_ORIGIN: origin, NODE_ENV: environment }).origin).toBe(
      expected,
    )
  },
)

test.each([
  ['development', 'http://template.example'],
  ['test', 'http://template.example'],
  ['production', 'http://localhost'],
  ['production', 'http://127.0.0.1'],
  ['production', 'http://[::1]'],
  ['development', 'http://127.1'],
  ['development', 'http://2130706433'],
  ['development', 'http://[0:0:0:0:0:0:0:1]'],
] as const)('rejects HTTP origin %s in %s', (environment, origin) => {
  expectInvalidKeys({ APP_ORIGIN: origin, NODE_ENV: environment }, ['APP_ORIGIN'])
})

test.each([
  undefined,
  '',
  ' https://template.example',
  'https://template.example ',
  'ftp://template.example',
  'not-a-url',
  'https://user:password@template.example',
  'https://template.example/path',
  'https://template.example?query=value',
  'https://template.example#fragment',
  'https://template.example/a/..',
  'https://template.example\\path',
  'https://template.\nexample',
  'https://template.example:',
])('rejects invalid APP_ORIGIN=%j', value => {
  expectInvalidKeys({ APP_ORIGIN: value }, ['APP_ORIGIN'])
})

test.each([
  ['127.0.0.1', '127.0.0.1'],
  ['::1', '::1'],
  ['0.0.0.0', '0.0.0.0'],
] as const)('accepts HOST=%s', (value, expected) => {
  expect(readWebConfig({ APP_ORIGIN: validOrigin, HOST: value }).hostname).toBe(
    expected,
  )
})

test.each(['', 'localhost', '127.0.0.2', ' 127.0.0.1'])('rejects HOST=%j', value => {
  expectInvalidKeys({ APP_ORIGIN: validOrigin, HOST: value }, ['HOST'])
})

test.each([
  ['0', 0],
  ['65535', 65535],
] as const)('accepts PORT=%s as %d', (value, expected) => {
  expect(readWebConfig({ APP_ORIGIN: validOrigin, PORT: value }).port).toBe(expected)
})

test.each([
  '',
  '-1',
  '+1',
  '1.5',
  '1e3',
  '00',
  '010',
  '0x10',
  'NaN',
  'Infinity',
  '65536',
  ' 10',
  '9007199254740992',
])('rejects PORT=%j', value => {
  expectInvalidKeys({ APP_ORIGIN: validOrigin, PORT: value }, ['PORT'])
})

test.each([
  ['REQUEST_TIMEOUT_MS', '1', 1, 'requestTimeoutMs'],
  ['REQUEST_TIMEOUT_MS', '30000', 30000, 'requestTimeoutMs'],
  ['SHUTDOWN_TIMEOUT_MS', '1000', 1000, 'shutdownTimeoutMs'],
  ['SHUTDOWN_TIMEOUT_MS', '5000', 5000, 'shutdownTimeoutMs'],
  ['SHUTDOWN_TIMEOUT_MS', '30000', 30000, 'shutdownTimeoutMs'],
] as const)('accepts %s=%s', (key, value, expected, property) => {
  expect(readWebConfig({ APP_ORIGIN: validOrigin, [key]: value })[property]).toBe(
    expected,
  )
})

test.each(['', '0', '-1', '+1', '1.5', '1e3', '010', 'NaN', 'Infinity', '30001', ' 10', '9007199254740992'])(
  'rejects REQUEST_TIMEOUT_MS=%j',
  value => {
    expectInvalidKeys(
      { APP_ORIGIN: validOrigin, REQUEST_TIMEOUT_MS: value },
      ['REQUEST_TIMEOUT_MS'],
    )
  },
)

test.each(['', '0', '1', '999', '1001', '1500', '-1', '+1', '1.5', '1e3', '010', 'NaN', 'Infinity', '30001', '10 '])(
  'rejects SHUTDOWN_TIMEOUT_MS=%j',
  value => {
    expectInvalidKeys(
      { APP_ORIGIN: validOrigin, SHUTDOWN_TIMEOUT_MS: value },
      ['SHUTDOWN_TIMEOUT_MS'],
    )
  },
)

test('reports combined invalid settings in input-table order', () => {
  expectInvalidKeys(
    {
      SHUTDOWN_TIMEOUT_MS: '0',
      REQUEST_TIMEOUT_MS: '30001',
      PORT: '-1',
      HOST: 'localhost',
      APP_ORIGIN: 'http://template.example',
      NODE_ENV: 'staging',
    },
    [
      'NODE_ENV',
      'APP_ORIGIN',
      'HOST',
      'PORT',
      'REQUEST_TIMEOUT_MS',
      'SHUTDOWN_TIMEOUT_MS',
    ],
  )
})

test('ignores unrelated keys without reading or returning them', () => {
  const env: Record<string, string | undefined> = { APP_ORIGIN: validOrigin }
  Object.defineProperty(env, 'UNRELATED_SECRET', {
    enumerable: true,
    get: () => {
      throw new Error('unrelated key was read')
    },
  })

  expect(readWebConfig(env)).toEqual({
    environment: 'development',
    origin: validOrigin,
    hostname: '127.0.0.1',
    port: 3000,
    requestTimeoutMs: 10000,
    shutdownTimeoutMs: 5000,
  })
})

test('does not preserve rejected or unrelated secret values in its error', () => {
  const rejectedSecret = 'must-not-appear-in-any-error-field'
  const unrelatedSecret = 'unrelated-secret-must-not-appear'
  let caught: unknown

  try {
    readWebConfig({
      APP_ORIGIN: `https://user:${rejectedSecret}@template.example`,
      UNRELATED_SECRET: unrelatedSecret,
    })
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(ConfigurationError)
  const configError = caught as ConfigurationError
  expect(configError.invalidKeys).toEqual(['APP_ORIGIN'])
  expect(String(caught)).not.toContain(rejectedSecret)
  expect(String(caught)).not.toContain(unrelatedSecret)
  expect(JSON.stringify(caught)).not.toContain(rejectedSecret)
  expect(JSON.stringify(caught)).not.toContain(unrelatedSecret)
  expect(configError.cause).toBeUndefined()
})

function expectInvalidKeys(
  env: Readonly<Record<string, string | undefined>>,
  expected: readonly string[],
): void {
  let caught: unknown

  try {
    readWebConfig(env)
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(ConfigurationError)
  expect((caught as ConfigurationError).invalidKeys).toEqual(expected)
}
