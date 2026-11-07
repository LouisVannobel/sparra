import { expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const require = createRequire(join(root, 'package.json'))
const drizzleRequire = createRequire(require.resolve('drizzle-kit'))
const loaderPath = drizzleRequire.resolve('@esbuild-kit/esm-loader')
const loaderRequire = createRequire(loaderPath)
const corePath = loaderRequire.resolve('@esbuild-kit/core-utils')
const coreRequire = createRequire(corePath)
const doctorRequire = createRequire(require.resolve('react-doctor'))
const eslintPath = doctorRequire.resolve('eslint')
const eslintRequire = createRequire(eslintPath)
const configArrayPath = eslintRequire.resolve('@eslint/config-array')
const configArrayRequire = createRequire(configArrayPath)

// Keep provider credentials, NODE_OPTIONS, dotenv settings and developer configuration out of children.
function fixtureEnvironment(emptyEnv: string): NodeJS.ProcessEnv {
  const temporary = join(dirname(emptyEnv), 'temp')
  mkdirSync(temporary)
  return {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    DOTENV_CONFIG_PATH: emptyEnv, DOTENV_KEY: '', ESBK_DISABLE_CACHE: '1',
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sparra-dependency-contract-'))
  const emptyEnv = join(directory, 'empty.env')
  writeFileSync(emptyEnv, '')
  return {
    directory, env: fixtureEnvironment(emptyEnv),
    write(name: string, source: string) {
      const target = join(directory, name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, source)
      return target
    },
    cleanup() {
      const target = resolve(directory)
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('sparra-dependency-contract-')) {
        throw new Error('Refusing cleanup of non-owned dependency fixture')
      }
      rmSync(target, { recursive: true })
    },
  }
}

test('core-utils esbuild loopback server does not expose owned files to a foreign origin', () => {
  const owned = fixture()
  try {
    owned.write('entry.js', 'export const marker = 42\n')
    owned.write('marker.txt', 'owned-server-marker\n')
    const script = owned.write('serve.cjs', `
      const esbuild = require(${JSON.stringify(coreRequire.resolve('esbuild'))});
      (async () => {
        let context, outcome;
        try {
          context = await esbuild.context({ entryPoints: ['entry.js'], outfile: 'bundle.js', bundle: true });
          const server = await context.serve({ host: '127.0.0.1', port: 0, servedir: process.cwd() });
          const url = 'http://127.0.0.1:' + server.port + '/marker.txt';
          const control = await fetch(url, { signal: AbortSignal.timeout(3000) });
          const controlBody = await control.text();
          const foreign = await fetch(url, {
            headers: { Origin: 'https://foreign-origin.invalid' }, signal: AbortSignal.timeout(3000)
          });
          outcome = { control: { status: control.status, body: controlBody },
            foreign: { status: foreign.status, body: await foreign.text(),
              acao: foreign.headers.get('access-control-allow-origin') } };
        } finally {
          await context?.dispose();
          await esbuild.stop?.();
        }
        console.log(JSON.stringify(outcome));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `)
    const result = spawnSync(process.execPath, [script], {
      cwd: owned.directory, env: owned.env, encoding: 'utf8', windowsHide: true, timeout: 8000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const outcome = JSON.parse(result.stdout)
    expect(outcome.control).toEqual({ status: 200, body: 'owned-server-marker\n' })
    expect(outcome.foreign.status).toBe(200)
    expect(outcome.foreign.body).toBe('owned-server-marker\n')
    expect(outcome.foreign.acao).toBeNull()
  } finally { owned.cleanup() }
}, 10000)

for (const [parent, parentRequire] of [['eslint', eslintRequire], ['config-array', configArrayRequire]] as const) {
  test(`${parent} minimatch bounds level-2 preprocessing before excessive glob rows`, () => {
    const owned = fixture()
    try {
      const path = parentRequire.resolve('minimatch')
      const script = owned.write('bounded.cjs', `
        const assert = require('node:assert/strict');
        const { Minimatch } = require(${JSON.stringify(path)});
        const control = new Minimatch('src/**/*.js', { optimizationLevel: 2, braceExpandMax: 63 });
        assert.ok(control.match('src/nested/owned.js'));
        assert.equal(control.match('src/nested/owned.css'), false);
        try {
          const matcher = new Minimatch(Array(6).fill('**/../a/b').join('/'), {
            optimizationLevel: 2, braceExpandMax: 63
          });
          console.log(JSON.stringify({ rows: matcher.set.length }));
        } catch (error) {
          if (!(error instanceof RangeError) || error.message !== "optimizationLevel 2: too many patterns from '**/..'") throw error;
          console.log(JSON.stringify({ bounded: true }));
        }
      `)
      const result = spawnSync(process.execPath, [script], { cwd: owned.directory, env: owned.env,
        encoding: 'utf8', windowsHide: true, timeout: 3000 })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      const outcome: { rows?: number; bounded?: boolean } = JSON.parse(result.stdout)
      expect(outcome.bounded === true || (typeof outcome.rows === 'number' && outcome.rows <= 63), result.stdout).toBe(true)
    } finally { owned.cleanup() }
  })
}

test('core-utils preserves TypeScript transforms, names, imports and source maps', () => {
  const owned = fixture()
  try {
    owned.write('value.mjs', 'export const value = 40\n')
    const source = 'import { value } from "./value.mjs"; enum Increment { Two = 2 }; export function namedAnswer(): number { return value + Increment.Two }\n'
    const script = owned.write('transform.cjs', `
      const { transform, transformSync } = require(${JSON.stringify(corePath)});
      const { writeFileSync } = require('node:fs');
      const { resolve } = require('node:path');
      const { pathToFileURL } = require('node:url');
      const source = ${JSON.stringify(source)};
      (async () => {
        const results = [];
        for (const [name, output] of [
          ['async', await transform(source, resolve('async.mts'))],
          ['sync', transformSync(source, resolve('sync.mts'))],
        ]) {
          // The native defaults are ESM for transform and CommonJS for transformSync.
          const file = resolve(name + (name === 'sync' ? '.cjs' : '.mjs'));
          writeFileSync(file, output.code);
          const module = name === 'sync' ? require(file) : await import(pathToFileURL(file).href);
          results.push({ name, code: output.code, map: output.map,
            result: [module.namedAnswer.name, module.namedAnswer()] });
        }
        console.log(JSON.stringify(results));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `)
    const result = spawnSync(process.execPath, [script], {
      cwd: owned.directory, env: owned.env, encoding: 'utf8', windowsHide: true, timeout: 5000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const outputs: { name: string; code: string; map: string | { sources: string[]; sourcesContent: string[]; mappings: string }; result: [string, number] }[] = JSON.parse(result.stdout)
    expect(outputs.map(output => output.name)).toEqual(['async', 'sync'])
    for (const output of outputs) {
      expect(output.code).toContain('./value.mjs')
      const map = typeof output.map === 'string' ? JSON.parse(output.map) : output.map
      expect(map.sources.some((path: string) => path.endsWith(`${output.name}.mts`))).toBe(true)
      expect(map.sourcesContent).toContain(source)
      expect(map.mappings.length).toBeGreaterThan(0)
      expect(output.result).toEqual(['namedAnswer', 42])
    }
  } finally { owned.cleanup() }
}, 15000)

test('actual archived esm-loader compiles enums through static and dynamic mts imports', () => {
  const owned = fixture()
  try {
    owned.write('static.mts', 'export enum StaticValue { Answer = 40 }\n')
    owned.write('dynamic.mts', 'export enum DynamicValue { Increment = 2 }\n')
    const entry = owned.write('entry.mts', `
      import { StaticValue } from './static.mts';
      const { DynamicValue } = await import('./dynamic.mts');
      console.log(JSON.stringify({ answer: StaticValue.Answer + DynamicValue.Increment }));
    `)
    const result = spawnSync(process.execPath, ['--loader', pathToFileURL(loaderPath).href, entry], {
      cwd: owned.directory, env: owned.env, encoding: 'utf8', windowsHide: true, timeout: 10000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ answer: 42 })
  } finally { owned.cleanup() }
}, 15000)

const selectedFiles = ['src/main.js', 'src/.hidden.js', 'src/nested/example.test.js', 'lib/tool.mjs']
const ignoredFiles = ['src/generated/ignored.js', 'src/nested/skip.test.js']
const fileGlobs = ['src/**/!(*.skip).{js,mjs}', 'lib/**/+(tool|entry).mjs']
const ignores = ['**/generated/**', '**/skip.test.js']

test('actual ESLint traverses partial directories, braces, extglobs, dot files and ignores', async () => {
  const owned = fixture()
  try {
    for (const name of [...selectedFiles, ...ignoredFiles, 'src/main.skip.js', 'other/unselected.js']) {
      owned.write(name, 'debugger;\n')
    }
    const { ESLint } = doctorRequire('eslint')
    const eslint = new ESLint({ cwd: owned.directory, overrideConfigFile: true, overrideConfig: [
      { ignores }, { files: fileGlobs, rules: { 'no-debugger': 'error' } },
    ] })
    const results: { filePath: string; messages: { ruleId: string }[] }[] = await eslint.lintFiles(fileGlobs)
    expect(results.map(result => relative(owned.directory, result.filePath).replaceAll('\\', '/')).sort()).toEqual([...selectedFiles].sort())
    expect(results.every(result => result.messages.length === 1 && result.messages[0]!.ruleId === 'no-debugger')).toBe(true)
    for (const name of ignoredFiles) expect(await eslint.isPathIgnored(join(owned.directory, name))).toBe(true)
    if (process.platform === 'win32') {
      const windowsResults: { filePath: string }[] = await eslint.lintFiles(fileGlobs.map(glob => glob.replaceAll('/', '\\')))
      expect(windowsResults.map(result => relative(owned.directory, result.filePath).replaceAll('\\', '/')).sort()).toEqual([...selectedFiles].sort())
    }
  } finally { owned.cleanup() }
}, 15000)

test('actual config-array selects and ignores normalized and Windows paths', async () => {
  const { ConfigArray } = eslintRequire('@eslint/config-array')
  for (const basePath of ['/owned', 'C:\\owned']) {
    const configs = new ConfigArray([{ ignores }, { files: fileGlobs }], { basePath })
    await configs.normalize()
    const absolute = (name: string) => basePath.includes('\\') ? `${basePath}\\${name.replaceAll('/', '\\')}` : `${basePath}/${name}`
    for (const name of selectedFiles) expect(configs.getConfigWithStatus(absolute(name)).status, name).toBe('matched')
    for (const name of ignoredFiles) expect(configs.getConfigWithStatus(absolute(name)).status, name).toBe('ignored')
    expect(configs.getConfigWithStatus(absolute('other/unselected.js')).status).toBe('unconfigured')
    expect(configs.isDirectoryIgnored(absolute('src/generated'))).toBe(true)
    expect(configs.isDirectoryIgnored(absolute('src/nested'))).toBe(false)
  }
  // Match exactly the options used by both parents. Partial matching drives ESLint directory pruning.
  for (const parentRequire of [eslintRequire, configArrayRequire]) {
    const { Minimatch } = parentRequire('minimatch')
    const matcher = new Minimatch('src/**/+(main|example).{js,mjs}', { dot: true })
    expect(matcher.match('src/nested', true)).toBe(true)
    expect(matcher.match('other', true)).toBe(false)
    expect(matcher.match('src/nested/example.js')).toBe(true)
    expect(matcher.match('src/nested/nope.js')).toBe(false)
    const windows = new Minimatch('src\\**\\*.{js,mjs}', { dot: true, windowsPathsNoEscape: true, platform: 'win32' })
    expect(windows.match('src\\nested\\.hidden.js')).toBe(true)
    // Accepted v11 corrections. ESLint itself normalizes to relative forward-slash paths.
    expect(new Minimatch('//host/share/*.js', { dot: true, platform: 'win32' }).match('//HOST/SHARE/file.js')).toBe(true)
    expect(new Minimatch('//?/UNC/host/share/*.js', { dot: true, platform: 'win32' }).match('//host/share/file.js')).toBe(true)
    expect(new Minimatch('a/b/?(x)', { dot: true }).match('a/b/')).toBe(false)
  }
})

test('actual six Drizzle schemas generate SQL in owned output without loading repository dotenv', () => {
  const owned = fixture()
  try {
    const original = require(join(root, 'drizzle.config.ts')).default
    expect(original.schema).toHaveLength(6)
    const schema = original.schema.map((path: string) => resolve(root, path).replaceAll('\\', '/'))
    // Drizzle joins snapshot paths to cwd on Windows, so keep out relative to the owned child cwd.
    const config = owned.write('drizzle.config.cjs', `module.exports = ${JSON.stringify({ ...original, schema, out: './sql' })}\n`)
    const cli = join(dirname(require.resolve('drizzle-kit')), 'bin.cjs')
    const generate = () => spawnSync(process.execPath, [cli, 'generate', '--config', config], {
      cwd: owned.directory, env: owned.env, encoding: 'utf8', windowsHide: true, timeout: 20000,
    })
    const first = generate()
    expect(first.error).toBeUndefined()
    expect(first.status, first.stderr || first.stdout).toBe(0)
    expect(first.stdout).toContain('45 tables')
    const sqlFiles = readdirSync(join(owned.directory, 'sql')).filter(path => path.endsWith('.sql'))
    expect(sqlFiles).toHaveLength(1)
    const sql = readFileSync(join(owned.directory, 'sql', sqlFiles[0]!), 'utf8')
    expect(sql.match(/CREATE TABLE /g)).toHaveLength(45)
    expect(sql.match(/CREATE POLICY /g)).toHaveLength(76)
    for (const table of ['user', 'workspace', 'sparra_call', 'billing_agreement', 'sparra_calendar_connection']) {
      expect(sql).toContain(`CREATE TABLE "${table}"`)
    }
    expect(sql).toContain('CREATE TABLE "voice_private"."deployment_binding"')
    for (const policy of ['voice_binding_read', 'calendar_owner', 'sparra_call_read', 'billing_customer_runtime_read']) {
      expect(sql).toContain(`CREATE POLICY "${policy}"`)
    }
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    const snapshotTree = (directory: string): Record<string, string> => Object.fromEntries(
      readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).flatMap(entry => {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) return Object.entries(snapshotTree(path)).map(([name, hash]) => [`${entry.name}/${name}`, hash])
        return [[entry.name, createHash('sha256').update(readFileSync(path)).digest('hex')]]
      }),
    )
    const initialTree = snapshotTree(join(owned.directory, 'sql'))
    expect(Object.keys(initialTree).some(path => /meta\/\d+_snapshot\.json$/.test(path))).toBe(true)
    expect(initialTree['meta/_journal.json']).toBeDefined()
    const second = generate()
    expect(second.error).toBeUndefined()
    expect(second.status, second.stderr || second.stdout).toBe(0)
    expect(second.stdout + second.stderr).toContain('No schema changes')
    expect(snapshotTree(join(owned.directory, 'sql'))).toEqual(initialTree)
  } finally { owned.cleanup() }
}, 45000)
