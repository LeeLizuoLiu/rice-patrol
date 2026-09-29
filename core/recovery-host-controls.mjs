// DSH 0.1.6-alpha.2 has no event for idle cancel or queued prompt intent.
// Intercept only this Agent instance during recovery, then restore exactly.
export function interceptRecoveryIntent(agent,onInterrupt,{onPark=()=>{},onBeforePark=()=>{}}={}){
  if(typeof onInterrupt!=='function')throw new TypeError('onInterrupt required');
  const originals=new Map(),wrappers=new Map(),installed=[];
  for(const name of ['cancel','followup','steer',...(typeof agent?.send==='function'?['send']:[])]){
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
        if(user){try{onInterrupt(name==='cancel'?'USER_STOPPED':'NEW_USER_INPUT')}catch{}}
        if(name==='send'&&args[2]===true&&!user&&
          !(args[0]?.source?.kind==='plugin'&&args[0].source.plugin==='dsh-rice-patrol')){
          // A background result may arrive after the stopped turn but before
          // maintenance owns the Agent. Keep its original durable inbox item
          // without starting another turn; the clean handoff will wake once.
          onBeforePark();
          agent.inbox.splice(args[1],Infinity,0,[args[0]]);
          onPark(args[1],args[0]);
          return;
        }
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
