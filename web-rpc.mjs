// Public exact Fetch routes share the host's existing authenticated /api
// transport. They do not occupy its single RPC interceptor or replace routes.
export function registerGuardRpc(ctx,handler){
  const offs=[];
  try{
    for(const endpoint of ['research-guard/status','research-guard/stop']){
      offs.push(ctx.connection.fetch.register({path:`/api/${endpoint}`,methods:['POST'],requestBody:'buffered',
        fetch:async request=>{
          if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return new Response('JSON required',{status:415});
          const text=await request.text();if(text.length>8192)return new Response('Too large',{status:413});
          let message;try{message=JSON.parse(text)}catch{return new Response('Invalid JSON',{status:400})}
          if(message?.type!=='client-request'||typeof message.rpcId!=='string'||!message.rpcId||message.rpcId.length>256||message.method!==endpoint)
            return new Response('Invalid envelope',{status:400});
          let result;try{result=await handler(endpoint,message.payload,request.signal)}catch{
            result={ok:false,error:{code:'gateway/internal',message:'Guard status unavailable',details:{}}};
          }
          return Response.json({type:'server-response',rpcId:message.rpcId,result});
        }}));
    }
  }catch(error){for(const off of offs)void off();throw error}
  return async()=>{for(const off of offs.reverse())await off()};
}
