// DSH 0.1.6-alpha.2 has no event for idle cancel or queued prompt intent.
// Intercept only this Agent instance during recovery, then restore exactly.
export function interceptRecoveryIntent(agent,onInterrupt){
  if(typeof onInterrupt!=='function')throw new TypeError('onInterrupt required');
  const originals=new Map(),wrappers=new Map(),installed=[];
  for(const name of ['cancel','followup','steer']){
    if(typeof agent?.[name]!=='function')throw new TypeError(`agent.${name} required`);
    originals.set(name,{method:agent[name],own:Object.getOwnPropertyDescriptor(agent,name)});
  }
  const restore=name=>{
    if(agent[name]!==wrappers.get(name))return;
    const original=originals.get(name);
    if(original.own)Object.defineProperty(agent,name,original.own);
    else delete agent[name];
  };
  try{
    for(const [name,original] of originals){
      const wrapper=function(...args){
        const user=name==='cancel'?args[0]?.kind==='user':args[0]?.source?.kind==='user';
        // User intent must win, while a bookkeeping error must not eat the
        // host's actual cancel or prompt. The host action runs exactly once.
        if(user){try{onInterrupt()}catch{}}
        return original.method.apply(this,args);
      };
      wrappers.set(name,wrapper);
      Object.defineProperty(agent,name,original.own
        ? {configurable:original.own.configurable,enumerable:original.own.enumerable,
          writable:true,value:wrapper}
        : {configurable:true,enumerable:false,writable:true,value:wrapper});
      installed.push(name);
    }
  }catch(error){
    for(const name of installed.reverse())restore(name);
    throw error;
  }
  return ()=>{for(const name of [...installed].reverse())restore(name)};
}
