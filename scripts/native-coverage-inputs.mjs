import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

export function assertDirectory(path, owner) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
    || (owner && (stat.dev !== owner.dev || stat.ino !== owner.ino))) {
    throw new Error('Native coverage directory ownership changed')
  }
  return stat
}

export function assertRunTree(path) {
  for (const name of readdirSync(path)) {
    const child = join(path, name), stat = lstatSync(child)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Unsafe native coverage run entry')
    if (stat.isDirectory()) assertRunTree(child)
  }
}

function snapshotPath(path, logical, digest, ancestors) {
  if (basename(path).startsWith('.env') || /\.(?:pem|key|p12|pfx)$/i.test(path)) return
  const stat = lstatSync(path)
  digest.update(logical).update('\0')
  if (stat.isSymbolicLink()) {
    if (!logical.startsWith('.output/server/node_modules/')) throw new Error('Unexpected source identity link')
    const target = realpathSync(path)
    digest.update('link\0').update(target).update('\0')
    return snapshotPath(target, logical + '/@resolved', digest, ancestors)
  }
  if (stat.isDirectory()) {
    const canonical = realpathSync(path)
    if (ancestors.has(canonical)) throw new Error('Cyclic source identity directory')
    const next = new Set(ancestors); next.add(canonical)
    digest.update('directory\0')
    for (const name of readdirSync(path).sort()) snapshotPath(join(path, name), logical + '/' + name, digest, next)
  } else if (stat.isFile()) digest.update('file\0').update(readFileSync(path)).update('\0')
  else throw new Error('Unsupported source identity entry')
}

export function sourceIdentity(root) {
  const digest = createHash('sha256').update(root).update('\0').update(process.version).update('\0')
  const inputs = ['src', 'scripts', 'tests', 'tools', 'patches', 'drizzle', 'public', '.output/server', '.output/public', '.output/worker',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'Dockerfile', '.dockerignore',
    '.fallowrc.json', '.oxlintrc.json', 'doctor.config.json', 'tsconfig.json', 'drizzle.config.ts',
    'vite.config.ts', 'vite.worker.config.ts', 'vitest.config.ts', 'vitest.integration.config.ts', '.output/nitro.json']
  for (const input of inputs) {
    const path = join(root, input)
    if (existsSync(path)) snapshotPath(path, input, digest, new Set())
    else digest.update(input).update('\0missing\0')
  }
  for (const input of ['node_modules/vitest/package.json', 'node_modules/@vitest/coverage-istanbul/package.json', 'node_modules/vitest/vitest.mjs']) {
    digest.update(input).update('\0').update(readFileSync(join(root, input))).update('\0')
  }
  return digest.digest('hex')
}

// Vitest 4.1.11 writes a native flatted reference table. Only admission fields
// are read here; coverage positions and counters remain exclusively native.
function blobValue(table, reference) {
  if (typeof reference !== 'string') return reference
  if (!/^\d+$/.test(reference) || Number(reference) >= table.length) throw new Error('Invalid native blob reference')
  return table[Number(reference)]
}

function passedTests(table, task, leafNames) {
  const result = blobValue(table, task.result)
  if (!result || blobValue(table, result.state) !== 'pass') throw new Error('Native blob contains an incomplete task')
  if (blobValue(table, task.type) === 'test') {
    leafNames?.push(blobValue(table, task.name))
    return 1
  }
  const children = blobValue(table, task.tasks)
  if (!Array.isArray(children)) throw new Error('Native blob contains an invalid suite')
  return children.reduce((count, reference) => count + passedTests(table, blobValue(table, reference), leafNames), 0)
}

function readBlob(filePath, startedAt, version) {
  const stat = lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs < startedAt || stat.size === 0 || stat.size > 268435456) {
    throw new Error('Native coverage blob is stale or invalid')
  }
  const bytes = readFileSync(filePath), digest = createHash('sha256').update(bytes).digest('hex')
  const table = JSON.parse(bytes.toString('utf8')), envelope = table[0]
  if (!Array.isArray(table) || !Array.isArray(envelope) || envelope.length !== 6 || blobValue(table, envelope[0]) !== version) {
    throw new Error('Native coverage blob version mismatch')
  }
  return { table, envelope, digest }
}

function admitEnvelope(table, envelope) {
  const files = blobValue(table, envelope[1]), errors = blobValue(table, envelope[2])
  const coverage = blobValue(table, envelope[3]), projects = blobValue(table, envelope[5])
  if (!Array.isArray(files) || !files.length || !Array.isArray(errors) || errors.length
    || !coverage || typeof coverage !== 'object' || Array.isArray(coverage) || !Object.keys(coverage).length
    || !projects || Object.keys(projects).length !== 1 || Object.keys(projects)[0] !== '') throw new Error('Native coverage blob is incomplete')
  return files
}

function assertSourcePath(filepath, root) {
  if (typeof filepath !== 'string' || !isAbsolute(filepath)) throw new Error('Native blob source root mismatch')
  const fromRoot = relative(root, resolve(filepath))
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + sep)) throw new Error('Native blob source root mismatch')
}

function admitCoverageEntries(table, coverage, root) {
  for (const [key, reference] of Object.entries(coverage)) {
    const record = blobValue(table, reference)
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Native coverage record is invalid')
    const path = blobValue(table, record.path)
    if (key !== path) throw new Error('Native coverage record identity mismatch')
    assertSourcePath(path, root)
  }
}

function requestsBlobFile(table,file,fileCount,root,seen) {
  const filepath=resolve(blobValue(table,file.filepath))
  const consumer=requestConsumers.find(([path])=>filepath===join(root,path))
  if(fileCount!==4||!consumer||seen.has(filepath))throw new Error('Native requests blob has an unexpected consumer')
  seen.add(filepath)
  const names=[],count=passedTests(table,file,names)
  if(count!==consumer[1].length)throw new Error('Native coverage test cardinality mismatch')
  if(names.some((name,index)=>name!==consumer[1][index]))throw new Error('Native requests blob has unexpected leaves')
  return count
}

function admitTestFile(table, file, name, fileCount, root, startedAt, seen) {
  const filepath = blobValue(table, file.filepath)
  const result = blobValue(table, file.result), project = blobValue(table, file.projectName)
  assertSourcePath(filepath, root)
  if ((project ?? '') !== '' || !result || !Number.isFinite(result.startTime) || result.startTime < startedAt) throw new Error('Native blob source root mismatch')
  if (name === 'activity' && (fileCount !== 1 || resolve(filepath) !== join(root, 'tests/integration/sparra-activity.test.ts'))) {
    throw new Error('Native activity blob has an unexpected consumer')
  }
  if (name === 'requests') return requestsBlobFile(table,file,fileCount,root,seen)
  return passedTests(table, file)
}

export function readNativeBlob(filePath, name, root, startedAt, version) {
  if(!['ordinary','activity','requests'].includes(name))throw new Error('Unknown native coverage consumer')
  const {table, envelope, digest} = readBlob(filePath, startedAt, version)
  const files = admitEnvelope(table, envelope)
  let count = 0
  const seen=new Set()
  for (const reference of files) {
    count += admitTestFile(table, blobValue(table, reference), name, files.length, root, startedAt, seen)
  }
  if (!count || (name === 'activity' && count !== 12) || (name === 'requests' && count !== 26)) throw new Error('Native coverage test cardinality mismatch')
  const coverage = blobValue(table, envelope[3])
  admitCoverageEntries(table, coverage, root)
  return { table, coverage, digest }
}

function canonicalGeometry(table, reference, ancestors, budget, depth) {
  if (--budget.remaining < 0 || depth > 32) throw new Error('Native coverage geometry exceeds its admission bound')
  const value = blobValue(table, reference)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('Native coverage geometry is unknown or cyclic')
  const next = new Set(ancestors); next.add(value)
  if (Array.isArray(value)) return '[' + value.map(item => canonicalGeometry(table, item, next, budget, depth + 1)).join(',') + ']'
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalGeometry(table, value[key], next, budget, depth + 1)).join(',') + '}'
}

export function admitCommonGeometry(ordinary, activity) {
  const budget = { remaining: 2000000 }
  for (const path of Object.keys(ordinary.coverage)) {
    if (!Object.hasOwn(activity.coverage, path)) continue
    const first = blobValue(ordinary.table, ordinary.coverage[path]), second = blobValue(activity.table, activity.coverage[path])
    for (const field of ['statementMap', 'fnMap', 'branchMap']) {
      const before = canonicalGeometry(ordinary.table, first[field], new Set(), budget, 0)
      const after = canonicalGeometry(activity.table, second[field], new Set(), budget, 0)
      if (before !== after) throw new Error('Native coverage common-file geometry mismatch')
    }
  }
}


const requestsLeafNames = [
    'native owner reads absent state, actual Voice ciphertext and pinned configuration without inventing pending results',
    'equal-millisecond pagination returns all 103 calls exactly once in tuple order',
    'treat active preserves inventory and stamp, erase deletes native content and survives retention',
    'treat closed preserves inventory and stamp, erase deletes native content and survives retention',
    'expired content stays unreadable including a Workspace lock held across retention; queued receipt outlives fence deadline',
    'native runtime UPDATE RETURNING cooperates with narrow definer, FORCE RLS and column grants',
    'fence insertion failure and cancellation roll back; recorded COMMIT cancellation rejects completion and reload resolves',
    'built native RPC enforces strict input, auth, missing and foreign Origin, bounded failures and no-store',
  ]

const requestConsumers=[
  ['tests/integration/sparra-requests.test.ts',requestsLeafNames],
  ['tests/integration/sparra-audio-reader-store.test.ts',[
    'exact release uses auth sentinel and waits for the physical Workspace lock',
    'cleanup releases the exact slot after auth loss and Workspace becomes deleting',
    'stale A capability cannot release replacement B or a foreign Workspace slot',
    'final enqueue waits for the physical Workspace lock and emits nothing after denial commits',
    'native R1 COMMIT handoff keeps successor and held release joined (unknown return: false)',
    'native R1 COMMIT handoff keeps successor and held release joined (unknown return: true)',
    'native R1 acquire COMMIT followed by early TCP close joins exact release without enqueue',
    'native R1 reader serializes same Request auth while the producer SQL result is held',
  ]],
  ['tests/integration/sparra-audio-playback.test.ts',[
    'compiled private GET returns the actual Voice PCM in the exact WAV44 representation',
    'raw playback refuses anonymous and cross-Workspace callers without exposing PCM',
    'authenticated HEAD returns WAV metadata and no binary body',
    'native single Range returns exact bytes and rejects malformed or multipart ranges',
    'native audio revoke leaves the exact released slot and truncates the paused client response',
    'native owner erase terminates a paused reader without completing unacknowledged Voice cleanup',
    'actual private browser player clears its native source on owner erase at 320 and 1280',
    'compiled R1 session loss releases the exact paused reader without erasing audio or ending the phone call',
  ]],
  ['tests/integration/sparra-audio-reader-retirement.test.ts',[
    'active owned reader cannot issue retirement proof and missing proof leaves unknown slots occupied',
    'actual crashed and removed reader proof releases only exact A through native migrator and replays idempotently',
  ]],
]

function requestsSummaryPassed(report) {
  const counters = {numTotalTests:26,numPassedTests:26,numPendingTests:0,numTodoTests:0,numFailedTests:0,numFailedTestSuites:0,numPendingTestSuites:0}
  return report?.success === true && Object.entries(counters).every(([key,wanted])=>report[key]===wanted)
}

function requestsFilePassed(file,path,names,root) {
  return file?.name===join(root,path).replaceAll('\\','/')
    && file.status==='passed' && file.message==='' && Array.isArray(file.assertionResults) && file.assertionResults.length===names.length
    && file.assertionResults.every((test,index)=>requestsLeafPassed(test,names[index]))
}

function requestsLeafPassed(test,name) {
  return test?.status==='passed' && test.fullName===name && Array.isArray(test.failureMessages) && test.failureMessages.length===0
}

function requestsConsumerPassed(report,path,names,root) {
  const matches=report.testResults.filter(file=>file?.name===join(root,path).replaceAll('\\','/'))
  return matches.length===1&&requestsFilePassed(matches[0],path,names,root)
}

export function assertRequestsReport(report,root) {
  if(!requestsSummaryPassed(report) || !Array.isArray(report.testResults) || report.testResults.length!==4
    || !requestConsumers.every(([path,names])=>requestsConsumerPassed(report,path,names,root))) {
    throw new Error('Native Requests requires its exact four consumers and 26 passing leaves')
  }
}

export function assertRequestsQualification(path,root,startedAt) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs < startedAt || stat.size === 0 || stat.size > 268435456) throw new Error('Native Requests report is invalid')
  assertRequestsReport(JSON.parse(readFileSync(path,'utf8')),root)
}

const recordingReceiptLeafNames = [
  'actual Voice archived receipt commits with provider purge due',
  'native receipt shape and exact integer/canonical deadline validation reject metadata coercion',
  'native pin and bound Workspace/deployment/provider identity cannot be supplied by a callback',
  'old receiptless bytes and changed receipts cannot clear accepted metadata or terminal purge ACK',
  'native deferred commit failure rolls back receipt metadata and immediate purge due together',
  'lost native receipt COMMIT reply replays the unchanged operation before actual local ACK',
  'erased and expired late receipts retain provider-copy obligations without archive availability',
  'provider NULL ACK remains distinct from actual archive unlink and local cleanup NULL ACK',
  'receipt columns retain FORCE RLS and execute-only native authority',
]

function recordingReceiptSummaryPassed(report) {
  const counters = {numTotalTests:9,numPassedTests:9,numPendingTests:0,numTodoTests:0,numFailedTests:0,numFailedTestSuites:0,numPendingTestSuites:0}
  return report?.success === true && Object.entries(counters).every(([key,wanted])=>report[key]===wanted)
}

function recordingReceiptFilePassed(file,root) {
  return file?.name===join(root,'tests/integration/sparra-recording-receipt.test.ts').replaceAll('\\','/')
    && file.status==='passed' && file.message==='' && Array.isArray(file.assertionResults) && file.assertionResults.length===9
}

function recordingReceiptLeafPassed(test,index) {
  return test?.status==='passed' && test.fullName===recordingReceiptLeafNames[index] && Array.isArray(test.failureMessages) && test.failureMessages.length===0
}

export function assertRecordingReceiptReport(report,root) {
  if(!recordingReceiptSummaryPassed(report) || !Array.isArray(report.testResults) || report.testResults.length!==1
    || !recordingReceiptFilePassed(report.testResults[0],root)
    || !recordingReceiptLeafNames.every((_,index)=>recordingReceiptLeafPassed(report.testResults[0].assertionResults[index],index))) {
    throw new Error('Native Recording receipt requires its exact nine passing leaves')
  }
}

export function assertRecordingReceiptQualification(path,root,startedAt) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs < startedAt || stat.size === 0 || stat.size > 268435456) throw new Error('Native Recording receipt report is invalid')
  assertRecordingReceiptReport(JSON.parse(readFileSync(path,'utf8')),root)
}
