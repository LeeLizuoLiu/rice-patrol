import {homedir} from 'node:os';
import {isAbsolute,join} from 'node:path';
export function validateSettings(raw={}) {
  const c={mode:'stop',provider:'*',model:'*',
    stateDirectory:join(process.env.DSH_HOME??join(homedir(),'.dsh'),'rice-patrol-state'),
    stopTimeoutMs:10000,compactTimeoutMs:45000,resumeTimeoutMs:300000,maxResumeRequests:16,
    maxResumeToolCalls:128,alwaysCompact:true,
    maxCleanInputChars:128000,compactAboveChars:16000,maxCheckpointChars:64000,
    maxMandatoryChars:48000,maxUserChars:16000,
    recoveryTools:'host',...raw};
  if(!['observe','stop','recover'].includes(c.mode))throw Error('invalid guard mode');
  for(const k of ['provider','model'])
    if(typeof c[k]!=='string'||!c[k].trim()||c[k].length>256)throw Error(`invalid ${k} filter`);
  if(typeof c.stateDirectory!=='string'||!isAbsolute(c.stateDirectory))throw Error('absolute stateDirectory required');
  for(const k of ['stopTimeoutMs','compactTimeoutMs','resumeTimeoutMs','maxResumeRequests','maxResumeToolCalls',
    'maxCleanInputChars','compactAboveChars','maxCheckpointChars','maxMandatoryChars','maxUserChars'])
    if(!Number.isSafeInteger(c[k])||c[k]<1)throw Error(`invalid ${k}`);
  if(c.maxResumeRequests>16||c.maxResumeToolCalls>256||c.resumeTimeoutMs>300000||c.compactTimeoutMs>60000||c.stopTimeoutMs>30000)
    throw Error('recovery budget exceeds plugin bounds');
  if(typeof c.alwaysCompact!=='boolean')throw Error('alwaysCompact must be boolean');
  if(c.recoveryTools!=='host'&&(!Array.isArray(c.recoveryTools)||
    c.recoveryTools.some(t=>!['read','glob','grep','write','edit','counter','record'].includes(t))))
    throw Error('recoveryTools must be host or an audited tool list');
  return Object.freeze({...c,recoveryTools:c.recoveryTools==='host'?'host':Object.freeze([...new Set(c.recoveryTools)])});
}
