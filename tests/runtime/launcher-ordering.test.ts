import { expect,test } from 'vitest'
import { mkdtemp,mkdir,readFile,writeFile,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec=promisify(execFile)
test.each(['web','migrate'] as const)('fixed_credentials_precede_native_import_and_failure_never_imports: %s',async kind=>{
  const directory=await mkdtemp(join(tmpdir(),'sparra-launcher-'))
  try{
    await mkdir(join(directory,'scripts'));await mkdir(join(directory,'.output/server'),{recursive:true})
    for(const name of ['start-'+kind+'.mjs',kind==='web'?'web-credentials.mjs':'migration-credentials.mjs'])await writeFile(join(directory,'scripts',name),await readFile('scripts/'+name))
    const values={app_database_url:'postgresql://synthetic:synthetic@pg:5432/auth',app_redis_url:'redis://:synthetic@redis:6379/0',app_rate_limit_hmac_secret:'h'.repeat(32),app_auth_secret:'a'.repeat(32),app_google_client_id:'synthetic',app_google_client_secret:'synthetic',migration_database_url:'postgresql://synthetic:synthetic@pg:5432/auth'}
    await writeFile(join(directory,'scripts/fixed-credential-file.mjs'),'const values='+JSON.stringify(values)+';export async function readFixedCredentialFile(name){return values[name]}')
    const marker=kind==='web'?"if(!process.env.DATABASE_URL||!process.env.AUTH_SECRET||process.env.MIGRATION_DATABASE_URL)throw Error();":"if(!process.env.MIGRATION_DATABASE_URL||process.env.DATABASE_URL)throw Error();"
    await writeFile(join(directory,kind==='web'?'.output/server/index.mjs':'scripts/migrate.ts'),marker+"process.stdout.write('native-import\\n')")
    const env=Object.fromEntries(['PATH','SystemRoot','TEMP','TMP'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]!]]))
    const valid=await exec(process.execPath,[join(directory,'scripts/start-'+kind+'.mjs')],{env,windowsHide:true})
    expect(String(valid.stdout)).toBe('native-import\n');expect(String(valid.stderr)).toBe('')
    await writeFile(join(directory,'scripts/fixed-credential-file.mjs'),"export async function readFixedCredentialFile(){throw new Error('synthetic-never-leak')}")
    let result:{code:number;stdout:string;stderr:string}|undefined
    try{await exec(process.execPath,[join(directory,'scripts/start-'+kind+'.mjs')],{env,windowsHide:true})}
    catch(error){if(error instanceof Error&&'code'in error&&'stdout'in error&&'stderr'in error)result={code:Number(error.code),stdout:String(error.stdout),stderr:String(error.stderr)}}
    expect(result).toEqual({code:1,stdout:'',stderr:(kind==='web'?'Web':'Migration')+' credential loading failed\n'})
  }finally{await rm(directory,{recursive:true})}
})
