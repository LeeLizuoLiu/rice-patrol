import {homedir} from 'node:os';
import {isAbsolute,join} from 'node:path';
export function validateSettings(raw={}) {
  // Retire the old child-Agent limits without rejecting profiles that still
  // contain them. The resumed main Agent uses the host's normal policy.
  const {maxResumeRequests,maxResumeToolCalls,recoveryTools,...current}=raw;
  const c={mode:'stop',provider:'*',model:'*',
    stateDirectory:join(process.env.DSH_HOME??join(homedir(),'.dsh'),'rice-patrol-state'),
    stopTimeoutMs:10000,compactTimeoutMs:45000,resumeTimeoutMs:300000,alwaysCompact:true,
    maxCleanInputChars:128000,compactAboveChars:16000,maxCheckpointChars:64000,
    maxMandatoryChars:48000,maxUserChars:16000,
    ...current};
  if(!['observe','stop','recover'].includes(c.mode))throw Error('invalid guard mode');
  for(const k of ['provider','model'])
    if(typeof c[k]!=='string'||!c[k].trim()||c[k].length>256)throw Error(`invalid ${k} filter`);
  if(typeof c.stateDirectory!=='string'||!isAbsolute(c.stateDirectory))throw Error('absolute stateDirectory required');
  for(const k of ['stopTimeoutMs','compactTimeoutMs','resumeTimeoutMs',
    'maxCleanInputChars','compactAboveChars','maxCheckpointChars','maxMandatoryChars','maxUserChars'])
    if(!Number.isSafeInteger(c[k])||c[k]<1)throw Error(`invalid ${k}`);
  if(c.resumeTimeoutMs>300000||c.compactTimeoutMs>60000||c.stopTimeoutMs>30000)
    throw Error('recovery budget exceeds plugin bounds');
  if(typeof c.alwaysCompact!=='boolean')throw Error('alwaysCompact must be boolean');
  return Object.freeze(c);
}
