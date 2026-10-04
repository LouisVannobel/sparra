import { expect,test } from 'vitest'
import net from 'node:net'
import { startMigrationCommitProxy } from '../helpers/migration-commit-proxy.mjs'
async function peers() {
  const sockets=new Set<net.Socket>()
  const upstream=net.createServer(socket=>{sockets.add(socket);let bytes=Buffer.alloc(0);socket.on('data',chunk=>{bytes=Buffer.concat([bytes,typeof chunk==='string'?Buffer.from(chunk):chunk]);if(bytes.includes(Buffer.from('COMMIT\0'))){const body=Buffer.from('COMMIT\0'),frame=Buffer.alloc(5+body.length);frame[0]=67;frame.writeUInt32BE(4+body.length,1);body.copy(frame,5);socket.write(frame);bytes=Buffer.alloc(0)}});socket.on('close',()=>sockets.delete(socket))})
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve))
  const address=upstream.address();if(!address||typeof address==='string')throw Error()
  const proxy=startMigrationCommitProxy({targetHost:'127.0.0.1',targetPort:address.port,host:'127.0.0.1',port:0})
  const listen=await proxy.ready
  async function connect(commit:boolean) {
    const client=net.connect(listen.port,'127.0.0.1')
    await new Promise<void>(resolve=>client.once('connect',resolve))
    const closed=new Promise<void>(resolve=>client.once('close',resolve))
    if(commit){const startup=Buffer.from([0,0,0,8,0,3,0,0]),body=Buffer.from('COMMIT\0'),query=Buffer.alloc(5+body.length);query[0]=81;query.writeUInt32BE(4+body.length,1);body.copy(query,5);client.write(Buffer.concat([startup,query]))}else client.end()
    await closed
  }
  return {proxy,connect,close:async()=>{await proxy.stop();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>upstream.close(()=>resolve()))}}
}
test.each([false,true])('terminal_oracle_observes_second_connection_and_commit=%s',async secondCommit=>{
  const owned=await peers()
  try{await owned.connect(true);await owned.connect(secondCommit);const terminal=await owned.proxy.stop()
    expect(terminal).toEqual({type:'terminal',connections:2,commits:secondCommit?2:1,upstreamCompletions:secondCommit?2:1,accepting:false,activeSockets:0})
    expect(terminal.connections===1&&terminal.commits===1&&terminal.upstreamCompletions===1).toBe(false)
  }finally{await owned.close()}
})
