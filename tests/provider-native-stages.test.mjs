// Real local HTTP transport of the frozen native contract; no vendor/live inference.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createAdapter,listBuiltinDescriptors} from '../lib/provider-system/adapters/index.mjs';
import {NATIVE_CONTRACT,NATIVE_CONTRACT_SHA,NATIVE_PACK_SHA} from '../lib/provider-system/adapters/zuku-stage.mjs';
import {STAGES,stageInstructions} from '../lib/agent/stages.mjs';
import {PLAN,SKILLS} from './agent-fixtures.test.mjs';
const token=`zuku_oa_${'b'.repeat(64)}`;
const makeRequest=(overrides={})=>({stage:'design',model:'auto',runId:'run_20261004010000_abcdef01',requestId:'b8b56eaf-4f34-43b6-988a-ce7d7f311ff2',instructions:stageInstructions('design',SKILLS.get(STAGES.design.skill)),input:{request:'Create a Canvas puzzle game'},outputSchema:STAGES.design.schema,maxOutputBytes:60000,...overrides});
function receipt(body,status='completed',extra={}) {return {success:true,data:{provider:'zuku',experimental:false,unofficial:false,contract_version:NATIVE_CONTRACT,contract_sha256:NATIVE_CONTRACT_SHA,skill_pack_sha256:NATIVE_PACK_SHA,request_id:body.request_id,run_id:body.run_id,stage:body.stage,model:'zuku/game-coder',status,output:status==='completed'?PLAN:null,usage:status==='completed'?{input_tokens:12,output_tokens:8,total_tokens:20}:null,result_expired:false,billing:{pool:'aist',unit:'tokens',paid_checkout:false},...extra}};}
async function fixture(t,handler) {
 const requests=[];const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):undefined;const call={method:req.method,url:req.url,body,headers:req.headers};requests.push(call);await handler(call,res);});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 let credentialReads=0;const client=createAdapter(listBuiltinDescriptors().find(p=>p.id==='zuku'),{testOrigin:`http://127.0.0.1:${server.address().port}`,getCredentials:async()=>{credentialReads++;return{kind:'bearer',accessToken:token};}});
 return{client,requests,reads:()=>credentialReads};
}
const json=(res,status,body)=>res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(body));
test('native finite request sends one OAuth POST and validates actual output/usage/skills',async t=>{
 const f=await fixture(t,(call,res)=>json(res,200,receipt(call.body)));const output=await f.client.runStage(makeRequest());
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'/api/v1/oauth/game-agent/stages');assert.equal(f.requests[0].headers.authorization,`Bearer ${token}`);
 assert.deepEqual(Object.keys(f.requests[0].body).sort(),['contract_version','input','model','request_id','run_id','skill_pack_sha256','stage']);
 assert.deepEqual(output.output,PLAN);assert.deepEqual(output.usage,{inputTokens:12,outputTokens:8,totalTokens:20});assert.equal(output.experimental,false);
});
test('lost native POST reads its original UUID and never submits another inference',async t=>{
 let admitted;const f=await fixture(t,(call,res)=>{if(call.method==='POST'){admitted=call.body;res.destroy();}else json(res,200,receipt(admitted));});
 const output=await f.client.runStage(makeRequest());assert.equal(output.stage,'design');assert.deepEqual(f.requests.map(r=>r.method),['POST','GET']);assert.equal(f.requests[1].url,`/api/v1/oauth/game-agent/stages/${admitted.request_id}`);
});
test('processing or uncertain receipts retain the same request UUID, with no retry',async t=>{
 for(const status of ['processing','uncertain']){const f=await fixture(t,(call,res)=>json(res,202,receipt(call.body,status)));
 await assert.rejects(f.client.runStage(makeRequest()),e=>e.code===(status==='processing'?'NATIVE_STAGE_PROCESSING':'NATIVE_OUTCOME_UNCERTAIN')&&e.requestId===makeRequest().requestId);assert.equal(f.requests.length,1);}
});
test('invalid contract/input, oversized context and pre-cancelled request dispatch zero calls',async t=>{
 const f=await fixture(t,()=>assert.fail('must not dispatch'));const aborted=AbortSignal.abort();
 for(const request of [makeRequest({requestId:'invalid'}),makeRequest({instructions:'arbitrary shell prompt'}),makeRequest({input:{request:'x'.repeat(30000)}}),makeRequest({input:{request:'Create game',tools:['shell']}}),makeRequest({signal:aborted})])await assert.rejects(f.client.runStage(request));
 assert.equal(f.requests.length,0);assert.equal(f.reads(),0);
});
test('failed, expired and forged skill receipts never become successful artifacts',async t=>{
 const cases=[['NATIVE_STAGE_FAILED',{status:'failed',output:null}],['NATIVE_RESULT_EXPIRED',{result_expired:true,output:null}],['STAGE_OUTPUT_INVALID',{output:{...PLAN,skill_receipt:{...PLAN.skill_receipt,sha256:'0'.repeat(64)}}}]];
 for(const[code,extra]of cases){const f=await fixture(t,(call,res)=>json(res,200,receipt(call.body,'completed',extra)));await assert.rejects(f.client.runStage(makeRequest()),e=>e.code===code&&e.requestId===makeRequest().requestId);assert.equal(f.requests.length,1);}
});
test('definitive OAuth refusal does not invoke status GET or inference fallback',async t=>{
 const f=await fixture(t,(_call,res)=>json(res,401,{success:false,error:{message:token}}));await assert.rejects(f.client.runStage(makeRequest()),e=>e.code==='PROVIDER_AUTH_FAILED'&&!String(e.stack).includes(token));assert.deepEqual(f.requests.map(r=>r.method),['POST']);
});
test('unavailable catalog does not fabricate an Auto model',async t=>{
 const f=await fixture(t,(_call,res)=>json(res,200,{success:true,data:{provider:'zuku',contract_version:NATIVE_CONTRACT,contract_sha256:NATIVE_CONTRACT_SHA,skill_pack_sha256:NATIVE_PACK_SHA,billing:{pool:'aist',paid_checkout:false},models:[{id:'zuku/game-coder',available:false}],default_model:'auto'}}));assert.deepEqual(await f.client.listModels(),[]);
});
