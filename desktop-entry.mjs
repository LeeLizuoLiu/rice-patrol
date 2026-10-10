import z from '@deepseek-ai/schemastery';
import {installRuntime,inject,name} from './index.mjs';
export {inject,name,installRuntime};
export const Config=z.object({
 provider:z.string().default('*'),model:z.string().default('*'),
 stateDirectory:z.string(),
 stopTimeoutMs:z.natural().default(10000),compactTimeoutMs:z.natural().default(45000),
 resumeTimeoutMs:z.natural().default(300000),alwaysCompact:z.boolean().default(true),
 maxCleanInputChars:z.natural().default(128000),compactAboveChars:z.natural().default(16000),
 maxCheckpointChars:z.natural().default(64000),maxMandatoryChars:z.natural().default(48000),
 maxUserChars:z.natural().default(16000)
});
export async function apply(ctx,raw){
 const config=Object.fromEntries(Object.entries(raw??{}).filter(([,v])=>v!==undefined));
 ctx.effect(()=>ctx.settings.configure({auto:false}),'rice patrol settings');
 const runtime=await installRuntime(ctx,config);
 ctx.effect(()=>()=>runtime.dispose(),'rice patrol runtime');
}
