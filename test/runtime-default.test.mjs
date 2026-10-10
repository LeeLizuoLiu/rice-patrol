import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {installRuntime} from '../index.mjs';

const fromRepo=createRequire(import.meta.url);
const anchor=process.env.DSH_TEST_ANCHOR ?? fromRepo.resolve('@deepseek-ai/dsh/package.json');
const requireHost=createRequire(anchor),host=name=>import(requireHost.resolve('@deepseek-ai/'+name));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(get) {
  const deadline=Date.now()+4000;
  while(Date.now()<deadline){const value=await get();if(value)return value;await delay(10);}
  throw Error('mock recovery timed out');
}
async function scenario(mode,normal=false) {
  const home=await fs.mkdtemp(path.join(tmpdir(),'rice-default-recovery-'));
  const {Context,Service}=await host('cordis');
  const {PluginPackages,createRuntimeResolution}=await host('dsh-app-boot');
  const {LlmAdapter,createUserMessage}=await host('dsh-llm');
  const {releasedV4SessionFormatCodec}=await host('dsh-session-format-v3-to-v4');
  const ctx=new Context(),fibers=[];let plugin,created;
  let calls=0,closed=0;const inputs=[];
  try {
    fibers.push(await ctx.plugin(PluginPackages,{resolution:await createRuntimeResolution({installAnchor:anchor,home})}));
    for(const [pkg,config] of [['dsh-agent',{}],['dsh-session',{}],['dsh-session-projection',{}],['dsh-token-meter',{}],['dsh-system-prompt',{includeRuntimeContext:false}],['dsh-tools',{mode:'native'}],['dsh-llm',{}],['dsh-agent-loop',{agents:[]}],['dsh-llm-retry',{}]]) {
      const mod=await host(pkg);fibers.push(await ctx.plugin(mod.default??mod,config));
    }
    ctx.on('session/flush',session=>{for(const event of session.log)releasedV4SessionFormatCodec.encodeEvent(event);});
    class FakeConnection extends Service {
      constructor(context){super(context,'connection');this.fetch={register:()=>()=>{}};}
    }
    fibers.push(await ctx.plugin(FakeConnection));
    class FakeAdapter extends LlmAdapter {
      providerInfo(id){return {id,name:id};}
      async resolveModel(provider,id){return {provider,id,name:id};}
      async prepareCall(provider,model){return {model:await this.resolveModel(provider,model),stream:options=>this.dispatch(options)};}
      stream(){throw Error('must use prepared mock stream');}
      async *dispatch(options) {
        calls++;inputs.push(JSON.stringify(options.messages));
        try {
          if(!normal&&calls===1) {
            yield {type:'block-start',index:0,blockType:'reasoning'};
            yield {type:'reasoning-delta',index:0,text:'MOCK_LOOP.\n'.repeat(120)};
            // This finish must never reach the host: the guard closes this stream first.
            yield {type:'finish',reason:{kind:'max-tokens'}};return;
          }
          yield {type:'block-start',index:0,blockType:'text'};
          yield {type:'text-delta',index:0,text:'MOCK_TASK_FINISHED'};
          yield {type:'block-end',index:0,block:{type:'text',text:'MOCK_TASK_FINISHED'}};
          yield {type:'finish',reason:{kind:'stop'}};
        } finally {closed++;}
      }
    }
    ctx.llm.registerAdapter(['local-mock'],new FakeAdapter());
    plugin=await installRuntime(ctx,{...(mode===undefined?{}:{mode}),stateDirectory:path.join(home,'state'),stopTimeoutMs:1000,resumeTimeoutMs:2000});
    created=await ctx.agents.create({sessionId:'mock-session',agentOptions:{provider:'local-mock',model:'mock-model'}});
    const agent=created.agent;
    agent.followup(createUserMessage({content:[{type:'text',text:'Complete the mock task.'}],source:{kind:'user'}}));
    if(normal)await until(()=>agent.status==='idle'&&calls===1);
    else {
      const status=await until(async()=>{const status=await plugin.status.get(agent.session.id);return status&&['COMPLETED','BLOCKED','FAILED','INTERRUPTED','STOPPED'].includes(status.state)?status:false;});
      assert.equal(status.state,'COMPLETED',JSON.stringify(status));
      await agent.whenIdle();
      assert.equal(calls,2,'one loop request followed by one continuation in the same Agent');
      assert.equal(inputs[1].includes('MOCK_LOOP.'),false);
      assert.ok(inputs[1].includes('preceding assistant generation was stopped'));
      assert.ok(agent.session.log.some(e=>e.type==='assistant/attempt'));
    }
    assert.equal(closed,calls);
    const last=agent.session.log.filter(e=>e.type==='assistant/message').at(-1);
    assert.equal(last.data.message.content.filter(b=>b.type==='text').map(b=>b.text).join(''),'MOCK_TASK_FINISHED');
    assert.equal((await fs.readdir(path.join(home,'state'))).some(name=>name.startsWith('events-')),false);
  } finally {
    await plugin?.dispose();await created?.dispose();
    for(const fiber of fibers.reverse())await fiber.dispose();
    await fs.rm(home,{recursive:true,force:true});
  }
}
for(const mode of [undefined,'stop','observe','recover'])test(`fixed recovery with legacy mode ${String(mode)}`,{timeout:10000},()=>scenario(mode));
test('normal output completes without recovery', {timeout:10000},()=>scenario(undefined,true));
