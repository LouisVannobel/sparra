import { expect,test } from 'vitest'
import net from 'node:net'
import { retireWebImageCeremony } from '../helpers/web-image-retirement'
async function resource(){const server=net.createServer();await new Promise<void>(accept=>server.listen(0,'127.0.0.1',accept));return {server,close:()=>new Promise<void>((accept,reject)=>server.close(error=>error?reject(error):accept()))}}
test('first_shutdown_failure_does_not_skip_other_acquired_sockets',async()=>{
  const pool=await resource(),peer=await resource()
  try{
    await expect(retireWebImageCeremony({image:async()=>{throw Error('Owned image still live')},pool:pool.close,peer:peer.close})).rejects.toThrow('Image ceremony retirement failed')
    expect(pool.server.listening).toBe(false);expect(peer.server.listening).toBe(false)
  }finally{if(pool.server.listening)await pool.close();if(peer.server.listening)await peer.close()}
})
test('setup_failure_after_peer_acquisition_enters_retirement_scope',async()=>{
  let pool:Awaited<ReturnType<typeof resource>>|undefined,peer:Awaited<ReturnType<typeof resource>>|undefined
  await expect((async()=>{
    try{pool=await resource();peer=await resource();throw Error('Connection refused')}
    finally{await retireWebImageCeremony({pool:pool?.close,peer:peer?.close})}
  })()).rejects.toThrow('Connection refused')
  expect(pool?.server.listening).toBe(false);expect(peer?.server.listening).toBe(false)
})
