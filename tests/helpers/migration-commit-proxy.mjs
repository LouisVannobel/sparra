import net from 'node:net'
let connections=0,commits=0,acknowledged=0
const sockets=new Set()
const server=net.createServer(client=>{
  connections++;sockets.add(client)
  const upstream=net.connect({host:'pg',port:5432});sockets.add(upstream)
  let startup=true,clientBuffer=Buffer.alloc(0),serverBuffer=Buffer.alloc(0)
  client.on('data',chunk=>{
    clientBuffer=Buffer.concat([clientBuffer,chunk])
    while(clientBuffer.length>=5){
      const size=startup?clientBuffer.readUInt32BE(0):clientBuffer.readUInt32BE(1)+1
      if(size<4||size>1048576){client.destroy();return}
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
      if(size<5||size>1048576){upstream.destroy();return}
      if(serverBuffer.length<size)break
      const frame=serverBuffer.subarray(0,size);serverBuffer=serverBuffer.subarray(size)
      if(frame[0]===67&&frame.subarray(5,-1).toString('utf8')==='COMMIT'){
        acknowledged++;process.stdout.write(JSON.stringify({connections,commits,acknowledged})+'\n');client.destroy();upstream.destroy();return
      }
      client.write(frame)
    }
  })
  for(const socket of [client,upstream]){socket.on('error',()=>{client.destroy();upstream.destroy()});socket.on('close',()=>sockets.delete(socket))}
  client.on('end',()=>upstream.end());upstream.on('end',()=>client.end())
})
server.listen(5432,'0.0.0.0',()=>process.stdout.write('READY\n'))
process.on('SIGTERM',()=>{for(const socket of sockets)socket.destroy();server.close(()=>process.exit(0))})
