import {isAbsolute} from 'node:path';
export function validateSettings(raw={}) {
  const c={mode:'observe',provider:'*',model:'*',
    stopTimeoutMs:10000,compactTimeoutMs:15000,resumeTimeoutMs:60000,maxResumeRequests:4,
    maxCleanInputChars:128000,compactAboveChars:16000,maxCheckpointChars:64000,
    maxMandatoryChars:48000,maxUserChars:16000,
    recoveryTools:['read','glob','grep','write','edit'],...raw};
  if(!['observe','stop','recover'].includes(c.mode))throw Error('invalid guard mode');
  for(const k of ['provider','model'])
    if(typeof c[k]!=='string'||!c[k].trim()||c[k].length>256)throw Error(`invalid ${k} filter`);
  if(typeof c.stateDirectory!=='string'||!isAbsolute(c.stateDirectory))throw Error('absolute stateDirectory required');
  for(const k of ['stopTimeoutMs','compactTimeoutMs','resumeTimeoutMs','maxResumeRequests',
    'maxCleanInputChars','compactAboveChars','maxCheckpointChars','maxMandatoryChars','maxUserChars'])
    if(!Number.isSafeInteger(c[k])||c[k]<1)throw Error(`invalid ${k}`);
  if(c.maxResumeRequests>16||c.resumeTimeoutMs>300000||c.compactTimeoutMs>60000||c.stopTimeoutMs>30000)
    throw Error('recovery budget exceeds plugin bounds');
  if(!Array.isArray(c.recoveryTools)||c.recoveryTools.some(t=>!['read','glob','grep','write','edit','counter','record'].includes(t)))
    throw Error('recoveryTools must use audited filesystem tools (or synthetic counter/record)');
  return Object.freeze({...c,recoveryTools:Object.freeze([...new Set(c.recoveryTools)])});
}
