import { expect, test } from 'vitest'
import { renderPrivatePanel } from '../helpers/private-panel-router'
import { RequestAudio } from '../../src/ui/sparra/request-panel'

// Existing native SSR/router consumer. Pause/load/unmount is a separate actual
// browser witness; SSR does not prove browser buffer retirement.
const detail={id:'11111111-1111-4111-8111-111111111111',audio:{state:'partial' as const,
  durationSeconds:2,expiresAt:'2026-11-01T10:00:00.000Z',partialReason:'interrupted',available:true}}
test('private player has native same-origin preload-none markup and exact expiry/partial notice',async()=>{
  const html=await renderPrivatePanel(<RequestAudio locale="fr" detail={detail} blocked={false}/>,'/app?lang=fr')
  expect(html).toContain('Conversation avec Sparra')
  expect(html).toContain('Cet extrait peut être incomplet.')
  expect(html).toContain('<audio')
  expect(html).toContain('preload="none"')
  expect(html).toContain('src="/api/sparra/audio/'+detail.id+'"')
  expect(html).toMatch(/controlslist="nodownload"/i)
  expect(html.toLowerCase()).toContain('datetime="'+detail.audio.expiresAt.toLowerCase()+'"')
})
test('blocked erase state removes the audio element/source from the private rendered view',async()=>{
  const html=await renderPrivatePanel(<RequestAudio locale="fr" detail={detail} blocked/>,'/app?lang=fr')
  expect(html).not.toContain('<audio')
  expect(html).not.toContain('src="/api/sparra/audio/')
  expect(html).toContain('Conversation indisponible.')
})
