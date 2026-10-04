import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { Client } from 'pg'
import { fetch as imageFetch } from 'undici'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate as migrateDrizzle } from 'drizzle-orm/node-postgres/migrator'
import { unusedLoopbackPort } from '../../helpers/web-process.ts'
import { proveHatchetStatementDeadline, readHatchetClaimExpiry, readHatchetClock, readHatchetRestartSnapshot } from './hatchet-restart-observation.ts'
import { fixtureDockerEndpoint, fixtureDockerEnvironment, assertFixtureDockerEndpoint, fixtureDockerFileUser } from './docker-endpoint.ts'
import { awaitCredentialInit,retireFixtureDirectory } from '../../helpers/credential-init-retirement.ts'

const exec = promisify(execFile)
const label = 'projetv0.template.auth-fixture'
const images = {
  pg: 'postgres@sha256:c1b3783309b6499c795eed7c20135a1a4d25cae1b575c3d52c6f536129a1b109',
  pool: 'edoburu/pgbouncer@sha256:7d7a27d9e90985cab5cf42256f5c13a3120baa4b055b69df37beb272b89b2340',
  redis: 'redis@sha256:ccd6aa8d45ff3f033d6fa15b8cc1a50579f65c89f38cf9bb607a954c4f2128ed',
  node: 'node@sha256:4bd6219054c8bebcd26a66bfd8ca0bd6e1024b4b97474c59bb7ee3bbcbef4fe8',
}
const hatchetImage = 'ghcr.io/hatchet-dev/hatchet/hatchet-lite@sha256:098f549448de860e95f79f93583dc353be3143a6bb2f6eba446b3d443e39e838'
const essentials = () => fixtureDockerEnvironment()
async function docker(args: string[], env: Record<string, string> = {},timeoutMs=120000) {
  try {
    return (await exec('docker', [...fixtureDockerEndpoint(process.platform).args, ...args], {
      env: { ...essentials(), ...env }, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024,
    })).stdout.trim()
  } catch { throw new Error(`Disposable Docker operation failed: ${args[0]}`) }
}
async function inventory() {
  const ids = (await docker(['ps', '-aq', '--no-trunc'])).split(/\s+/).filter(Boolean)
  // Inspect only these non-secret fields; never inspect an existing Config.Env.
  const states = ids.length ? (await docker(['inspect', ...ids, '--format', '{{.Id}}|{{.Name}}|{{.Image}}|{{.State.Status}}|{{.State.StartedAt}}|{{.State.FinishedAt}}|{{.RestartCount}}|{{json .HostConfig.PortBindings}}|{{json .NetworkSettings.Networks}}'])).split('\n').sort() : []
  return { states, networks: (await docker(['network', 'ls', '--no-trunc', '--format', '{{.ID}}|{{.Name}}|{{.Driver}}'])).split('\n').sort(), volumes: (await docker(['volume', 'ls', '--format', '{{.Name}}|{{.Driver}}'])).split('\n').sort() }
}

// Describe only the existing non-secret projection; the unchanged-inventory guard stays exact.
export function inventoryDelta(before:Awaited<ReturnType<typeof inventory>>,after:Awaited<ReturnType<typeof inventory>>,ownedIds:ReadonlySet<string>) {
  const fields=['Id','Name','Image','State.Status','State.StartedAt','State.FinishedAt','RestartCount','HostConfig.PortBindings','NetworkSettings.Networks']
  const rows=(values:string[])=>new Map(values.map(value=>{const parts=value.split('|');return [parts[0],parts] as const}))
  const changes=(oldRows:string[],newRows:string[],names:string[],kind:string)=>{
    const old=rows(oldRows),next=rows(newRows)
    return [...new Set([...old.keys(),...next.keys()])].sort().flatMap(id=>{
      const a=old.get(id),b=next.get(id)
      const changed=a&&b?names.filter((_name,index)=>a[index]!==b[index]):names
      const diagnosticId=kind==='volume'?'volume-sha256:'+createHash('sha256').update(id).digest('hex'):id
      return changed.length?[{kind,id:diagnosticId,ownership:ownedIds.has(id)?'owned':'foreign',change:!a?'added':!b?'removed':'changed',fields:changed}]:[]
    })
  }
  return [...changes(before.states,after.states,fields,'container'),...changes(before.networks,after.networks,['Id','Name','Driver'],'network'),...changes(before.volumes,after.volumes,['Name','Driver'],'volume')]
}

export async function startDisposableStores(artifactDirectory = resolve('.output')) {
  const result = await startAuthFixture(artifactDirectory)
  if (result.kind !== 'stores') throw new Error('Unexpected fixture kind')
  return result
}

/** Named engine qualification extension; no web artifact or app stores are booted. */
export async function startDisposableHatchet() {
  const result = await startAuthFixture(undefined)
  if (result.kind !== 'hatchet') throw new Error('Unexpected fixture kind')
  return result
}

export function createHatchetAdministrator(connectionString: string) {
  return new Client({ connectionString, connectionTimeoutMillis: 500 })
}

async function startAuthFixture(artifactDirectory: string | undefined) {
  const hatchet = artifactDirectory === undefined
  const endpoint = fixtureDockerEndpoint(process.platform)
  const privateFileUser = hatchet ? [] : fixtureDockerFileUser(process.platform, process.getuid?.(), process.getgid?.())
  const actualEndpoint = process.platform === 'win32'
    ? JSON.parse(await docker(['context', 'inspect', 'desktop-linux']))[0]?.Endpoints?.docker?.Host
    : endpoint.endpoint
  await assertFixtureDockerEndpoint(process.platform, actualEndpoint)
  const engine = JSON.parse(await docker(['version', '--format', '{{json .Server}}']))
  if (engine.Os !== 'linux' || engine.Arch !== 'amd64') throw new Error('Fixture requires Linux amd64 engine')
  const before = await inventory()
  const runId = randomUUID()
  const prefix = `template-auth-${runId}`
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`))
  const owned: { id: string; name: string }[] = []
  const ownedVolumes: string[] = []
  const pendingInitCli=new Set<ReturnType<typeof spawn>>()
  let network: string | undefined
  let administrator: Client | undefined
  const secret = () => randomBytes(32).toString('hex')
  const migrationPassword = secret(), runtimePassword = secret(), poolPassword = secret(), redisPassword = secret(), hmac = secret()
  const selectedImages = hatchet ? { pg: images.pg, hatchet: hatchetImage } : images
  const evidence: Record<string, unknown> = { runId, engine: { version: engine.Version, os: engine.Os, arch: engine.Arch }, images: selectedImages, before, containers: owned, directory }
  async function assertOwned(id: string) {
    const value = JSON.parse(await docker(['inspect', id, '--format', '{{json .Config.Labels}}']))
    if (value[label] !== runId || !owned.some(item => item.id === id)) throw new Error('Refusing non-owned fixture container')
  }
  async function create(kind: string, image: string, args: string[], env: Record<string, string> = {}, command: string[] = [], networkName = network!) {
    const name = `${prefix}-${kind}`
    const id = await docker(['create', '--name', name, '--label', `${label}=${runId}`, '--network', networkName, ...args, image, ...command], env)
    owned.push({ id, name })
    await assertOwned(id)
    return id
  }
  async function port(id: string, containerPort: number) {
    const bindings = JSON.parse(await docker(['inspect', id, '--format', '{{json .NetworkSettings.Ports}}']))[`${containerPort}/tcp`]
    if (bindings?.length !== 1 || bindings[0].HostIp !== '127.0.0.1') {
      const state = await docker(['inspect', id, '--format', '{{.State.Status}}|{{.State.ExitCode}}'])
      throw new Error(`Fixture port must bind only loopback: ${state}, bindings=${JSON.stringify(bindings)}`)
    }
    return Number(bindings[0].HostPort)
  }
  async function retireContainers(failures: string[]) {
    try { await administrator?.end() } catch { failures.push('administrator') }
    for (const [index, item] of [...owned].reverse().entries()) {
      try { await assertOwned(item.id) }
      catch { failures.push(`container-${index}-ownership`); continue }
      try { await docker(['rm', '-f', item.id]) }
      catch { failures.push(`container-${index}-removal`) }
    }
  }
  async function retireNetworkAndVolumes(failures: string[]) {
    if (network) {
      let verified = false
      try {
        const labels = JSON.parse(await docker(['network', 'inspect', network, '--format', '{{json .Labels}}']))
        if (labels[label] !== runId) throw new Error('Refusing non-owned network')
        verified = true
      } catch { failures.push('network-ownership') }
      if (verified) {
        try { await docker(['network', 'rm', network]) }
        catch { failures.push('network-removal') }
      }
    }
    for (const volume of ownedVolumes) {
      try {
        if (JSON.parse(await docker(['volume', 'inspect', volume, '--format', '{{json .Labels}}']))[label] !== runId) throw new Error('Volume ownership')
        await docker(['volume', 'rm', volume])
      } catch { failures.push('volume-removal') }
    }
  }
  async function retireTemporarySource(failures: string[]) {
    if(pendingInitCli.size)failures.push('credential-init-child-retirement')
    evidence.consumerRetirementConfirmed=failures.length===0
    try {
      const removed=await retireFixtureDirectory(directory,prefix+'-',failures.length===0)
      if(!removed)evidence.retainedTemporaryPath=directory
    } catch { failures.push('temporary-path');evidence.retainedTemporaryPath=directory }
  }
  async function recordFinalInventory(failures: string[]) {
    evidence.before = { fingerprint: createHash('sha256').update(JSON.stringify(before)).digest('hex'), containerIds: before.states.map(row => row.split('|')[0]), networks: before.networks, volumeCount: before.volumes.length }
    evidence.unrelatedUnchanged = false
    try {
      const after = await inventory()
      evidence.inventoryDelta=inventoryDelta(before,after,new Set([...owned.map(item=>item.id),...ownedVolumes,...(network?[network]:[])]))
      evidence.after = { fingerprint: createHash('sha256').update(JSON.stringify(after)).digest('hex'), volumeCount: after.volumes.length }
      evidence.unrelatedUnchanged = JSON.stringify(before) === JSON.stringify(after)
      if (!evidence.unrelatedUnchanged) failures.push('inventory')
    } catch { failures.push('inventory') }
  }
  async function cleanup() {
    const failures: string[] = []
    await retireContainers(failures)
    await retireNetworkAndVolumes(failures)
    await retireTemporarySource(failures)
    await recordFinalInventory(failures)
    if (failures.length) evidence.cleanupFailures = failures
    console.log('AUTH_STORE_EVIDENCE ' + JSON.stringify(evidence))
    if (failures.length) throw new Error(`Disposable fixture cleanup failed: ${failures.join(', ')}`)
  }
  try {
    for (const image of Object.values(selectedImages)) {
      try { await docker(['image', 'inspect', image, '--format', '{{.Id}}']) }
      catch { await docker(['pull', image]) }
      const platform = await docker(['image', 'inspect', image, '--format', '{{.Os}}/{{.Architecture}}'])
      if (platform !== 'linux/amd64') throw new Error('Fixture image platform mismatch')
    }
    // Freeze the actual candidate before any integration-driven source change.
    if (artifactDirectory) {
      await cp(artifactDirectory, join(directory, 'artifact'), { recursive: true, dereference: true })
      evidence.candidateArtifact = {
        entrySha256: createHash('sha256').update(await readFile(join(directory, 'artifact/server/index.mjs'))).digest('hex'),
      }
    }
    // Docker 29 internal networks discard published port mappings. A unique
    // bridge plus verified loopback-only binds supports host-side real tests.
    network = await docker(['network', 'create', '--label', `${label}=${runId}`, prefix])
    evidence.network = network
    const pg = await create('pg', images.pg, ['--network-alias', 'pg', '-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_USER=migrator', '-e', 'POSTGRES_DB=auth'], { POSTGRES_PASSWORD: migrationPassword }, hatchet ? ['postgres', '-c', 'max_connections=200'] : [])
    await docker(['start', pg])
    const pgPort = await port(pg, 5432)
    const migrationUrl = `postgresql://migrator:${migrationPassword}@127.0.0.1:${pgPort}/auth`
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = hatchet ? createHatchetAdministrator(migrationUrl) : new Client({ connectionString: migrationUrl, connectionTimeoutMillis: 500 })
      candidate.on('error', () => {})
      try { await candidate.connect(); administrator = candidate; break }
      catch { await candidate.end().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    if (!administrator) throw new Error('Disposable PostgreSQL did not become ready')
    if (hatchet) {
      const tenantId = randomUUID()
      const apiPort = await unusedLoopbackPort(), grpcPort = await unusedLoopbackPort()
      const configDirectory = join(directory, 'config')
      await mkdir(configDirectory)
      const clientConfigPath = join(directory, 'sdk-empty.yaml')
      await writeFile(clientConfigPath, '{}\n', { flag: 'wx', mode: 0o600 })
      const env = {
        DATABASE_URL: `postgresql://migrator:${migrationPassword}@pg:5432/auth?sslmode=disable`,
        ADMIN_EMAIL: 'synthetic@example.invalid', ADMIN_PASSWORD: `Aa1${secret()}`.slice(0, 63),
        DEFAULT_TENANT_ID: tenantId, DEFAULT_TENANT_NAME: 'synthetic', DEFAULT_TENANT_SLUG: 'synthetic',
        SERVER_SECURITY_CHECK_ENABLED: 'false', SERVER_ANALYTICS_POSTHOG_ENABLED: 'false',
        SERVER_ANALYTICS_AGGREGATE_ENABLED: 'false', SERVER_OTEL_METRICS_ENABLED: 'false',
        SERVER_AUTH_COOKIE_DOMAIN: '127.0.0.1', SERVER_AUTH_COOKIE_INSECURE: 't',
        SERVER_GRPC_BIND_ADDRESS: '0.0.0.0', SERVER_GRPC_INSECURE: 't', SERVER_GRPC_PORT: '7077',
        SERVER_GRPC_BROADCAST_ADDRESS: `127.0.0.1:${grpcPort}`, SERVER_URL: `http://127.0.0.1:${apiPort}`,
        SERVER_AUTH_SET_EMAIL_VERIFIED: 't', SERVER_INTERNAL_CLIENT_INTERNAL_GRPC_BROADCAST_ADDRESS: 'localhost:7077',
      }
      const id = await create('hatchet', hatchetImage, ['-p', `127.0.0.1:${apiPort}:8888`, '-p', `127.0.0.1:${grpcPort}:7077`, '--mount', `type=bind,source=${configDirectory},target=/config`, ...Object.keys(env).flatMap(key => ['-e', key])], env)
      const imageId = await docker(['image', 'inspect', hatchetImage, '--format', '{{.Id}}'])
      if (await docker(['inspect', id, '--format', '{{.Image}}']) !== imageId) throw new Error('Hatchet immutable image mismatch')
      evidence.hatchet = { id, imageId, tenantId, apiPort, grpcPort, pgPort, configDirectory, clientConfigPath }
      async function ready() {
        for (let attempt = 0; attempt < 120; attempt++) {
          if (await docker(['inspect', id, '--format', '{{.State.Status}}']) === 'exited') throw new Error('Exact Hatchet engine exited during boot')
          try {
            await docker(['exec', id, 'curl', '-fsS', 'http://localhost:8733/ready'])
            if (await port(id, 8888) !== apiPort || await port(id, 7077) !== grpcPort) throw new Error('Hatchet publication changed')
            return
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        evidence.hatchetBootFailure = {
          state: await docker(['inspect', id, '--format', '{{.State.Status}}|{{.State.ExitCode}}|{{.RestartCount}}|{{json .NetworkSettings.Ports}}']),
        }
        throw new Error('Exact Hatchet engine not ready')
      }
      await docker(['start', id])
      await ready()
      evidence.hatchetVersion = await docker(['exec', id, './hatchet-lite', '--version'])
      evidence.postgresVersion = (await administrator.query('SHOW server_version')).rows[0].server_version
      const token = await docker(['exec', id, './hatchet-admin', 'token', 'create', '--config', '/config', '--tenant-id', tenantId, '--name', 'synthetic-admission', '--expiresIn', '1h'])
      if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new Error('Invalid fresh fixture token format')
      return {
        kind: 'hatchet' as const, administrator, evidence, cleanup, tenantId, clientConfigPath,
        restartObservation: {
          proveStatementDeadline: () => proveHatchetStatementDeadline(administrator!),
          claimExpiry: (outboxId: string, deadline: number) => readHatchetClaimExpiry(administrator!, tenantId, outboxId, deadline),
          clock: (deadline: number) => readHatchetClock(administrator!, deadline),
          snapshot: (names: string[], runId: string | null, partitionIds: string[], sinceMs: number | null, deadline: number) => readHatchetRestartSnapshot(administrator!, tenantId, names, runId, partitionIds, sinceMs, deadline),
        },
        config: { token, host_port: `127.0.0.1:${grpcPort}`, api_url: `http://127.0.0.1:${apiPort}`, tls_config: { tls_strategy: 'none' as const } },
        async withEngineStopped(body: () => Promise<void>) {
          await assertOwned(id); await docker(['stop', '--time', '1', id])
          evidence.applicationHeartbeatOutage = { containerId: id, stopped: true }
          try { await body() } finally { await docker(['start', id]); await ready() }
        },
        async restart() {
          await assertOwned(id)
          const started = performance.now()
          await docker(['restart', '--time', '2', id])
          evidence.restartCommandMs = performance.now() - started
          try { await ready() }
          finally { evidence.restartReadyMs = performance.now() - started }
        },
      }
    }
    await administrator.query(`CREATE ROLE runtime LOGIN PASSWORD '${runtimePassword}' NOINHERIT NOREPLICATION NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`)
    await administrator.query(`CREATE ROLE workspace_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
      CREATE ROLE workspace_bootstrap NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;`)
    const voicePasswordA = secret(), voicePasswordB = secret(), voicePasswordShared = secret()
    await administrator.query(`CREATE ROLE sparra_voice_definer NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
      CREATE ROLE sparra_voice_a LOGIN PASSWORD '${voicePasswordA}' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
      CREATE ROLE sparra_voice_b LOGIN PASSWORD '${voicePasswordB}' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
      CREATE ROLE sparra_voice_shared LOGIN PASSWORD '${voicePasswordShared}' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;`)
    const relayPassword = secret(), workerPassword = secret()
    await administrator.query(`CREATE ROLE auth_mail_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
      CREATE ROLE auth_mail_definer NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
      CREATE ROLE auth_mail_relay LOGIN PASSWORD '${relayPassword}' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
      CREATE ROLE auth_mail_worker LOGIN PASSWORD '${workerPassword}' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;`)
    await administrator.query(`CREATE ROLE pool_admin LOGIN PASSWORD '${poolPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`)
    await writeFile(join(directory, 'pgbouncer.ini'), `[databases]\nauth = host=pg port=5432 dbname=auth\n[pgbouncer]\nlisten_addr = 0.0.0.0\nlisten_port = 5432\nauth_type = scram-sha-256\nauth_file = /fixture/users.txt\nadmin_users = pool_admin\npool_mode = transaction\ndefault_pool_size = 1\nmax_client_conn = 100\nmax_prepared_statements = 0\nignore_startup_parameters = extra_float_digits\nlog_connections = 0\nlog_disconnections = 0\n`, { mode: 0o600 })
    await writeFile(join(directory, 'users.txt'), `"runtime" "${runtimePassword}"\n"pool_admin" "${poolPassword}"\n"auth_mail_relay" "${relayPassword}"\n"auth_mail_worker" "${workerPassword}"\n"sparra_voice_a" "${voicePasswordA}"\n"sparra_voice_b" "${voicePasswordB}"\n"sparra_voice_shared" "${voicePasswordShared}"\n`, { mode: 0o600 })
    const poolId = await create('pool', images.pool, [...privateFileUser, '--network-alias', 'pool', '-p', '127.0.0.1::5432', '--mount', `type=bind,source=${directory},target=/fixture,readonly`, '--entrypoint', '/usr/bin/pgbouncer'], {}, ['/fixture/pgbouncer.ini'])
    await docker(['start', poolId])
    const poolPort = await port(poolId, 5432)
    await writeFile(join(directory, 'redis.conf'), `bind 0.0.0.0\nport 6379\nrequirepass ${redisPassword}\nsave ""\nappendonly no\n`, { mode: 0o600 })
    const redisName = `${prefix}-redis`
    // Docker reallocates an unspecified host port on stop/start. Reserve a
    // checked unused loopback port and explicitly retain it for restart tests.
    const redisPublication = await unusedLoopbackPort()
    const redis = await docker(['create', '--name', redisName, '--label', `${label}=${runId}`, '--network', network, ...privateFileUser, '--network-alias', 'redis', '-p', `127.0.0.1:${redisPublication}:6379`, '--tmpfs', '/data:rw', '--mount', `type=bind,source=${directory},target=/fixture,readonly`, images.redis, 'redis-server', '/fixture/redis.conf'])
    owned.push({ id: redis, name: redisName }); await assertOwned(redis); await docker(['start', redis])
    const redisPort = await port(redis, 6379)
    if (redisPort !== redisPublication) throw new Error('Owned Redis publication mismatch')
    async function migrate() {
      try {
        const result = await exec(process.execPath, ['scripts/migrate.ts'], { env: { ...essentials(), MIGRATION_DATABASE_URL: migrationUrl }, windowsHide: true, timeout: 15000 })
        if (result.stdout.trim() !== 'Database migrations applied' || result.stderr) throw new Error()
      } catch { throw new Error('Disposable migration command failed') }
    }
    async function poolAdmin() {
      const client = new Client({ connectionString: `postgresql://pool_admin:${poolPassword}@127.0.0.1:${poolPort}/pgbouncer`, connectionTimeoutMillis: 1000 })
      await client.connect(); return client
    }
    type CredentialMutation = 'valid'|'empty-env'|'missing'|'malformed'|'oversized'|'symlink'|'mode'|'empty'|'newline'|'nul'|'whitespace'|'utf8'|'uid'|'gid'|'directory'|'parent-mode'
    const webVolumes = new Map<string,string>()
    async function privateInput(id:string, value:string) {
      await assertOwned(id)
      const child=spawn('docker',[...endpoint.args,'start','-ai',id],{env:essentials(),windowsHide:true,stdio:['pipe','pipe','pipe']})
      pendingInitCli.add(child);child.once('close',()=>pendingInitCli.delete(child))
      child.stdout.resume();child.stderr.resume();child.stdin.on('error',()=>{})
      const completion=awaitCredentialInit(child,async()=>{
        await assertOwned(id)
        if(await docker(['inspect',id,'--format','{{.State.Running}}'])==='true')await docker(['stop','--time','1',id],{},3000)
        if(await docker(['inspect',id,'--format','{{.State.Running}}'])!=='false')throw Error('Init consumer still live')
      },10000)
      const bytes=Buffer.from(value)
      try{child.stdin.end(bytes);await completion}finally{bytes.fill(0)}
    }
    async function provision(volume:string, values:Readonly<Record<string,string>>, mutation:CredentialMutation) {
      if (JSON.parse(await docker(['volume','inspect',volume,'--format','{{json .Labels}}']))[label]!==runId) throw new Error('Volume ownership')
      const script=`const fs=require('node:fs');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const {values,mutation}=JSON.parse(raw);const root='/run/secrets';for(const name of fs.readdirSync(root))fs.rmSync(root+'/'+name,{force:true,recursive:true});fs.chownSync(root,0,10001);fs.chmodSync(root,mutation==='parent-mode'?0o755:0o750);let first=true;for(const [name,text]of Object.entries(values)){const path=root+'/'+name;let data=Buffer.from(text);if(first){if(mutation==='missing'){first=false;continue}if(mutation==='empty')data=Buffer.alloc(0);if(mutation==='malformed')data=Buffer.from('invalid-synthetic-only');if(mutation==='oversized')data=Buffer.alloc(16385,120);if(mutation==='newline')data=Buffer.from(text+'\\n');if(mutation==='nul')data=Buffer.from(text+'\\0');if(mutation==='whitespace')data=Buffer.from(' '+text);if(mutation==='utf8')data=Buffer.from([255]);if(mutation==='directory'){fs.mkdirSync(path);first=false;continue}}fs.writeFileSync(path,data,{mode:0o440});data.fill(0);fs.chownSync(path,first&&mutation==='uid'?10001:0,first&&mutation==='gid'?0:10001);if(first&&mutation==='mode')fs.chmodSync(path,0o444);if(first&&mutation==='symlink'){fs.renameSync(path,path+'.target');fs.symlinkSync(path+'.target',path)}first=false}raw='';})`
      const id=await create('credential-init-'+owned.length,images.node,['-i','--read-only','--mount','type=volume,source='+volume+',target=/run/secrets'],{},['node','-e',script],'none')
      await privateInput(id,JSON.stringify({values,mutation}))
    }
    async function credentialVolume(values:Readonly<Record<string,string>>,mutation:CredentialMutation) {
      const volume=await docker(['volume','create','--label',label+'='+runId,prefix+'-credentials-'+ownedVolumes.length])
      ownedVolumes.push(volume);await provision(volume,values,mutation);return volume
    }
    const webCredentialValues=(auth:Readonly<{secret:string;googleClientId:string;googleClientSecret:string}>)=>({
      app_database_url:'postgresql://runtime:'+runtimePassword+'@pool:5432/auth',app_redis_url:'redis://:'+redisPassword+'@redis:6379/0',
      app_rate_limit_hmac_secret:hmac,app_auth_secret:auth.secret,app_google_client_id:auth.googleClientId,app_google_client_secret:auth.googleClientSecret,
    })
    const assertImage=async(image:string)=>{
      if(!/^sha256:[0-9a-f]{64}$/.test(image)||await docker(['image','inspect',image,'--format','{{.Id}}|{{.Os}}/{{.Architecture}}'])!==image+'|linux/amd64')throw new Error('Immutable owned test image required')
    }
    async function imageMetadata(id:string) {
      await assertOwned(id)
      const config=JSON.parse(await docker(['inspect',id,'--format','{{json .Config}}']))
      const host=JSON.parse(await docker(['inspect',id,'--format','{{json .HostConfig}}']))
      return { user:config.User,environment:config.Env,entrypoint:config.Entrypoint,command:config.Cmd,readonly:host.ReadonlyRootfs,
        caps:host.CapDrop,security:host.SecurityOpt,mounts:JSON.parse(await docker(['inspect',id,'--format','{{json .Mounts}}'])) }
    }
    async function directImageStatus(id:string,path:'/health/ready'|'/login',wrongAuthority=false) {
      await assertOwned(id)
      const script="const http=require('node:http');const r=http.request({host:'127.0.0.1',port:3000,path:process.argv[1],headers:{host:'image.example','x-forwarded-host':process.argv[2]==='wrong'?'foreign.example':'image.example','x-forwarded-proto':'https','x-forwarded-for':'192.0.2.1'}},response=>{console.log(response.statusCode);response.resume()});r.setTimeout(1000,()=>r.destroy());r.on('error',()=>process.exit(1));r.end()"
      return Number(await docker(['exec',id,'node','-e',script,path,wrongAuthority?'wrong':'valid']))
    }
    async function startWebImage(imageReference:string,mutation:CredentialMutation='valid',auth:Readonly<{secret:string;googleClientId:string;googleClientSecret:string}>={secret:secret(),googleClientId:'fixture.apps.googleusercontent.com',googleClientSecret:secret()},keyring?:string,directServe=false,selectedPort?:number) {
      await assertImage(imageReference)
      const volume=await credentialVolume({...webCredentialValues(auth),...(keyring?{'aead_keyring_v1.json':keyring}: {})},mutation)
      const webPort=selectedPort??await unusedLoopbackPort(),url='http://localhost:'+webPort
      if(!Number.isInteger(webPort)||webPort<1||webPort>65535)throw new Error('Owned image port invalid')
      const gateway=JSON.parse(await docker(['network','inspect',network!,'--format','{{json .IPAM.Config}}']))[0].Gateway
      if(typeof gateway!=='string'||!/^[0-9.]+$/.test(gateway))throw new Error('Owned network gateway missing')
      const env={NODE_ENV:'test',APP_ORIGIN:directServe?'https://image.example':url,HOST:'0.0.0.0',PORT:'3000',SHUTDOWN_TIMEOUT_MS:'1000',REQUEST_TIMEOUT_MS:'10000',RATE_LIMIT_KEY_ID:'image',TRUSTED_PROXY_IPS:directServe?'127.0.0.1':gateway,...(directServe?{SPARRA_INGRESS_PROFILE:'direct-serve'}:{}),...(keyring?{SPARRA_AEAD_KEYRING_PATH:'/run/secrets/aead_keyring_v1.json'}:{}),...(mutation==='empty-env'?{DATABASE_URL:''}:{})}
      const id=await create('web-image-'+owned.length,imageReference,['-p','127.0.0.1:'+webPort+':3000','--read-only','--tmpfs','/tmp','--cap-drop','ALL','--security-opt','no-new-privileges','--mount','type=volume,source='+volume+',target=/run/secrets,readonly',...Object.keys(env).flatMap(key=>['-e',key])],env)
      webVolumes.set(id,volume);await docker(['start',id])
      if(mutation!=='valid')return {id,url}
      let lastStatus=0
      const deadline=Date.now()+10000
      while(Date.now()<deadline){
        if(await docker(['inspect',id,'--format','{{.State.Status}}'])==='exited')throw new Error('Native image startup failed')
        try{lastStatus=directServe?await directImageStatus(id,'/health/ready'):(await imageFetch(url+'/health/ready',{signal:AbortSignal.timeout(500)})).status;if(lastStatus===200)return {id,url}}catch{}
        await new Promise(resolve=>setTimeout(resolve,100))
      }
      throw new Error('Native web image not ready: response-'+lastStatus)
    }
    async function runMigrationImage(imageId:string,mutation:CredentialMutation='valid',transport:'direct'|'drop-commit-ack'='direct') {
      await assertImage(imageId)
      let proxy:string|undefined
      if(transport==='drop-commit-ack'){
        proxy=await create('commit-proxy-'+owned.length,images.node,['--network-alias','commit-proxy','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--mount','type=bind,source='+resolve('tests/helpers/migration-commit-proxy.mjs')+',target=/proxy.mjs,readonly'],{},['node','/proxy.mjs'])
        await docker(['start',proxy])
        for(let attempt=0;attempt<50;attempt++){if((await docker(['logs',proxy])).includes('READY'))break;await new Promise(resolve=>setTimeout(resolve,100))}
      }
      const volume=await credentialVolume({migration_database_url:'postgresql://migrator:'+migrationPassword+'@'+(proxy?'commit-proxy':'pg')+':5432/auth'},mutation)
      const id=await create('migrator-image-'+owned.length,imageId,['--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--mount','type=volume,source='+volume+',target=/run/secrets,readonly',...(mutation==='empty-env'?['-e','MIGRATION_DATABASE_URL=']:[])])
      await docker(['start',id]);const exitCode=Number(await docker(['wait',id]))
      const result=await exec('docker',[...endpoint.args,'logs',id],{env:essentials(),windowsHide:true,timeout:10000})
      if(proxy){
        await assertOwned(proxy);await docker(['stop','--time','2',proxy])
        if(Number(await docker(['wait',proxy]))!==0)throw new Error('Proxy retirement failed')
        const terminal=JSON.parse((await docker(['logs',proxy])).split('\n').filter(line=>line.startsWith('{')).at(-1)??'{}')
        if(terminal.type!=='terminal'||terminal.accepting!==false||terminal.activeSockets!==0)throw new Error('Proxy terminal evidence missing')
        evidence.commitProxy=terminal
      }
      return {id,exitCode,stdout:String(result.stdout),stderr:String(result.stderr)}
    }
    return {
      kind: 'stores' as const,
      pg, pool: poolId, redis, administrator, migrate, cleanup, poolAdmin, evidence,
      startWebImage,runMigrationImage,imageMetadata,directImageStatus,
      async imageLogs(id:string){await assertOwned(id);const result=await exec('docker',[...endpoint.args,'logs',id],{env:essentials(),windowsHide:true,timeout:10000});return {stdout:String(result.stdout),stderr:String(result.stderr)}},
      async replaceWebCredentials(id:string,auth:Readonly<{secret:string;googleClientId:string;googleClientSecret:string}>,keyring?:string){await assertOwned(id);const volume=webVolumes.get(id);if(!volume)throw new Error('Owned web volume missing');await provision(volume,{...webCredentialValues(auth),...(keyring?{'aead_keyring_v1.json':keyring}:{})},'valid')},
      async restartWebImage(id:string){await assertOwned(id);if(!webVolumes.has(id))throw new Error('Owned image missing');await docker(['restart','--time','2',id])},
      async migrateRecoveryAdmissionPrefix() {
        const prefixDirectory = join(directory, 'recovery-admission-prefix')
        await mkdir(join(prefixDirectory, 'meta'), { recursive: true })
        const journal = JSON.parse(await readFile(resolve('drizzle/meta/_journal.json'), 'utf8'))
        const entries = journal.entries.slice(0, 12)
        if (entries.length !== 12 || entries.some((entry: { idx: number }, index: number) => entry.idx !== index)
          || entries[11].tag !== '0011_session_management' || journal.entries[12]?.tag !== '0012_recovery_admission') throw new Error('Unexpected recovery admission migration prefix')
        for (const entry of entries) await cp(resolve('drizzle', entry.tag + '.sql'), join(prefixDirectory, entry.tag + '.sql'))
        await writeFile(join(prefixDirectory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }), { flag: 'wx' })
        await migrateDrizzle(drizzle(administrator!, { logger: false }), { migrationsFolder: prefixDirectory })
      },
      async migrateSessionManagementPrefix() {
        const prefixDirectory = join(directory, 'session-management-prefix')
        await mkdir(join(prefixDirectory, 'meta'), { recursive: true })
        const journal = JSON.parse(await readFile(resolve('drizzle/meta/_journal.json'), 'utf8'))
        const entries = journal.entries.slice(0, 11)
        if (entries.length !== 11 || entries.some((entry: { idx: number }, index: number) => entry.idx !== index)
          || entries[10].tag !== '0010_google_account' || journal.entries[11]?.tag !== '0011_session_management') throw new Error('Unexpected session management migration prefix')
        for (const entry of entries) await cp(resolve('drizzle', entry.tag + '.sql'), join(prefixDirectory, entry.tag + '.sql'))
        await writeFile(join(prefixDirectory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }), { flag: 'wx' })
        await migrateDrizzle(drizzle(administrator!, { logger: false }), { migrationsFolder: prefixDirectory })
      },
      async migrateGoogleAccountPrefix() {
        const prefixDirectory = join(directory, 'google-account-prefix')
        await mkdir(join(prefixDirectory, 'meta'), { recursive: true })
        const journal = JSON.parse(await readFile(resolve('drizzle/meta/_journal.json'), 'utf8'))
        const entries = journal.entries.slice(0, 10)
        if (entries.length !== 10 || entries.some((entry: { idx: number }, index: number) => entry.idx !== index)
          || entries[9].tag !== '0009_first_google_passkey' || journal.entries[10]?.tag !== '0010_google_account') throw new Error('Unexpected Google Account migration prefix')
        for (const entry of entries) await cp(resolve('drizzle', entry.tag + '.sql'), join(prefixDirectory, entry.tag + '.sql'))
        await writeFile(join(prefixDirectory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }), { flag: 'wx' })
        await migrateDrizzle(drizzle(administrator!, { logger: false }), { migrationsFolder: prefixDirectory })
      },
      async migrateAccountKeyPrefix() {
        // Own a copy of the immutable N-1 journal/SQL; the forward path remains
        // scripts/migrate.ts. Never rewrite the application's migration history.
        const prefixDirectory = join(directory, 'account-key-prefix')
        await mkdir(join(prefixDirectory, 'meta'), { recursive: true })
        const journal = JSON.parse(await readFile(resolve('drizzle/meta/_journal.json'), 'utf8'))
        const tags = ['0000_auth_storage', '0001_cheerful_sharon_carter', '0002_worthless_newton_destine', '0003_auth_mail_polling_candidates', '0004_wealthy_impossible_man']
        journal.entries = journal.entries.slice(0, 5)
        if (JSON.stringify(journal.entries.map((entry: { tag: string }) => entry.tag)) !== JSON.stringify(tags)) throw new Error('Unexpected immutable migration prefix')
        for (const tag of tags) await cp(resolve('drizzle', tag + '.sql'), join(prefixDirectory, tag + '.sql'))
        await writeFile(join(prefixDirectory, 'meta/_journal.json'), JSON.stringify(journal))
        await migrateDrizzle(drizzle(administrator!, { logger: false }), { migrationsFolder: prefixDirectory })
      },
      runtimeUrl: `postgresql://runtime:${runtimePassword}@127.0.0.1:${poolPort}/auth`,
      voiceUrlA: `postgresql://sparra_voice_a:${voicePasswordA}@127.0.0.1:${poolPort}/auth`,
      voiceUrlB: `postgresql://sparra_voice_b:${voicePasswordB}@127.0.0.1:${poolPort}/auth`,
      voiceUrlShared: `postgresql://sparra_voice_shared:${voicePasswordShared}@127.0.0.1:${poolPort}/auth`,
      directRuntimeUrl: `postgresql://runtime:${runtimePassword}@127.0.0.1:${pgPort}/auth`,
      mailRelayUrl: `postgresql://auth_mail_relay:${relayPassword}@127.0.0.1:${poolPort}/auth`,
      mailWorkerUrl: `postgresql://auth_mail_worker:${workerPassword}@127.0.0.1:${poolPort}/auth`,
      directMailRelayUrl: `postgresql://auth_mail_relay:${relayPassword}@127.0.0.1:${pgPort}/auth`,
      directMailWorkerUrl: `postgresql://auth_mail_worker:${workerPassword}@127.0.0.1:${pgPort}/auth`,
      redisUrl: `redis://:${redisPassword}@127.0.0.1:${redisPort}`, hmac,
      async command(id: string, args: string[]) { await assertOwned(id); return docker(['exec', id, ...args]) },
      async restartRedis(whileStopped: () => Promise<void>) {
        await assertOwned(redis); await docker(['stop', '--time', '1', redis])
        try { await whileStopped() } finally { await docker(['start', redis]) }
        const restartedPort = await port(redis, 6379)
        evidence.redisRestartPorts = { before: redisPort, after: restartedPort }
        if (restartedPort !== redisPort) throw new Error(`Owned Redis port moved across restart: ${redisPort} -> ${restartedPort}`)
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            if (await docker(['exec', '-e', 'REDISCLI_AUTH', redis, 'redis-cli', 'PING'], { REDISCLI_AUTH: redisPassword }) === 'PONG') return
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error('Owned Redis did not become ready after restart')
      },
      async startWeb(kind: string, streamMs: number) {
        const webEnv = { NODE_ENV: 'production', APP_ORIGIN: 'https://template.example', HOST: '0.0.0.0', PORT: '3000', SHUTDOWN_TIMEOUT_MS: '1000', REQUEST_TIMEOUT_MS: '3000', DATABASE_URL: `postgresql://runtime:${runtimePassword}@pool:5432/auth`, REDIS_URL: `redis://:${redisPassword}@redis:6379`, RATE_LIMIT_HMAC_SECRET: hmac, RATE_LIMIT_KEY_ID: 'integration', TRUSTED_PROXY_IPS: '127.0.0.2', FIXTURE_STREAM_MS: String(streamMs) }
        const name = `${prefix}-${kind}`
        const id = await docker(['create', '--name', name, '--label', `${label}=${runId}`, '--network', network!, '-p', '127.0.0.1::3000', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--workdir', '/app', '--mount', `type=bind,source=${join(directory, 'artifact')},target=/app/.output,readonly`, '--mount', `type=bind,source=${resolve('tests/helpers/runtime-probe.mjs')},target=/app/probe.mjs,readonly`, ...Object.keys(webEnv).flatMap(key => ['-e', key]), images.node, 'node', '--import', '/app/probe.mjs', '/app/.output/server/index.mjs'], webEnv)
        owned.push({ id, name }); await assertOwned(id); await docker(['start', id])
        const webPort = await port(id, 3000)
        const url = `http://127.0.0.1:${webPort}`
        for (let attempt = 0; attempt < 100; attempt++) {
          try { if ((await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(500) })).status === 200) return { id, url } } catch {}
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error('Disposable Linux web not ready')
      },
      async signalWeb(id: string, signal: 'SIGTERM' | 'SIGINT') { await assertOwned(id); await docker(['kill', '--signal', signal, id]) },
      async waitWeb(id: string) { await assertOwned(id); return Number(await docker(['wait', id])) },
    }
  } catch (error) { await cleanup(); throw error instanceof Error && !('routine' in error) ? error : new Error('Disposable store setup failed') }
}
