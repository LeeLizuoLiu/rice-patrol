import test from 'node:test';
import assert from 'node:assert/strict';
import {registerGuardRpc} from '../web-rpc.mjs';

function setup(handler){
  const routes=new Map();
  const off=registerGuardRpc({connection:{fetch:{register(route){
    assert.deepEqual(route.methods,['POST']);assert.equal(route.requestBody,'buffered');
    assert.ok(!routes.has(route.path));routes.set(route.path,route.fetch);return ()=>routes.delete(route.path);
  }}}},handler);
  const request=(body,{path='/api/research-guard/status',contentType='application/json'}={})=>routes.get(path)(
    new Request(`http://127.0.0.1${path}`,{method:'POST',headers:{'content-type':contentType},body}));
  return {routes,off,request};
}
const envelope=payload=>JSON.stringify({type:'client-request',rpcId:'synthetic-rpc',method:'research-guard/status',payload});

test('guard routes reject malformed, mismatched and oversized inputs before invoking their handler',async()=>{
  let calls=0;const fixture=setup(async()=>{calls++;return {ok:true,value:null}});
  try{
    assert.equal(fixture.routes.size,3);
    assert.equal((await fixture.request('{')).status,400);
    assert.equal((await fixture.request('x'.repeat(8193))).status,413);
    assert.equal((await fixture.request(envelope({}),{contentType:'text/plain'})).status,415);
    assert.equal((await fixture.request(envelope({}),{path:'/api/research-guard/stop'})).status,400);
    assert.equal((await fixture.request(envelope({}),{path:'/api/research-guard/dismiss'})).status,400);
    assert.equal((await fixture.request(JSON.stringify({type:'server-response',rpcId:'a',method:'research-guard/status'}))).status,400);
    assert.equal(calls,0);
  }finally{await fixture.off()}
  assert.equal(fixture.routes.size,0);
});

test('valid RPC envelope preserves request identity while unexpected handler errors are sanitized',async()=>{
  const fixture=setup(async(endpoint,payload,signal)=>{
    assert.equal(endpoint,'research-guard/status');assert.ok(signal instanceof AbortSignal);
    if(payload.fail)throw Error('PRIVATE_INTERNAL_DETAIL');
    return {ok:true,value:{echo:payload.sessionId}};
  });
  try{
    const success=await (await fixture.request(envelope({sessionId:'synthetic'}))).json();
    assert.deepEqual(success,{type:'server-response',rpcId:'synthetic-rpc',result:{ok:true,value:{echo:'synthetic'}}});
    const failed=await (await fixture.request(envelope({fail:true}))).json();
    assert.equal(failed.result.error.code,'gateway/internal');assert.ok(!JSON.stringify(failed).includes('PRIVATE_INTERNAL_DETAIL'));
  }finally{await fixture.off()}
});
