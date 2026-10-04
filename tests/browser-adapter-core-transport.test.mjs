// Actual HTTP transport; callbacks are explicit fixtures of the protected Core API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createBrowserAdapter} from '../lib/browser-adapter/server.mjs';
const origin='https://ai.zuzunza.com';
const timeout=ms=>new Promise((_,reject)=>setTimeout(()=>reject(new Error('TEST_TIMEOUT')),ms));
async function paired(t,dispatch) {
 let detached=0,cancelled=0,started=0;
 const adapter=await createBrowserAdapter({port:0,approvePairing:async()=>true,host:{
  getHealth:async()=>({cliVersion:'0.3.0',studioVersion:'0.3.0',agentVersion:'0.3.0',status:'ready'}),getProjects:async()=>[{id:'project_fixture',name:'Approved game'}],getProviders:async()=>({defaultProvider:'zuku',defaultModel:'zuku/auto',providers:[]}),getModels:async()=>[],
  dispatchCore:async request=>{if(request.method==='session.cancel')cancelled++;return dispatch?.(request)??{protocolVersion:1,id:request.id,result:{id:'session_fixture',state:'running',sequence:0,minimumSequence:1,projectHandle:'project_fixture'}};},
  async *subscribeCore({signal}){started++;try{await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve();});}finally{detached++;}},
 }});t.after(()=>adapter.close());
 let token;
 const request=async(path,{method='GET',body,auth=true}={})=>fetch(adapter.origin+path,{method,headers:{Origin:origin,'X-Zuku-Protocol':'1','X-Zuku-Request-Id':randomBytes(16).toString('hex'),...(auth?{Authorization:`Bearer ${token}`}:{ }),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const nonce=randomBytes(32).toString('hex');const challenge=await(await request('/v1/pair/challenge',{method:'POST',auth:false,body:{browserNonce:nonce}})).json();
 for(let i=0;i<10;i++){const response=await request('/v1/pair/confirm',{method:'POST',auth:false,body:{browserNonce:nonce,challengeId:challenge.challengeId}});const value=await response.json();if(response.ok){token=value.token;break;}assert.equal(value.code,'PAIRING_PENDING');}
 assert.ok(token);return{request,started:()=>started,detached:()=>detached,cancelled:()=>cancelled};
}
test('revoking a quiet Core subscription closes it immediately without cancelling the game',async t=>{
 const f=await paired(t);const response=await f.request('/v1/sessions/session_fixture/events?afterSequence=0');assert.equal(response.status,200);const reading=response.body.getReader().read();
 assert.equal((await f.request('/v1/pair/revoke',{method:'POST',body:{}})).status,200);
 assert.equal((await Promise.race([reading,timeout(1000)])).done,true);assert.equal(f.detached(),1);assert.equal(f.cancelled(),0);
});
test('Core streams share the bounded stream quota and detach without task authority',async t=>{
 const f=await paired(t);const a=await f.request('/v1/sessions/session_fixture/events?afterSequence=0'),b=await f.request('/v1/sessions/session_fixture/events?afterSequence=0');
 const c=await f.request('/v1/sessions/session_fixture/events?afterSequence=0');assert.equal(c.status,429);assert.equal((await c.json()).code,'STREAM_LIMIT');assert.equal(f.started(),2);
 await a.body.cancel();await b.body.cancel();assert.equal(f.cancelled(),0);
});
test('untrusted callback errors cannot disclose arbitrary uppercase secret codes or messages',async t=>{
 const f=await paired(t,()=>{throw Object.assign(new Error('private_text'),{code:'PRIVATE_SECRET_VALUE',status:418});});
 const response=await f.request('/v1/rpc',{method:'POST',body:{protocolVersion:1,id:'rpc_error_fixture',method:'session.list',params:{}}});const value=await response.json();
 assert.equal(response.status,500);assert.equal(value.code,'ADAPTER_FAILED');assert.ok(!JSON.stringify(value).includes('PRIVATE_SECRET_VALUE'));assert.ok(!JSON.stringify(value).includes('private_text'));
});
