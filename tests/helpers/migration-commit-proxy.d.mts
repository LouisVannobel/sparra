export function startMigrationCommitProxy(input:{targetHost:string;targetPort:number;host:string;port:number}):{
  ready:Promise<{port:number}>
  stop():Promise<{type:'terminal';connections:number;commits:number;upstreamCompletions:number;accepting:false;activeSockets:number}>
}
