import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { chromium, type Browser } from 'playwright'
import AxeBuilder from '@axe-core/playwright'
import { startDisposableStores } from '../fixtures/db/disposable-stores'
import { startWeb, bounded, unusedLoopbackPort } from '../helpers/web-process'
import { authRpcPath, rpcBody } from '../helpers/auth-rpc'

let stores: Awaited<ReturnType<typeof startDisposableStores>>, app: ReturnType<typeof startWeb>, proxy: ReturnType<typeof createServer>, browser: Browser
let origin: string, upstreamPort: number, appEnv: Parameters<typeof startWeb>[0]
beforeAll(async () => {
  await mkdir('.output/test-evidence/google-browser', { recursive: true })
  stores = await startDisposableStores(); await stores.migrate()
  await stores.administrator.query('GRANT USAGE ON SCHEMA public TO runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON "user",account,session,verification TO runtime; GRANT SELECT ON public.passkey TO runtime')
  const port = await unusedLoopbackPort(); origin = `http://localhost:${port}`
  appEnv = { NODE_ENV:'test',APP_ORIGIN:origin,DATABASE_URL:stores.runtimeUrl,REDIS_URL:stores.redisUrl,RATE_LIMIT_HMAC_SECRET:stores.hmac,RATE_LIMIT_KEY_ID:'workspace-browser',TRUSTED_PROXY_IPS:'127.0.0.2',AUTH_SECRET:randomBytes(48).toString('hex'),GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'fixture-only',FIXTURE_GOOGLE_PROTOCOL:'yes',REQUEST_TIMEOUT_MS:'10000' }
  app = startWeb(appEnv); upstreamPort = (await bounded(app.ready)).port
  proxy = createServer((incoming,outgoing) => {
    const call = httpRequest({ hostname:'127.0.0.1',port:upstreamPort,method:incoming.method,path:incoming.url,localAddress:'127.0.0.2',headers:{ ...incoming.headers,'x-real-ip':incoming.socket.remoteAddress } }, response => { outgoing.writeHead(response.statusCode!,response.headers); response.pipe(outgoing) })
    call.on('error',() => { outgoing.writeHead(502); outgoing.end() }); incoming.pipe(call)
  })
  await new Promise<void>(done => proxy.listen(port,'127.0.0.1',done)); browser = await chromium.launch({headless:true})
})
afterAll(async () => {
  const failures: unknown[] = []
  for (const close of [() => browser?.close(), () => proxy && new Promise(done => proxy.close(done)), () => app?.cleanup(), () => stores?.cleanup()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Workspace browser cleanup failed')
})

function classifyLoginPageErrors(errors: string[]) {
  const pageErrors = { 'dynamic-module-fetch':0, other:0 }
  const pageErrorsTruncated = errors.length>32
  for (const message of errors.slice(0,32)) {
    const kind = message.startsWith('Failed to fetch dynamically imported module:') ? 'dynamic-module-fetch' : 'other'
    pageErrors[kind]++
  }
  return { pageErrors, pageErrorsTruncated }
}

test('real Astryx create/read/rename persists through reload and process restart; FR/EN, 320px, keyboard and private-state refusal', async () => {
  const context = await browser.newContext({viewport:{width:320,height:720}}), page = await context.newPage()
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  page.setDefaultTimeout(7000); page.setDefaultNavigationTimeout(7000)
  const errors: string[] = [], bodies: string[] = []
  let workspaceReadUrl = ''
  page.on('pageerror',error => errors.push(error.message))
  page.on('request',request => { if (request.url().includes('/_serverFn/') && request.method()==='POST') bodies.push(request.postData() ?? '') })
  const readPath = await authRpcPath('getWorkspace'), ensurePath = await authRpcPath('ensurePersonalWorkspace'), renamePath = await authRpcPath('renameWorkspace')
  page.on('request',request => { if (request.url().includes(readPath)) workspaceReadUrl=request.url() })
  await page.route('https://accounts.google.com/o/oauth2/v2/auth*',async route => {
    const target = new URL(route.request().url())
    const code = await app.registerGoogle(target.href, 'fixture-task6-browser')
    return route.fulfill({status:302,headers:{location:origin+`/api/auth/callback/google?code=${code}&state=`+target.searchParams.get('state')}})
  })
  await page.goto(origin+'/login?lang=en')
  try {
    await expect.poll(() => page.getByRole('button',{name:'Continue with Google'}).isEnabled(), {timeout:7000}).toBe(true)
  } catch (error) {
    try {
      const { pageErrors, pageErrorsTruncated } = classifyLoginPageErrors(errors)
      const control = await page.evaluate(() => {
        const readyState = ['loading','interactive','complete'].find(value => value===document.readyState) ?? 'other'
        const button = document.querySelector('.auth-login .google-sign-in')
        if (!(button instanceof HTMLButtonElement)) return { available:false, readyState }
        const aria = (name:'aria-disabled'|'aria-busy') => {
          const value = button.getAttribute(name)
          return value===null ? 'absent' : value==='true' ? 'true' : value==='false' ? 'false' : 'other'
        }
        return { available:true, readyState, disabled:button.disabled, disabledAttribute:button.hasAttribute('disabled'),
          matchesDisabled:button.matches(':disabled'), ariaDisabled:aria('aria-disabled'), ariaBusy:aria('aria-busy') }
      })
      console.error('login-bootstrap-trace',JSON.stringify({ pageErrors, pageErrorsTruncated, control }))
    } catch {
      try { console.error('login-bootstrap-trace','{"available":false}') }
      catch { /* Diagnostic failure cannot replace the original poll assertion. */ }
    }
    throw error
  }
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button',{name:'Continue with Google'}).click()
  await page.waitForURL(origin+'/account?lang=en')
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Workspace',exact:true}).waitFor()
  expect(await page.getByRole('main').count()).toBe(1)
  expect(await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Business',exact:true}).count()).toBe(1)
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const accountResponse = await context.request.get(origin+await authRpcPath('getAccount'),{headers:{'sec-fetch-site':'same-origin','x-tsr-serverFn':'true'}})
  expect(accountResponse.status()).toBe(200)
  const privateSession = (await stores.administrator.query('SELECT id,token,user_id FROM session')).rows[0]
  const accountBody = await accountResponse.text()
  expect(accountBody.includes(privateSession.id)).toBe(false); expect(accountBody.includes(privateSession.token)).toBe(false)
  expect(/sessionId|authState|recoveryGeneration|providerIdentity/.test(accountBody)).toBe(false)
  const workspaceDocument = page.waitForResponse(response => response.request().isNavigationRequest() && new URL(response.url()).pathname === '/workspace')
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Workspace',exact:true}).click()
  expect((await workspaceDocument).status()).toBe(200)
  await page.getByRole('button',{name:'Create my workspace'}).waitFor()
  expect(await page.getByRole('main').count()).toBe(1)
  expect(await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Business',exact:true}).count()).toBe(1)
  expect(await page.title()).toBe('Your personal workspace')
  const createButtonState = async () => {
    try { return await page.evaluate(() => {
    const button=document.querySelector('.sparra-app .auth-workspace button.astryx-button[data-variant="primary"]')
    if (!(button instanceof HTMLButtonElement)) return { available:false }
    const finite = (value:unknown,min:number,max:number) => typeof value==='number' && Number.isFinite(value) && value>=min && value<=max ? value : null
    const aria = (name:'aria-disabled'|'aria-busy') => {
      const value=button.getAttribute(name)
      return value===null ? 'absent' : value==='true' ? 'true' : value==='false' ? 'false' : 'other'
    }
    const style = (element:Element) => {
      const computed=getComputedStyle(element)
      return {opacity:finite(Number(computed.opacity),0,1),color:computed.color.slice(0,80),backgroundColor:computed.backgroundColor.slice(0,80)}
    }
    const label=button.querySelector('span.xlyipyv')
    return {
      available:true,connected:button.isConnected,enabled:!button.disabled,disabled:button.disabled,
      disabledAttribute:button.hasAttribute('disabled'),matchesDisabled:button.matches(':disabled'),ariaDisabled:aria('aria-disabled'),ariaBusy:aria('aria-busy'),
      button:style(button),label:label ? style(label) : null,
      animations:button.getAnimations({subtree:true}).slice(0,4).map(animation => {
        const timing=animation.effect?.getComputedTiming()
        const property=animation instanceof CSSTransition ? ['opacity','color','background-color','background-image','transform'].find(value => value===animation.transitionProperty) ?? 'other' : null
        return {kind:animation instanceof CSSTransition ? 'transition' : animation instanceof CSSAnimation ? 'animation' : 'other',property,
          state:animation.playState,pending:animation.pending,currentTimeMs:finite(animation.currentTime,-60000,60000),durationMs:finite(timing?.duration,0,60000),progress:finite(timing?.progress,0,1)}
      }),
    }
    }) } catch { return { available:false } }
  }
  // These snapshots bracket analyze; neither timestamps the color-contrast rule itself.
  const beforeWorkspaceAxe=await createButtonState()
  const workspaceAxe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()
  if (workspaceAxe.violations.length) {
    try { console.error('workspace-axe-trace',JSON.stringify({boundary:'around-analyze',before:beforeWorkspaceAxe,after:await createButtonState()})) }
    catch { /* Diagnostic emission cannot replace the Axe assertion. */ }
  }
  expect(workspaceAxe.violations).toEqual([])
  expect((await stores.administrator.query('SELECT count(*)::int AS n FROM workspace')).rows[0].n).toBe(0)
  let release = () => {}
  const held = new Promise<void>(resolve => { release=resolve })
  await page.route('**'+ensurePath,async route => { await held; await route.continue() })
  // The SSR control is disabled until its actual hydrated consumer can accept input.
  await expect.poll(() => page.getByRole('button',{name:'Create my workspace'}).isEnabled(), {timeout:7000}).toBe(true)
  await page.getByRole('button',{name:'Create my workspace'}).focus(); await page.keyboard.press('Enter')
  await page.getByText('Saving…',{exact:true}).waitFor()
  expect(await page.getByRole('button',{name:'Create my workspace'}).getAttribute('aria-busy')).toBe('true')
  release()
  await page.getByRole('textbox',{name:'Display name'}).waitFor()
  expect(await page.locator('[data-workspace-name]').textContent()).toBe('Workspace')
  await page.getByRole('textbox',{name:'Display name'}).fill('  My persisted space  ')
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BUTTON')
  await page.keyboard.press('Enter'); await page.getByText('Name saved.',{exact:true}).waitFor()
  expect(await page.locator('[data-workspace-name]').textContent()).toBe('My persisted space')
  expect(await page.getByRole('textbox',{name:'Display name'}).inputValue()).toBe('My persisted space')
  await page.reload(); await page.getByRole('textbox',{name:'Display name'}).waitFor()
  expect(await page.locator('[data-workspace-name]').textContent()).toBe('My persisted space')
  await page.getByRole('link',{name:'Français'}).click(); await page.getByRole('textbox',{name:'Nom affiché'}).waitFor()
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()).violations).toEqual([])
  await page.getByRole('textbox',{name:'Nom affiché'}).fill('Mon espace privé')
  await page.getByRole('button',{name:'Enregistrer le nom'}).click(); await page.getByText('Nom enregistré.',{exact:true}).waitFor()
  expect(await page.locator('html').getAttribute('lang')).toBe('fr')
  const view = await page.evaluate(() => ({ fits:document.documentElement.scrollWidth<=innerWidth,font:getComputedStyle(document.querySelector('h1')!).fontFamily }))
  expect(view.fits).toBe(true); expect(view.font).toContain('Sparra Display')
  await page.screenshot({path:'.output/test-evidence/google-browser/task-6-workspace-fr-320.png',fullPage:true})
  await app.shutdown(); expect(await bounded(app.exit)).toBe(0)
  await app.cleanup()
  app = startWeb(appEnv); upstreamPort=(await bounded(app.ready)).port
  await page.reload(); await page.getByRole('textbox',{name:'Nom affiché'}).waitFor()
  expect(await page.getByRole('textbox',{name:'Nom affiché'}).inputValue()).toBe('Mon espace privé')
  const stored = (await stores.administrator.query('SELECT id,display_name FROM workspace WHERE owner_user_id=$1',[privateSession.user_id])).rows[0]
  expect(stored.display_name).toBe('Mon espace privé')
  for (const {data,status} of [{data:{workspaceId:stored.id,displayName:'line\nbreak'},status:400},{data:{workspaceId:randomUUID(),displayName:'Forbidden'},status:404},{data:{workspaceId:stored.id,displayName:'Forbidden',userId:randomUUID()},status:400}]) {
    const result=await context.request.post(origin+renamePath,{headers:{origin,'content-type':'application/json','x-tsr-serverFn':'true'},data:await rpcBody(data)})
    expect(result.status()).toBe(status)
    expect((await result.text()).includes(privateSession.id)).toBe(false)
  }
  await stores.administrator.query("CREATE FUNCTION fixture_browser_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-workspace-fault-marker'; END $$; CREATE TRIGGER fixture_browser_audit_fail BEFORE INSERT ON workspace_audit FOR EACH ROW EXECUTE FUNCTION fixture_browser_audit_fail()")
  try {
    const result=await context.request.post(origin+renamePath,{headers:{origin,'content-type':'application/json','x-tsr-serverFn':'true'},data:await rpcBody({workspaceId:stored.id,displayName:'Rolled back'})})
    expect(result.status()).toBe(500); expect(await result.text()).toBe('Workspace unavailable')
    expect((await stores.administrator.query('SELECT display_name FROM workspace WHERE id=$1',[stored.id])).rows[0].display_name).toBe('Mon espace privé')
    expect(app.output().includes('private-workspace-fault-marker')).toBe(false)
  } finally { await stores.administrator.query('DROP TRIGGER fixture_browser_audit_fail ON workspace_audit; DROP FUNCTION fixture_browser_audit_fail()') }
  await page.getByRole('textbox',{name:'Nom affiché'}).fill(' ')
  await page.getByRole('button',{name:'Enregistrer le nom'}).click(); await page.getByRole('alert').waitFor()
  expect(await page.locator('[data-workspace-name]').textContent()).toBe('Mon espace privé')
  expect(bodies.every(body => !body.includes(privateSession.id) && !body.includes(privateSession.token))).toBe(true)
  expect(workspaceReadUrl).not.toBe('')
  const anonymousRead=await fetch(workspaceReadUrl,{headers:{'sec-fetch-site':'same-origin','x-tsr-serverFn':'true'}})
  expect(anonymousRead.status).toBe(401)
  for (const path of [ensurePath,renamePath]) {
    const result=await fetch(origin+path,{method:'POST',headers:{origin,'content-type':'application/json','x-tsr-serverFn':'true'},body:await rpcBody({workspaceId:stored.id,displayName:'Forbidden'})})
    expect(result.status).toBe(401)
  }
  await stores.administrator.query('DELETE FROM session WHERE id=$1',[privateSession.id])
  const refused=await context.request.get(workspaceReadUrl,{headers:{'sec-fetch-site':'same-origin','x-tsr-serverFn':'true'}})
  expect(refused.status()).toBe(401)
  await page.reload(); await page.waitForURL(origin+'/login')
  expect(await page.locator('html').getAttribute('lang')).toBe('fr')
  await page.getByRole('button',{name:'Continuer avec Google'}).waitFor()
  expect((await page.content()).includes('Mon espace privé')).toBe(false)
  expect((await page.content()).includes(privateSession.user_id)).toBe(false)
  expect((await page.content()).includes('fixture-task6-browser@example.test')).toBe(false)
  expect((await stores.administrator.query('SELECT action,count(*)::int AS n FROM workspace_audit GROUP BY action ORDER BY action')).rows).toEqual([{action:'display-name-changed',n:2},{action:'personal-created',n:1}])
  expect(errors).toEqual([])
  await context.close()
},60000)
