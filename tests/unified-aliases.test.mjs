import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,symlink,rm} from 'node:fs/promises';
import{join,dirname,resolve}from'node:path';
import{tmpdir}from'node:os';
import{fileURLToPath}from'node:url';
import{spawnSync}from'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
test('both first-class package commands point to the existing single entrypoint',async()=>{
 const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
 assert.equal(pkg.bin.zukujs,'./index.mjs');assert.equal(pkg.bin.zuku,pkg.bin.zukujs);assert.equal(resolve(root,lock.packages[''].bin.zuku),resolve(root,pkg.bin.zuku));
});
test('real invocation through both aliases keeps protocol, help and offline state identical',async()=>{
 const home=await mkdtemp(join(tmpdir(),'zuku-alias-'));try{
  for(const alias of ['zuku','zukujs'])await symlink(join(root,'index.mjs'),join(home,alias));
  for(const args of [['--help'],['system.version','--json'],['status','--json']]){
   const system=process.platform==='win32'?Object.fromEntries(['SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'].filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]])):{};
   const invoke=alias=>spawnSync(process.execPath,[join(home,alias),...args],{encoding:'utf8',timeout:10000,env:{...system,HOME:home,USERPROFILE:home,LOCALAPPDATA:join(home,'app-data'),PATH:dirname(process.execPath),TERM:'dumb',NO_COLOR:'1'}});
   const a=invoke('zuku'),b=invoke('zukujs');
   const diagnostic=(alias,result)=>JSON.stringify({alias,args,signal:result.signal,errorCode:result.error?.code,stdoutBytes:Buffer.byteLength(result.stdout??''),stderrBytes:Buffer.byteLength(result.stderr??'')});
   assert.equal(a.status,0,diagnostic('zuku',a));assert.equal(b.status,0,diagnostic('zukujs',b));assert.equal(a.stdout,b.stdout);assert.equal(a.stderr,b.stderr);
  }
 }finally{await rm(home,{recursive:true,force:true});}
});
