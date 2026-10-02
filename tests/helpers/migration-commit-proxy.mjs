import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export function startMigrationCommitProxy({targetHost,targetPort,host,port}) {
  let connections=0,commits=0,upstreamCompletions=0,accepting=false,stopping
  const sockets=new Set()
  const server=net.createServer(client=>{
    connections++;sockets.add(client)
    client.on('close',()=>sockets.delete(client))
    if(!accepting){client.destroy();return}
    const upstream=net.connect({host:targetHost,port:targetPort});sockets.add(upstream)
    upstream.on('close',()=>sockets.delete(upstream))
    let startup=true,clientBuffer=Buffer.alloc(0),serverBuffer=Buffer.alloc(0)
    client.on('data',chunk=>{
      clientBuffer=Buffer.concat([clientBuffer,chunk])
      while(clientBuffer.length>=5){
        const size=startup?clientBuffer.readUInt32BE(0):clientBuffer.readUInt32BE(1)+1
        if(size<4||size>1048576){client.destroy();upstream.destroy();return}
        if(clientBuffer.length<size)break
        const frame=clientBuffer.subarray(0,size);clientBuffer=clientBuffer.subarray(size)
        if(startup)startup=false
        else if(frame[0]===81&&frame.subarray(5,-1).toString('utf8').trim().toUpperCase()==='COMMIT')commits++
        upstream.write(frame)
      }
    })
    upstream.on('data',chunk=>{
      serverBuffer=Buffer.concat([serverBuffer,chunk])
      while(serverBuffer.length>=5){
        const size=serverBuffer.readUInt32BE(1)+1
        if(size<5||size>1048576){client.destroy();upstream.destroy();return}
        if(serverBuffer.length<size)break
        const frame=serverBuffer.subarray(0,size);serverBuffer=serverBuffer.subarray(size)
        if(frame[0]===67&&frame.subarray(5,-1).toString('utf8')==='COMMIT'){
          upstreamCompletions++;client.destroy();upstream.destroy();return
        }
        client.write(frame)
      }
    })
    for(const socket of [client,upstream])socket.on('error',()=>{client.destroy();upstream.destroy()})
    client.on('end',()=>upstream.end());upstream.on('end',()=>client.end())
  })
  const ready=new Promise((accept,reject)=>{
    server.once('error',reject)
    server.listen(port,host,()=>{accepting=true;accept({port:server.address().port})})
  })
  function stop() {
    return stopping??=(async()=>{
      accepting=false
      const closed=new Promise((accept,reject)=>server.close(error=>error?reject(error):accept()))
      for(const socket of sockets)socket.destroy()
      await closed
      const deadline=Date.now()+1500
      while(sockets.size&&Date.now()<deadline)await new Promise(accept=>setTimeout(accept,10))
      if(sockets.size)throw Error('Proxy retirement unresolved')
      return {type:'terminal',connections,commits,upstreamCompletions,accepting:false,activeSockets:0}
    })()
  }
  return {ready,stop}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const proxy=startMigrationCommitProxy({targetHost:'pg',targetPort:5432,host:'0.0.0.0',port:5432})
  await proxy.ready;process.stdout.write('READY\n')
  process.once('SIGTERM',async()=>{
    try{process.stdout.write(JSON.stringify(await proxy.stop())+'\n')}
    catch{process.stderr.write('Proxy retirement failed\n');process.exitCode=1}
  })
}
