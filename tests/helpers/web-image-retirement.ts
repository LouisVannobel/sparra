type CeremonyDisposers=Readonly<{
  image?:()=>Promise<void>;rotatedAuth?:()=>Promise<void>;auth?:()=>Promise<void>;
  limiter?:()=>Promise<void>;pool?:()=>Promise<void>;peer?:()=>Promise<void>
}>
export async function retireWebImageCeremony(disposers:CeremonyDisposers) {
  const failures:unknown[]=[]
  for(const close of [disposers.image,disposers.rotatedAuth,disposers.auth,disposers.limiter,disposers.pool,disposers.peer]){
    try{await close?.()}catch(error){failures.push(error)}
  }
  if(failures.length)throw new AggregateError(failures,'Image ceremony retirement failed')
}
