import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHost,host} from './host-runtime.mjs';
import {SyntheticHttpAdapter,chunk,finish,tool,loop} from './synthetic-adapter.mjs';
import {installRuntime} from '../index.mjs';

const routeA={provider:'synthetic-provider-a',model:'reasoning-model-a',reasoningEffort:'high'};
const routeB={provider:'another-provider',model:'model-without-effort'};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const terminal=new Set(['COMPLETED','BLOCKED','INTERRUPTED','STOPPED','FAILED']);
const endOf=events=>events.filter(event=>event.type==='turn/end').at(-1)?.data.reason;
const textOf=events=>events.filter(event=>event.type==='assistant/message').at(-1)?.data.message.content
  .filter(block=>block.type==='text').map(block=>block.text).join('');
async function until(predicate,ms=5000){
  const deadline=Date.now()+ms;
  while(Date.now()<deadline){const value=await predicate();if(value)return value;await wait(10)}
  throw Error('Synthetic scenario exceeded its finite deadline');
}

async function runScenario(scenario,{routes=[routeA],settings={},plain=false,initialRoute,image=false,repeatTurn=false}={}){
  const hostRuntime=await createHost(),{ctx,events}=hostRuntime;
  const directory=await mkdtemp(join(tmpdir(),'dsh-generic-runtime-'));
  const fibers=[],parents=[],responses=new Set(),rpcHandlers=new Map();
  const stats={requests:[],counter:0,record:0,errors:[],children:[],prepared:[],streams:[],closes:[],releaseIgnored:[],imageReads:0};
  const rpc=async(endpoint,payload)=>{
    const handler=rpcHandlers.get(`/api/${endpoint}`);assert.ok(handler,'dedicated guard route must be registered');
    const rpcId='synthetic-rpc';
    const response=await handler(new Request(`http://127.0.0.1/api/${endpoint}`,{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method:endpoint,payload})}));
    assert.equal(response.status,200);
    const message=await response.json();assert.equal(message.type,'server-response');assert.equal(message.rpcId,rpcId);
    return message.result;
  };
  let plugin;
  const server=http.createServer(async(req,res)=>{
    responses.add(res);res.on('close',()=>responses.delete(res));
    try{
      let text='';for await(const part of req)text+=part;
      const payload=JSON.parse(text),messages=JSON.stringify(payload.messages);
      assert.equal(req.url,'/synthetic-stream');
      assert.match(req.headers['user-agent'],/deepseek/i);
      const root=Number(/SYNTHETIC_TASK_(\d+)/.exec(messages)?.[1]);
      assert.ok(Number.isSafeInteger(root));
      const route=routes[root];assert.ok(route);
      assert.equal(payload.provider,route.provider);assert.equal(payload.model,route.model);
      assert.equal(payload.reasoningEffort,route.reasoningEffort);
      if(route.reasoningEffort===undefined)assert.equal(Object.hasOwn(payload,'reasoningEffort'),false);
      const compactCount=stats.requests.filter(request=>request.root===root&&request.kind==='compact').length;
      const resumeCount=stats.requests.filter(request=>request.root===root&&request.kind==='resume').length;
      const laterUserTurn=repeatTurn&&compactCount===1&&resumeCount>=2;
      const kind=messages.includes('CLEAN_COMPACTION_INPUT')?'compact':
        laterUserTurn?'parent':messages.includes('Rice Patrol clean checkpoint')?'resume':'parent';
      const number=stats.requests.filter(request=>request.kind===kind&&request.root===root).length+1;
      const request={root,kind,number,payload};stats.requests.push(request);
      res.on('close',()=>stats.closes.push({...request,natural:res.writableEnded}));
      res.writeHead(200,{'content-type':'application/x-ndjson'});res.flushHeaders();
      if(plain){
        if(scenario!=='normal-answer')loop(res,{complete:true});
        finish(res);return;
      }
      if(kind==='compact'){
        if(scenario==='compact-max-tokens'){
          chunk(res,{type:'block-start',index:0,blockType:'text'});
          chunk(res,{type:'text-delta',index:0,text:'INCOMPLETE_SYNTHETIC_SUMMARY'});
          chunk(res,{type:'block-end',index:0,block:{type:'text',text:'INCOMPLETE_SYNTHETIC_SUMMARY'}});
          chunk(res,{type:'finish',reason:{kind:'max-tokens'}});res.end();return;
        }
        if(scenario==='user-stop'&&number===1){
          chunk(res,{type:'block-start',index:0,blockType:'reasoning'});
          chunk(res,{type:'reasoning-delta',index:0,text:'Waiting for an explicit synthetic cancellation.\n'});return;
        }
        finish(res,`SYNTHETIC_TASK_${root}: One original tool result is recorded; continue the unfinished synthetic task.`);return;
      }
      if(kind==='parent'){
        if(number===1)tool(res,'counter',`parent-counter-${root}`);else loop(res);
        return;
      }
      assert.ok(!messages.includes('Let me try.'),'original reasoning tail must be absent from resumed main Agent input');
      if(scenario==='many-requests'){
        if(number<=20)tool(res,'record',`main-record-${root}-${number}`,
          {label:`SYNTHETIC_RECORD_${root}_${number}`});
        else finish(res);
        return;
      }
      if(number===1){tool(res,'record',`child-record-${root}-1`,{label:`SYNTHETIC_RECORD_${root}`});return}
      if(scenario==='duplicate'&&number===2){tool(res,'record',`child-record-${root}-2`,{label:`SYNTHETIC_RECORD_${root}`});return}
      if(scenario==='child-loop'){loop(res);return}
      finish(res);
    }catch(error){stats.errors.push({name:error.name,message:error.message});res.destroy(error)}
  });
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
    const origin=`http://127.0.0.1:${server.address().port}`;
    // Two distinct adapter instances prove no singleton WorkBuddy transport is involved.
    for(const provider of new Set(routes.map(route=>route.provider)))
      ctx.llm.registerAdapter([provider],new SyntheticHttpAdapter(origin,stats,{ignoreCancellation:scenario==='ignores-abort'}));
    const {Service}=await host('@deepseek-ai/cordis');
    if(image){
      class FakeAttachments extends Service{
        constructor(context){super(context,'attachments')}
        async readImage(ref){
          assert.equal(ref.attachmentId,`sha256:${'c'.repeat(64)}`);
          stats.imageReads++;
          return {ref,data:new Uint8Array(4)};
        }
      }
      fibers.push(await ctx.plugin(FakeAttachments));
    }
    class FakeConnection extends Service {
      constructor(context){
        super(context,'connection');
        this.fetch={register(route){
          assert.ok(['/api/research-guard/status','/api/research-guard/stop','/api/research-guard/dismiss'].includes(route.path));
          assert.deepEqual(route.methods,['POST']);assert.equal(route.requestBody,'buffered');
          assert.ok(!rpcHandlers.has(route.path),'route handler is unique');
          rpcHandlers.set(route.path,route.fetch);return ()=>rpcHandlers.delete(route.path);
        }};
      }
    }
    fibers.push(await ctx.plugin(FakeConnection));
    for(const [name,config] of [['dsh-subagent',{maxDepth:1,maxActiveSubagents:routes.length}],['dsh-subagent-spawn-in-process',{providerName:'spawn'}]]){
      const module=await host(`@deepseek-ai/${name}`);fibers.push(await ctx.plugin(module.default??module,config));
    }
    ctx.on('agent/created',({agent})=>{if(agent.session.header.parentSession)stats.children.push(agent)});
    ctx.on('agent/error',({error})=>stats.errors.push({name:error.name,message:error.message}));
    for(const name of ['counter','record'])ctx.tools.register({name,description:'Synthetic local counter only',
      parameters:{type:'object',properties:name==='record'?{label:{type:'string'}}:{},additionalProperties:false},
      output:{schema:{type:'integer'},render:(_,value)=>[{type:'text',text:`synthetic ${name} count ${value}`}]},
      execute:async()=>++stats[name]});
    plugin=await installRuntime(ctx,{mode:'recover',stateDirectory:directory,recoveryTools:['counter','record'],
      stopTimeoutMs:1000,compactTimeoutMs:2000,resumeTimeoutMs:3000,maxResumeRequests:4,
      compactAboveChars:['compact','user-stop'].includes(scenario)?1:128000,...settings});
    if(initialRoute)ctx.on('agent/request',async(payload,next)=>{
      const original=await next();
      if(payload.agent.session.header.parentSession)return original;
      const {reasoningEffort,...rest}=original;
      return {...rest,...routes[0]};
    });
    assert.equal(rpcHandlers.size,3);
    assert.equal((await rpc('research-guard/status',{})).error.code,'gateway/bad-request');
    const {createUserMessage}=await host('@deepseek-ai/dsh-llm');
    for(const [root,route] of routes.entries()){
      const parent=await ctx.agents.create({sessionId:`generic-runtime-${scenario}-${root}`,agentOptions:initialRoute??route});
      parents.push(parent);
      parent.agent.followup(createUserMessage({content:[{type:'text',text:
        `SYNTHETIC_TASK_${root}: Complete one synthetic recorded operation. Keep the existing counter unchanged after its first execution.`},
        ...(image?[{type:'image',attachment:{attachmentId:`sha256:${'c'.repeat(64)}`,
          mediaType:'image/png',bytes:4,width:1,height:1}}]:[])],source:{kind:'user'}}));
    }
    let stopAccepted=false,lastStatuses=[];
    let statuses=plain?[]:await until(async()=>{
      const current=[];
      for(const parent of parents){
        const reply=await rpc('research-guard/status',{sessionId:parent.agent.session.id});
        assert.equal(reply.ok,true);assert.equal(reply.value.schema,1);
        const status=reply.value.episodes[0];current.push(status);
        if(scenario==='user-stop'&&stats.requests.some(request=>request.kind==='compact')&&!stopAccepted){
          const stop=await rpc('research-guard/stop',{sessionId:parent.agent.session.id,episodeId:status?.episodeId});
          assert.equal(stop.ok,true);stopAccepted=stop.value.accepted;
        }
      }
      lastStatuses=current;
      return current.every(status=>status&&terminal.has(status.state))?current:false;
    }).catch(error=>{
      error.message+=`: ${JSON.stringify({statuses:lastStatuses,requests:stats.requests.map(({kind,root})=>({kind,root})),errors:stats.errors,
        ends:parents.map(parent=>endOf(events.get(parent.agent.session.id)??[]))})}`;
      throw error;
    });
    await Promise.all(parents.map(parent=>parent.agent.whenIdle()));
    if(scenario==='child-loop')statuses=await until(async()=>{
      const current=[];
      for(const parent of parents){
        const reply=await rpc('research-guard/status',{sessionId:parent.agent.session.id});
        current.push(reply.value.episodes[0]);
      }
      return current.every((status,index)=>status?.episodeId!==statuses[index]?.episodeId&&
        terminal.has(status?.state))?current:false;
    });
    if(repeatTurn){
      assert.equal(plain,false);
      assert.equal(routes.length,1);
      assert.equal(statuses[0].state,scenario==='user-stop'?'INTERRUPTED':'COMPLETED');
      const previousEpisode=statuses[0].episodeId;
      parents[0].agent.followup(createUserMessage({content:[{type:'text',text:
        'SYNTHETIC_TASK_0: Continue the same session in a new user turn. Do not repeat earlier tool operations.'}],
        source:{kind:'user'}}));
      statuses=await until(async()=>{
        const reply=await rpc('research-guard/status',{sessionId:parents[0].agent.session.id});
        const current=reply.value.episodes[0];
        return current?.episodeId!==previousEpisode&&terminal.has(current?.state)?[current]:false;
      });
      await parents[0].agent.whenIdle();
    }
    const parentEvents=parents.map(parent=>events.get(parent.agent.session.id)??[]);
    const childEvents=stats.children.map(child=>events.get(child.session.id)??[]);
    if(plain){
      await until(()=>stats.closes.length===stats.requests.length);
      for(const parent of parents){
        const reply=await rpc('research-guard/status',{sessionId:parent.agent.session.id});
        statuses.push(reply.value.episodes[0]);
      }
      assert.equal(stats.requests.length,routes.length);
      assert.equal(stats.children.length,0);assert.equal(stats.counter,0);assert.equal(stats.record,0);
      assert.equal(stats.streams.some(stream=>stream.aborted),false);
      assert.ok(stats.closes.every(close=>close.natural));
      assert.ok(parentEvents.every(log=>endOf(log)?.kind==='completed'));
      assert.ok(parentEvents.every(log=>textOf(log)==='SYNTHETIC_FINISHED'));
    }else{
      if(scenario!=='ignores-abort')
        await until(()=>stats.closes.filter(close=>close.kind==='parent'&&!close.natural).length===(repeatTurn?2:1)*routes.length);
      assert.equal(stats.requests.filter(request=>request.kind==='parent').length,(repeatTurn?3:2)*routes.length);
      assert.equal(stats.counter,routes.length);
      for(const log of parentEvents)assert.ok(log.some(event=>event.type==='turn/end'&&
        event.data.reason?.reason?.reason==='reasoning-guard:REASONING_LOOP_CONFIRMED'));
      assert.equal(stats.children.length,0,'recovery stays in the original Agent');
      for(const parent of parents)assert.equal(stats.streams.filter(stream=>
        stream.sessionId===parent.agent.session.id&&stream.purpose!=='compaction'&&stream.aborted).length,
        scenario==='ignores-abort'||scenario==='child-loop'?2:(repeatTurn?2:1));
    }
    assert.deepEqual(stats.errors,[],'no adapter, route, or AgentLoop errors');
    assert.ok(stats.prepared.length>=stats.requests.length,'requests pass the public prepareCall contract');
    if(!plain){
      for(const [index,parent] of parents.entries()){
        const sessionId=parent.agent.session.id,episodeId=statuses[index].episodeId;
        const wrong=await rpc('research-guard/dismiss',{sessionId,episodeId:'other-episode'});
        assert.deepEqual(wrong,{ok:true,value:{dismissed:false}});
        const dismissed=await rpc('research-guard/dismiss',{sessionId,episodeId});
        assert.deepEqual(dismissed,{ok:true,value:{dismissed:true}});
        assert.deepEqual((await rpc('research-guard/status',{sessionId})).value.episodes,[]);
      }
    }
    return {stats,status:statuses[0],statuses,parentEvents:parentEvents[0],allParentEvents:parentEvents,childEvents,stopAccepted,
      mainSurface:parents[0].agent.session.deriveMessages()};
  }finally{
    await plugin?.dispose();
    for(const parent of parents)await parent.dispose();
    assert.equal(rpcHandlers.size,0,'plugin disposal unregisters its dedicated routes');
    await Promise.allSettled(stats.releaseIgnored.map(release=>release()));
    for(const response of responses)response.destroy();server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    for(const fiber of fibers.reverse())await fiber.dispose();
    await hostRuntime.close();await rm(directory,{recursive:true,force:true});
  }
}

test('generic public API: AgentLoop cancels upstream, compacts, then resumes the same Agent',{timeout:10000},async()=>{
  const result=await runScenario('normal');
  assert.equal(result.status.state,'COMPLETED',JSON.stringify(result.status));
  assert.equal(result.stats.record,1);assert.equal(result.stats.children.length,0);
  assert.deepEqual(result.stats.requests.map(request=>request.kind),['parent','parent','compact','resume','resume']);
  assert.equal(endOf(result.parentEvents)?.kind,'completed');
  assert.equal(result.parentEvents.filter(event=>event.type==='compaction/summary').length,1);
  assert.ok(!JSON.stringify(result.stats.requests.find(request=>request.kind==='resume').payload.messages).includes('Let me try.'));
  assert.ok(!JSON.stringify(result.mainSurface).includes('Let me try.'));
  assert.ok(result.parentEvents.some(event=>event.type==='user/message'&&
    event.surfaceOp?.op==='replace'),'the checkpoint replaced only the model-visible surface');
});

test('resumed main Agent can make more than the old 16-request child limit',{timeout:10000},async()=>{
  const result=await runScenario('many-requests');
  assert.equal(result.status.state,'COMPLETED',JSON.stringify(result.status));
  assert.equal(result.stats.requests.filter(request=>request.kind==='resume').length,21);
  assert.equal(result.stats.record,20);
  assert.equal(result.stats.children.length,0);
});

test('generic public API: a later user turn in the same session receives a fresh automatic recovery',{timeout:10000},async()=>{
  const result=await runScenario('normal',{repeatTurn:true});
  assert.equal(result.status.state,'COMPLETED',JSON.stringify(result.status));
  assert.equal(result.stats.children.length,0);
  assert.equal(result.stats.requests.filter(request=>request.kind==='compact').length,2);
  assert.equal(result.stats.record,1,'the completed side effect was not repeated');
});

test('generic public API: stopping one recovery does not disable later user turns',{timeout:10000},async()=>{
  const result=await runScenario('user-stop',{repeatTurn:true});
  assert.equal(result.stopAccepted,true);
  assert.equal(result.status.state,'COMPLETED',JSON.stringify(result.status));
  assert.equal(result.stats.children.length,0);
  assert.equal(result.stats.requests.filter(request=>request.kind==='compact').length,2);
});

test('generic public API: recovery compacts text and restores a verified user image to the main Agent',{timeout:10000},async()=>{
  const result=await runScenario('normal',{image:true});
  assert.equal(result.status.state,'COMPLETED',JSON.stringify(result.status));
  assert.equal(result.stats.imageReads,2);
  const compact=result.stats.requests.find(request=>request.kind==='compact');
  const continued=result.stats.requests.find(request=>request.kind==='resume');
  assert.ok(!JSON.stringify(compact.payload.messages).includes('"type":"image"'));
  assert.ok(JSON.stringify(continued.payload.messages).includes('"type":"image"'));
  assert.equal(result.stats.children.length,0);
});

test('generic public API: duplicate side effect in the resumed main Agent does not execute twice',{timeout:10000},async()=>{
  const result=await runScenario('duplicate');
  assert.equal(result.stats.record,1,JSON.stringify(result.status));
  assert.equal(result.stats.children.length,0);
  assert.ok(result.parentEvents.filter(event=>event.type==='tool/result').some(event=>event.data.message.content[0].isError));
  assert.ok(result.stats.requests.filter(request=>request.kind==='resume').length<=4);
});

test('generic public API: second loop in the same user turn stops without another recovery',{timeout:10000},async()=>{
  const result=await runScenario('child-loop');
  assert.equal(result.stats.record,1,JSON.stringify(result.status));assert.equal(result.stats.children.length,0);
  assert.equal(result.status.state,'BLOCKED');
  assert.deepEqual(result.stats.requests.map(request=>request.kind),['parent','parent','compact','resume','resume']);
  assert.equal(endOf(result.parentEvents)?.kind,'aborted');
});

test('generic public API: clean compaction makes one call with the original route and effort',{timeout:10000},async()=>{
  const result=await runScenario('compact');
  assert.equal(result.status.state,'COMPLETED',JSON.stringify({status:result.status,requests:result.stats.requests.map(({kind})=>kind),streams:result.stats.streams.map(({purpose})=>purpose),prepared:result.stats.prepared}));assert.equal(result.stats.record,1);
  assert.deepEqual(result.stats.requests.map(request=>request.kind),['parent','parent','compact','resume','resume']);
  assert.equal(result.status.compactCalls,1);
  assert.ok(!JSON.stringify(result.stats.requests.find(request=>request.kind==='compact').payload.messages).includes('Let me try.'));
});

test('generic public API: incomplete compaction never wakes the main Agent',{timeout:10000},async()=>{
  const result=await runScenario('compact-max-tokens');
  assert.equal(result.status.state,'BLOCKED',JSON.stringify(result.status));
  assert.equal(result.status.reason,'COMPACTION_MAX_TOKENS');
  assert.equal(result.stats.children.length,0);
  assert.equal(result.stats.requests.filter(request=>request.kind==='compact').length,1);
  assert.equal(result.stats.requests.filter(request=>request.kind==='resume').length,0);
});

test('generic public API: host tool scope preserves ordinary recovery tools',{timeout:10000},async()=>{
  const result=await runScenario('normal',{settings:{recoveryTools:'host'}});
  assert.equal(result.status.state,'COMPLETED',JSON.stringify(result.status));
  assert.equal(result.stats.record,1);
  assert.equal(result.status.compactCalls,1);
});

test('generic public API: user stop during compact cancels auxiliary stream and creates no child',{timeout:10000},async()=>{
  const result=await runScenario('user-stop');
  assert.equal(result.stopAccepted,true);assert.equal(result.status.state,'INTERRUPTED',JSON.stringify(result.status));
  assert.equal(result.stats.children.length,0);assert.equal(result.stats.record,0);
  assert.deepEqual(result.stats.requests.map(request=>request.kind),['parent','parent','compact']);
  assert.ok(result.stats.streams.find(stream=>stream.purpose==='compaction').aborted);
});

test('generic public API: a second provider and model recover with effort omitted throughout',{timeout:10000},async()=>{
  const result=await runScenario('compact',{routes:[routeB]});
  assert.equal(result.status.state,'COMPLETED',JSON.stringify(result.status));
  assert.equal(result.status.compactCalls,1);assert.equal(result.stats.record,1);
  assert.ok(result.stats.requests.every(request=>!Object.hasOwn(request.payload,'reasoningEffort')));
});

test('generic public API: simultaneous recovery keeps two provider/model/effort routes isolated',{timeout:10000},async()=>{
  const result=await runScenario('compact',{routes:[routeA,routeB]});
  assert.ok(result.statuses.every(status=>status.state==='COMPLETED'),JSON.stringify(result.statuses));
  assert.equal(result.stats.counter,2);assert.equal(result.stats.record,2);assert.equal(result.stats.children.length,0);
  for(const root of [0,1])assert.deepEqual(result.stats.requests.filter(request=>request.root===root).map(request=>request.kind),
    ['parent','parent','compact','resume','resume']);
  assert.ok(result.allParentEvents.every(log=>endOf(log)?.kind==='completed'));
});

test('generic public API: recovery follows the effective request route after host routing',{timeout:10000},async()=>{
  const result=await runScenario('compact',{routes:[routeB],initialRoute:routeA});
  assert.equal(result.status.state,'COMPLETED',JSON.stringify(result.status));
  assert.equal(result.stats.requests.length,5);
  assert.ok(result.stats.requests.every(request=>request.payload.provider===routeB.provider&&request.payload.model===routeB.model));
});

for(const scenario of ['normal-answer','observable-loop'])test(`generic public API: observe ${scenario} completes without cancellation`,{timeout:10000},async()=>{
  const result=await runScenario(scenario,{routes:[routeB],settings:{mode:'observe'},plain:true});
  assert.equal(result.status?.state,scenario==='observable-loop'?'OBSERVED':undefined);
});

for(const filter of [{provider:'unrelated-provider'},{model:'unrelated-model'}])test(
  `generic public API: explicit ${Object.keys(filter)[0]} filter leaves other routes unchanged`,{timeout:10000},async()=>{
    const result=await runScenario('filtered-loop',{routes:[routeA],settings:filter,plain:true});
    assert.equal(result.status,undefined);
  });

test('generic public API: explicit matching provider/model retains automatic recovery',{timeout:10000},async()=>{
  const result=await runScenario('normal',{settings:{provider:routeA.provider,model:routeA.model}});
  assert.equal(result.status.state,'COMPLETED',JSON.stringify(result.status));
});

test('generic public API: uncooperative adapter cannot trigger compact or another generation',{timeout:10000},async()=>{
  const started=performance.now();
  const result=await runScenario('ignores-abort');
  assert.equal(result.status.state,'BLOCKED',JSON.stringify(result.status));
  assert.equal(result.status.reason,'STREAM_CLEANUP_UNSETTLED');
  assert.equal(result.stats.children.length,0);assert.equal(result.stats.record,0);
  assert.deepEqual(result.stats.requests.map(request=>request.kind),['parent','parent']);
  assert.ok(performance.now()-started<5000,'local stop and refusal to recover remain bounded');
});
