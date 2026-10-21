import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export function assertDirectory(path, owner) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
    || (owner && (stat.dev !== owner.dev || stat.ino !== owner.ino))) {
    throw new Error('Native coverage directory ownership changed')
  }
  return stat
}

export function assertMailRetryBuildConfig(root, output, config) {
  if (!output || !isAbsolute(output) || resolve(config.root) !== root || realpathSync(config.root) !== root
    || resolve(config.build.outDir) !== output || config.envDir !== false || config.build.copyPublicDir !== false) throw new Error('Native mail retry build ownership refused')
  const run = dirname(output)
  if (dirname(run) !== join(root, 'coverage') || !/^\.native-[0-9a-f-]{36}$/.test(basename(run))
    || basename(output) !== 'mail-retry-build') throw new Error('Native mail retry build ownership refused')
  for (const path of [root, join(root, 'coverage'), run, output]) {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error('Native mail retry build ownership refused')
  }
}

export function readMailRetryBuildIdentity(buildDirectory, startedAt) {
  assertDirectory(buildDirectory)
  if (readdirSync(buildDirectory).sort().join('|') !== 'harness.mjs|hatchet-empty.yaml') throw new Error('Native mail retry build requires its exact resources')
  const digest = createHash('sha256')
  for (const name of ['harness.mjs', 'hatchet-empty.yaml']) {
    const path = join(buildDirectory, name), stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs < startedAt || stat.size === 0 || stat.size > 268435456) throw new Error('Native mail retry build is stale or invalid')
    digest.update(name).update('\0').update(readFileSync(path)).update('\0')
  }
  if (readFileSync(join(buildDirectory, 'hatchet-empty.yaml'), 'utf8') !== '{}\n') throw new Error('Native mail retry configuration changed')
  return digest.digest('hex')
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

function passedLeafNames(table,file,expectedNames,refusal) {
  const names=[],count=passedTests(table,file,names)
  if(count!==expectedNames.length)throw new Error('Native coverage test cardinality mismatch')
  if(names.some((name,index)=>name!==expectedNames[index]))throw new Error(refusal)
  return count
}

function requestsBlobFile(table,file,fileCount,root,seen) {
  const filepath=resolve(blobValue(table,file.filepath))
  const consumer=requestConsumers.find(([path])=>filepath===join(root,path))
  if(fileCount!==5||!consumer||seen.has(filepath))throw new Error('Native requests blob has an unexpected consumer')
  seen.add(filepath)
  return passedLeafNames(table,file,consumer[1],'Native requests blob has unexpected leaves')
}

function billingBlobFile(table,file,fileCount,root,seen) {
  const filepath=resolve(blobValue(table,file.filepath))
  const consumer=billingConsumers.find(([path])=>filepath===join(root,path))
  if(fileCount!==9||!consumer||seen.has(filepath))throw new Error('Native billing blob has an unexpected consumer')
  seen.add(filepath)
  return passedLeafNames(table,file,consumer[1],'Native billing blob has unexpected leaves')
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
  if (name === 'billing') return billingBlobFile(table,file,fileCount,root,seen)
  if (name === 'calendar') return calendarBlobFile(table,file,fileCount,root,seen)
  return passedTests(table, file)
}

export function readNativeBlob(filePath, name, root, startedAt, version) {
  if(!['ordinary','activity','requests','billing','calendar'].includes(name))throw new Error('Unknown native coverage consumer')
  const {table, envelope, digest} = readBlob(filePath, startedAt, version)
  const files = admitEnvelope(table, envelope)
  let count = 0
  const seen=new Set()
  for (const reference of files) {
    count += admitTestFile(table, blobValue(table, reference), name, files.length, root, startedAt, seen)
  }
  if (!count || (name === 'activity' && count !== 12) || (name === 'requests' && count !== 40)
    || (name === 'billing' && count !== 91) || (name === 'calendar' && count !== 42)) throw new Error('Native coverage test cardinality mismatch')
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
    'native owner lists only the first authenticated nonblank caller excerpt without inventing result fields',
    'native caller excerpt preserves the exact bound without inventing a summary',
    'native caller excerpt preserves the over bound without inventing a summary',
    'native caller excerpt preserves the Unicode bound without inventing a summary',
    'native caller excerpt preserves the blank caller without inventing a summary',
    'invalid result may expose a valid caller excerpt but missing keys and unauthenticated turns cannot',
    'an assistant turn without a caller never supplies an Inbox excerpt',
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
  ['tests/integration/sparra-audio-connected.test.ts',[
    'native OFF call keeps its original pin when the owner saves ON during the call',
    'native caller two before acceptance keeps the call active without retaining audio',
    'native caller two during capture rejects reactivation after processing late caller one and PCM',
    'native PARTIAL hangup capture and private reader join erase after the real Voice ACK',
    'native ON capture reaches ready through normal EndFrame and serves its original 30-day WAV',
    'native candidate CLI refuses stopped success after post-close fixture failure (protocol only)',
    'native accepted local capture joins before real request_human transfer intent and SDK dispatch',
  ]],
]

function requestsSummaryPassed(report) {
  const counters = {numTotalTests:40,numPassedTests:40,numPendingTests:0,numTodoTests:0,numFailedTests:0,numFailedTestSuites:0,numPendingTestSuites:0}
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
  if(!requestsSummaryPassed(report) || !Array.isArray(report.testResults) || report.testResults.length!==5
    || !requestConsumers.every(([path,names])=>requestsConsumerPassed(report,path,names,root))) {
    throw new Error('Native Requests requires its exact five consumers and 40 passing leaves')
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

const mailRetryLeafName = 'I3 one owned native retry fixture: retained A/B, transient C, expired E, exhausted D'

export function assertMailRetryReport(report, root, startedAt) {
  const counters = {numTotalTests:1,numPassedTests:1,numPendingTests:0,numTodoTests:0,numFailedTests:0,numFailedTestSuites:0,numPendingTestSuites:0}
  if (report?.success !== true || !Object.entries(counters).every(([key, wanted]) => report[key] === wanted)
    || !Number.isFinite(report.startTime) || report.startTime < startedAt
    || !Array.isArray(report.testResults) || report.testResults.length !== 1
    || !mailRetryFilePassed(report.testResults[0], root, startedAt)) throw new Error('Native mail retry requires its exact one passing parent')
}

function mailRetryFilePassed(file, root, startedAt) {
  const leaf = file?.assertionResults?.[0]
  return file?.name === join(root, 'tests/integration/mail-retry-native.test.ts').replaceAll('\\', '/')
    && file.status === 'passed' && file.message === '' && Number.isFinite(file.startTime) && file.startTime >= startedAt
    && Array.isArray(file.assertionResults) && file.assertionResults.length === 1
    && leaf?.status === 'passed' && leaf.fullName === mailRetryLeafName
    && Array.isArray(leaf.failureMessages) && leaf.failureMessages.length === 0
}

function readMailRetryRecord(path, startedAt) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs < startedAt || stat.size === 0 || stat.size > 268435456) throw new Error('Native mail retry report or receipt is invalid')
  return JSON.parse(readFileSync(path, 'utf8'))
}

function assertMailRetryHashes(receipt, root, buildDirectory) {
  const paths = ['src/modules/auth/mail-worker.server.ts', 'src/modules/auth/mail-hatchet.server.ts', 'src/modules/auth/plunk.server.ts',
    'tests/helpers/mail-retry-harness.ts', 'tests/helpers/mail-retry-entry.ts', 'tests/helpers/mail-retry-observation.ts', 'tests/helpers/vite.mail-retry.config.ts',
    'tests/integration/mail-retry-native.test.ts', '.output/worker/index.mjs',
    ...['harness.mjs', 'hatchet-empty.yaml'].map(name => relative(root, join(buildDirectory, name)).replaceAll('\\', '/'))]
  const hashes = receipt?.beforeLaunchSha256
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes) || Object.keys(hashes).sort().join('|') !== [...paths].sort().join('|')
    || !paths.every(path => hashes[path] === createHash('sha256').update(readFileSync(join(root, path))).digest('hex'))) throw new Error('Native mail retry receipt source changed')
}

function assertMailRetryCleanupReceipt(receipt, cleanup, names) {
  if (receipt?.passed !== true || receipt.failure !== undefined || cleanup?.forced !== false || cleanup.processCode !== 0 || cleanup.exactOutputEmpty !== true
    || !cleanup.receipts || Object.keys(cleanup.receipts).sort().join('|') !== [...names].sort().join('|')
    || !names.every(name => cleanup.receipts[name] === true)) throw new Error('Native mail retry retirement is unconfirmed')
}

function assertMailRetryNormalStop(receipt, stop) {
  if (receipt.normalStop.processClosed !== true || !Number.isFinite(receipt.normalStop.elapsedMs) || receipt.normalStop.elapsedMs > 15000
    || stop?.type !== 'stopped' || stop.nativeStartState !== 'resolved' || stop.nativeStopState !== 'resolved'
    || stop.pendingHooks !== 0 || stop.commandsJoined !== true) throw new Error('Native mail retry retirement is unconfirmed')
}

function assertMailRetryRetirement(receipt) {
  const names = ['rowLockReleased', 'childClosed', 'webPoolClosed', 'engineRemoved', 'storesRemoved', 'tlsClosedAndMaterialsRemoved']
  const cleanup = receipt?.cleanup, stop = receipt?.normalStop?.receipt
  assertMailRetryCleanupReceipt(receipt, cleanup, names)
  assertMailRetryNormalStop(receipt, stop)
}

export function assertMailRetryQualification(path, root, startedAt, evidenceDirectory) {
  const runDirectory = dirname(evidenceDirectory), buildDirectory = join(runDirectory, 'mail-retry-build')
  if (dirname(runDirectory) !== join(root, 'coverage') || !/^\.native-[0-9a-f-]{36}$/.test(basename(runDirectory))
    || basename(evidenceDirectory) !== 'mail-retry-evidence' || path !== join(runDirectory, 'mail-retry-qualification.json')) throw new Error('Native mail retry evidence is not owned')
  for (const directory of [join(root, 'coverage'), runDirectory, evidenceDirectory, buildDirectory]) assertDirectory(directory)
  assertRunTree(buildDirectory)
  assertMailRetryReport(readMailRetryRecord(path, startedAt), root, startedAt)
  const files = readdirSync(evidenceDirectory)
  if (files.length !== 1 || !/^task-7-i3-native-[0-9a-f-]{36}\.json$/.test(files[0])) throw new Error('Native mail retry requires exactly one fresh receipt')
  const receipt = readMailRetryRecord(join(evidenceDirectory, files[0]), startedAt)
  if (files[0] !== 'task-7-i3-native-' + receipt?.evidenceId + '.json') throw new Error('Native mail retry receipt identity changed')
  assertMailRetryHashes(receipt, root, buildDirectory)
  assertMailRetryRetirement(receipt)
}

const billingConsumers=[
  ['tests/integration/billing-consumer-migration.test.ts',[
    'forward billing migration preserves populated consumer0022 auth, Inbox and audio rows and migration receipts',
  ]],
  ['tests/integration/billing-consumer-authority.test.ts',[
    'native financial lease admits a fresh passkey and exposes only that Workspace',
    'native financial authority refuses Google session',
    'native financial authority refuses stale passkey',
    'native financial authority refuses pending session',
    'native financial authority refuses expired session',
    'native financial authority refuses stale activity',
    'native financial authority refuses future passkey',
    'native financial authority refuses generation mismatch',
    'native financial authority refuses recovery',
    'native financial authority refuses hold',
    'native financial authority refuses unverified email',
    'native financial authority refuses deleting Workspace',
    'technical billing logins enforce exact function grants, FORCE RLS and no role impersonation',
  ]],
  ['tests/integration/billing-negotiated-checkout.test.ts',[
    'two Workspaces resolve only their own agreed monthly conditions under the financial lease',
    'SQL admission refuses inconsistent commercial snapshot 0',
    'SQL admission refuses inconsistent commercial snapshot 1',
    'SQL admission refuses inconsistent commercial snapshot 2',
    'SQL admission refuses inconsistent commercial snapshot 3',
    'A to B during the Price GET refuses stale A even when Price, currency and amount are identical',
    'after admission a newer agreement cannot replace the operation slot or its send identity',
    'conditions and operation binding are immutable and runtime has no terms writer or legacy admission',
    'without agreement and without existing Checkout there is zero provider I/O, including Customer creation',
    'known subscription cancellation after terms B still targets subscription A',
    'first native Checkout creates Customer and retains admitted A after B is inserted during the provider send',
  ]],
  ['tests/integration/billing-consumer-webhook.test.ts',[
    'native Google session and persisted call Inbox remain usable with absent Stripe configuration',
    'native Google session and persisted call Inbox remain usable with partial Stripe configuration',
    'signed duplicate and reordered native webhook events each retain one atomic receipt, command and outbox without granting paid access',
    'native webhook rejects signature before any durable receipt',
    'native webhook rejects version before any durable receipt',
    'native webhook rejects account before any durable receipt',
    'native webhook rejects oversize before any durable receipt',
    'aborting a native request body closes its client transport and produces no receipt or paid right',
    'native server shutdown joins an unfinished webhook body before normal process and store retirement',
    'signed native dp Dispute retains one unassigned SQL receipt and no paid right',
    'signed native du Dispute retains one unassigned SQL receipt and no paid right',
    'signed native du Dispute keeps signature rejection before any SQL receipt',
    'signed native du Dispute keeps account rejection before any SQL receipt',
    'signed native du Dispute keeps environment rejection before any SQL receipt',
    'signed native du Dispute keeps object rejection before any SQL receipt',
    'signed native du Dispute keeps prefix rejection before any SQL receipt',
    'signed native du Dispute keeps charge rejection before any SQL receipt',
  ]],
  ['tests/integration/billing-consumer-browser.test.ts',[
    'compiled billing redirects anonymous navigation and never provisions a null Workspace',
    'compiled Google navigation exposes Billing while native financial authority refuses without affecting Inbox',
    'compiled fresh passkey billing stays truthful in FR EN at320 with keyboard access and forged Checkout returns',
    'compiled partial Stripe configuration preserves private navigation and a fresh passkey unavailable billing screen',
    'compiled protected refresh ignores a late departed read and clears private content after native session refusal',
    'compiled billing UI validates Checkout navigation and uses exact Workspace POSTs without trusting cancellation acknowledgements',
  ]],
  ['tests/integration/billing-worker-native.test.ts',[
    'compiled billing-only worker registers and drains with no mail configuration or provider effect',
    'three native mail arrivals finish while billing waits on owned SQL, then immutable A reconciles after B beyond startup deadline',
    'post-response native admission ACK loss resolves the same durable outbox and run with one dispatch',
    'native worker shutdown during a held Stripe read body joins the client transport before billing SQL stop',
  ]],
  ['tests/integration/mail-worker-native.test.ts',[
    'built application relay and native worker consume the real SQL snapshot through controlled TLS and drain on shutdown',
  ]],
  ['tests/integration/billing-dispute-namespace.test.ts',[
    'native SQL receipt authority independently admits du and refuses unknown namespace or inconsistent risk references',
    'native worker SQL records dp and du facts under the exact observed scope without creating paid entitlement',
  ]],
  ['tests/integration/billing-commercial-offer.test.ts',[
    "first assignment inserts once and an identical explicit retry observes the same immutable row",
    "a stale or competing offer cannot append while an explicitly newer revision can",
    "two concurrent competing assignments with the same expected revision have one winner",
    "invalid provider Price ('wrong object') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('inactive') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('foreign ID') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('wrong mode') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('wrong currency') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('wrong amount') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('missing amount') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('zero amount') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('unsafe amount') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('one time') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('missing recurrence') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('tiered') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('yearly') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('two months') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('metered') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('meter') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('quantity transformation') causes zero native terms writes and only owned GETs",
    "invalid provider Price ('custom amount') causes zero native terms writes and only owned GETs",
    "a foreign own Account is refused before the Price read or any terms write",
    "the real bounded provider reader performs only own-account and exact Price GETs before assignment",
    "foreign protected config scope refuses before provider creation 0",
    "foreign protected config scope refuses before provider creation 1",
    "provider reads and cleanup complete outside a database transaction or Workspace lock",
    "provider read failure exposes a constant-safe error, performs zero SQL writes and retires ownership",
    "provider close failure exposes a constant-safe error, performs zero SQL writes and retires ownership",
    "unavailable Workspace missing refuses without a terms row",
    "unavailable Workspace provisioning refuses without a terms row",
    "unavailable Workspace deleting refuses without a terms row",
    "exact retry is scoped to Workspace/account/environment and does not borrow a foreign revision",
    "native triggers preserve immutability/revision and runtime, relay and worker cannot assign",
    "an unacknowledged real COMMIT is unknown, never replayed, and a later explicit retry observes its row",
    "Checkout consumes its operator-assigned terms and retains its admitted conditions after a newer assignment",
    "the native Node24 imported assignment executes real SQL without a bundler",
  ]],
]

function billingSummaryPassed(report) {
  const counters={numTotalTests:91,numPassedTests:91,numPendingTests:0,numTodoTests:0,numFailedTests:0,numFailedTestSuites:0,numPendingTestSuites:0}
  return report?.success===true&&Object.entries(counters).every(([key,wanted])=>report[key]===wanted)
}

export function assertBillingReport(report,root) {
  if(!billingSummaryPassed(report)||!Array.isArray(report.testResults)||report.testResults.length!==9
    ||!billingConsumers.every(([path,names])=>{
      const matches=report.testResults.filter(file=>file?.name===join(root,path).replaceAll('\\','/'))
      const file=matches[0]
      return matches.length===1&&file.status==='passed'&&file.message===''
        &&Array.isArray(file.assertionResults)&&file.assertionResults.length===names.length
        &&file.assertionResults.every((test,index)=>test?.status==='passed'&&test.fullName===names[index]
          &&Array.isArray(test.failureMessages)&&test.failureMessages.length===0)
    })) {
    throw new Error('Native Billing requires its exact nine consumers and 91 passing leaves')
  }
}

export function assertBillingQualification(path,root,startedAt) {
  const stat=lstatSync(path)
  if(!stat.isFile()||stat.isSymbolicLink()||stat.mtimeMs<startedAt||stat.size===0||stat.size>268435456)throw new Error('Native Billing report is invalid')
  assertBillingReport(JSON.parse(readFileSync(path,'utf8')),root)
}

const calendarConsumers=[
  [
    "tests/integration/calendar-owner.test.ts",
    [
      "refuses absent/revoked admission or missing Workspace without fabricating saved rules",
      "separate consent uses canonical callback, PKCE, required scopes and one-shot session-bound state",
      "scope denial and absent refresh token cannot create a durable connection",
      "save verifies real writable destination and policy revision; no settings inferred from knowledge",
      "a subject cannot be active in two Workspaces and RLS excludes foreign connection writes",
      "disconnect fences delayed OAuth settlement and never revokes later credentials",
      "revocation barrier disables immediately and rejects reconnect until settled, across owner instances",
      "refresh is serialized and stale refresh cannot restore disconnected credentials",
      "refresh rejects a different subject and disables booking on lost writable calendar access",
      "superseded or expired intentions never exchange and consent denial consumes the intention",
      "proven pre-dispatch refusal retains subject exclusivity and allows a later safe attempt",
      "provider outages preserve safe account controls and revoked grants explicitly require reconnect",
      "Google canonical userinfo.email grant is accepted for initial consent and renewal",
      "accepted revoke with lost response keeps its claim across local close and cannot be resent or replaced",
      "reconnect retires both stored credentials when the refresh token is already revoked",
      "reconnect retires both stored credentials when the refresh token is already expired",
      "invalid refresh token followed by ambiguous access-token revocation keeps the replacement barrier",
      "a nonterminal revoke 400 never retires the grant or permits replacement"
    ]
  ],
  [
    "tests/integration/calendar-bridge.test.ts",
    [
      "Calendar exact function catalog is installed and execute-only worker has no memberships/table access",
      "binding/OID authority, erasure and private projections precede replay",
      "revised policy and authority/PII injection fail closed",
      "replication lag cannot admit a write; actual persisted roles/order and playback acknowledgement are required",
      "overlapping distinct starts cannot both reserve; unknown keeps the interval after lease/offer expiry",
      "revision, disconnect and deadline are rechecked at final send transition",
      "an unexpired offer starting in -1 minutes cannot bypass current notice at admission",
      "an unexpired offer starting in 30 minutes cannot bypass current notice at admission",
      "final send refuses an admitted slot now starting in -1 minutes without marking possible send",
      "final send refuses an admitted slot now starting in 30 minutes without marking possible send",
      "one existing workId/generation owner controls refresh and stale settlement cannot restore disconnect",
      "expired opaque offers and foreign call replay are refused",
      "native worker store commits before HTTP, confirms Inbox independently and erasure fences subsequent writes",
      "confirmed observations move or release the current hold while preserving original confirmation evidence",
      "erasure after possible submission keeps only unresolved proof and never restores Inbox content",
      "a foreign bound Workspace and replacement login OID cannot impersonate an admitted call through GUCs"
    ]
  ],
  [
    "tests/integration/calendar-panel-browser.test.ts",
    [
      "keyboard selects calendar, edits actual service and hours, and preserves draft after stale revision refusal",
      "keyboard reconnect waits for disconnect before issuing new consent",
      "keyboard reconnect cannot issue replacement consent while revocation remains unresolved"
    ]
  ],
  [
    "tests/integration/calendar-consumer.test.ts",
    [
      "compiled Calendar RPC exports are available to the authenticated native consumer",
      "native phone-only Calendar confirmed preserves booking authority and the authenticated compiled Inbox",
      "native phone-only Calendar lost-response-restart preserves booking authority and the authenticated compiled Inbox",
      "native phone-only Calendar no-ack preserves booking authority and the authenticated compiled Inbox",
      "native phone-only Calendar retry-after-no-ack preserves booking authority and the authenticated compiled Inbox"
    ]
  ]
]

function calendarBlobFile(table,file,fileCount,root,seen) {
  const filepath=resolve(blobValue(table,file.filepath))
  const consumer=calendarConsumers.find(([path])=>filepath===join(root,path))
  if(fileCount!==4||!consumer||seen.has(filepath))throw new Error('Native Calendar blob has an unexpected consumer')
  seen.add(filepath)
  return passedLeafNames(table,file,consumer[1],'Native Calendar blob has unexpected leaves')
}
export function assertCalendarReport(report,root) {
  const counters={numTotalTests:42,numPassedTests:42,numPendingTests:0,numTodoTests:0,numFailedTests:0,numFailedTestSuites:0,numPendingTestSuites:0}
  if(report?.success!==true||Object.entries(counters).some(([key,value])=>report[key]!==value)
    ||!Array.isArray(report.testResults)||report.testResults.length!==4
    ||!calendarConsumers.every(([path,names])=>{
      const matches=report.testResults.filter(file=>file?.name===join(root,path).replaceAll('\\','/'))
      const file=matches[0]
      return matches.length===1&&file.status==='passed'&&file.message===''
        &&Array.isArray(file.assertionResults)&&file.assertionResults.length===names.length
        &&file.assertionResults.every((test,index)=>test?.status==='passed'&&test.fullName===names[index]
          &&Array.isArray(test.failureMessages)&&test.failureMessages.length===0)
    })) throw new Error('Native Calendar requires its exact four consumers and 42 passing leaves')
}
export function assertCalendarQualification(path,root,startedAt) {
  const stat=lstatSync(path)
  if(!stat.isFile()||stat.isSymbolicLink()||stat.mtimeMs<startedAt||stat.size===0||stat.size>268435456)throw new Error('Native Calendar report is invalid')
  assertCalendarReport(JSON.parse(readFileSync(path,'utf8')),root)
}
