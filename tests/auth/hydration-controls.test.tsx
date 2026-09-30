import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { WorkspacePanel } from '../../src/ui/workspaces/workspace-panel'
import { AccountPanel, LoginPanel } from '../../src/ui/auth/auth-panels'
import { AdditionalPasskeyPanel } from '../../src/ui/auth/additional-passkey-panel'

const forbidden = async (): Promise<never> => { throw new Error('SSR must not invoke an action') }
function disabled(html: string, tag: 'button' | 'input') {
  const controls = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map(match => match[0])
  return { present: controls.length > 0, allDisabled: controls.length > 0 && controls.every(control => /\sdisabled(?:[\s=>])/.test(control)) }
}
test('workspace creation and editing controls are disabled in real SSR until hydrated', () => {
  const create=renderToStaticMarkup(<WorkspacePanel locale="en" workspace={null} pending={false} failed={false} saved={false} onEnsure={forbidden} onRename={forbidden} />)
  const edit=renderToStaticMarkup(<WorkspacePanel locale="en" workspace={{id:'fixture',displayName:'Fixture workspace'}} pending={false} failed={false} saved={false} onEnsure={forbidden} onRename={forbidden} />)
  expect({create:disabled(create,'button').allDisabled,save:disabled(edit,'button').allDisabled,input:disabled(edit,'input').allDisabled,
    realLinks:create.includes('href="/account?lang=en"')&&edit.includes('href="/account?lang=en"')}).toEqual({create:true,save:true,input:true,realLinks:true})
})
test('additional passkey JS action is disabled in real SSR until hydrated', () => {
  const html = renderToStaticMarkup(<AdditionalPasskeyPanel locale="en" userId="fixture" availability="available" passkeys={[]}
    onBegin={forbidden} onAuthorize={forbidden} onFinish={forbidden} onRefresh={forbidden} />)
  expect(disabled(html, 'button')).toEqual({ present: true, allDisabled: true })
})
test('Google magic request and logout JS controls are disabled in real SSR until hydrated', () => {
  const login = renderToStaticMarkup(<LoginPanel locale="en" enabled pending={false} failed={false} onBegin={() => {}}
    magic magicSignup onRequest={forbidden} />)
  const account = renderToStaticMarkup(<AccountPanel locale="en" principal={{ userId:'fixture',name:'Fixture',email:'fixture@example.test' }} pending={false} failed={false} onLogout={() => {}} />)
  expect({loginButtons:disabled(login,'button').allDisabled,emailInput:disabled(login,'input').allDisabled,
    logout:disabled(account,'button').allDisabled,realLink:account.includes('href="/workspace?lang=en"')})
    .toEqual({loginButtons:true,emailInput:true,logout:true,realLink:true})
})
