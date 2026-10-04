import { randomBytes } from 'node:crypto';
import { ProtocolError, validateRequest, validateEvent, safeError } from '../agent-protocol/schema.mjs';
const id = () => `rpc_${randomBytes(16).toString('hex')}`;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
const unwrap = envelope => { if (envelope.error) throw failure(safeError(envelope.error).code, 409); return envelope.result; };
const exact = (value, keys) => { if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) throw failure('INVALID_INPUT'); };
const cursor = value => { if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value ?? '0') || !Number.isSafeInteger(Number(value ?? 0))) throw failure('INVALID_CURSOR'); return Number(value ?? 0); };

/** Transport projection only: all sessions, runs and event sequences belong to Core. */
export function createCoreTransport({ host, shutdown, clock, authenticateAgain, streams, limits }) {
  async function call(token, method, params, requestId) {
    authenticateAgain(token);
    const envelope = validateRequest({ protocolVersion: 1, id: requestId ?? id(), method, params });
    const actor = { kind: 'browser', id: token.key, origin: token.origin, projectHandles: [...token.projectHandles] };
    authenticateAgain(token);
    return host.dispatchCore(envelope, actor, { signal: shutdown.signal, authorize: () => authenticateAgain(token) });
  }
  async function stream(req, res, token, sessionId, after, headers, legacy) {
    if ([...streams].filter(value => value.sessionId === sessionId).length >= limits.streamsPerSession) throw failure('STREAM_LIMIT',429);
    const snap = unwrap(await call(token,'session.get',{sessionId}));
    if (after > snap.sequence) throw failure('INVALID_CURSOR');
    if (after < snap.minimumSequence - 1) throw failure('CURSOR_EXPIRED',410);
    const aborter = new AbortController(), signal = AbortSignal.any([aborter.signal,shutdown.signal]);
    const expires = setTimeout(() => aborter.abort(), Math.max(1,token.expiresAt-clock()));
    const onClose = () => aborter.abort(); res.once('close',onClose);
    const actor = { kind: 'browser', id: token.key, origin: token.origin, projectHandles: [...token.projectHandles] };
    if ([...streams].filter(value => value.sessionId === sessionId).length >= limits.streamsPerSession) throw failure('STREAM_LIMIT',429);
    authenticateAgain(token);
    const registration = {owner:token.key,sessionId,close(){aborter.abort();res.end();}};
    streams.add(registration);
    const events = host.subscribeCore({sessionId,afterSequence:after,signal},actor);
    res.writeHead(200,{...headers,'Content-Type':'application/x-ndjson; charset=utf-8','X-Zuku-Protocol':'1'});res.flushHeaders();
    try {
      for await (const raw of events) {
        authenticateAgain(token);if(signal.aborted||res.destroyed)break;
        const event=validateEvent(raw);
        const value=legacy?{...event,seq:event.sequence}:event;
        if(!res.write(JSON.stringify(value)+'\n'))await new Promise((resolve,reject)=>{
          let timer;const cleanup=()=>{clearTimeout(timer);res.off('drain',done);signal.removeEventListener('abort',cancel);};
          const done=()=>{cleanup();resolve();};const cancel=()=>{cleanup();reject(failure('COMMAND_CANCELLED'));};
          res.once('drain',done);signal.addEventListener('abort',cancel,{once:true});timer=setTimeout(()=>{cleanup();reject(failure('SLOW_SUBSCRIBER'));},5000);
          if(signal.aborted)cancel();
        });
      }
    } finally {streams.delete(registration);clearTimeout(expires);res.off('close',onClose);aborter.abort();await events.return?.();res.end();}
  }
  return Object.freeze({async handle({req,res,url,token,readBody,json,headers}){
    const path=url.pathname;
    if(path==='/v1/rpc'&&req.method==='POST'){
      if(url.search)throw failure('INVALID_INPUT');
      const envelope=validateRequest(await readBody(req));authenticateAgain(token);
      json(res,200,await call(token,envelope.method,envelope.params,envelope.id),token.origin);return true;
    }
    if(path==='/v1/projects'&&req.method==='GET'){
      if(url.search)throw failure('INVALID_INPUT');
      const value=unwrap(await call(token,'project.list',{}));json(res,200,value,token.origin);return true;
    }
    if(path==='/v1/sessions'&&req.method==='GET'){
      if(url.search)throw failure('INVALID_INPUT');json(res,200,unwrap(await call(token,'session.list',{})),token.origin);return true;
    }
    if(path==='/v1/sessions'&&req.method==='POST'){
      if(url.search)throw failure('INVALID_INPUT');const value=await readBody(req);exact(value,['projectId','providerId','modelId']);
      const modelAddress=value.providerId&&value.modelId?`${value.providerId}/${value.modelId}`:undefined;
      const result=unwrap(await call(token,'session.create',{projectHandle:value.projectId,...modelAddress?{modelAddress}:{}}));
      json(res,200,{...result,id:result.sessionId??result.id},token.origin);return true;
    }
    const match=/^\/v1\/sessions\/([A-Za-z0-9_-]{1,128})(?:\/(input|events|cancel|resume))?$/.exec(path);
    if(!match)return false;
    const sessionId=match[1],operation=match[2];
    if(operation==='events'&&req.method==='GET'){
      const keys=[...url.searchParams.keys()];if(keys.length>1||keys.some(k=>!['after','afterSequence'].includes(k)))throw failure('INVALID_CURSOR');
      const legacy=url.searchParams.has('after');await stream(req,res,token,sessionId,cursor(url.searchParams.get(legacy?'after':'afterSequence')),headers(token.origin),legacy);return true;
    }
    if(url.search)throw failure('INVALID_INPUT');
    if(!operation&&req.method==='GET'){json(res,200,unwrap(await call(token,'session.get',{sessionId})),token.origin);return true;}
    if(!operation&&req.method==='DELETE'){json(res,200,unwrap(await call(token,'session.close',{sessionId})),token.origin);return true;}
    if(operation==='cancel'&&req.method==='POST'){exact(await readBody(req),[]);json(res,200,unwrap(await call(token,'session.cancel',{sessionId})),token.origin);return true;}
    if(operation==='input'&&req.method==='POST'){
      const value=await readBody(req);exact(value,['inputId','prompt','experimental','operation','name']);
      const projects=unwrap(await call(token,'project.list',{}));const snap=unwrap(await call(token,'session.get',{sessionId}));
      const project=projects.projects.find(p=>p.projectHandle===snap.projectHandle);
      const operation=value.operation??(project?.classification==='unknown'?'game.init':'game.maintain');
      const result=unwrap(await call(token,'session.input',{sessionId,requestId:value.inputId,request:value.prompt,experimental:value.experimental,operation,...value.name?{name:value.name}:{}}));
      json(res,202,{...result,status:'accepted',inputId:value.inputId},token.origin);return true;
    }
    if(operation==='resume'&&req.method==='POST'){
      const value=await readBody(req);exact(value,['projectId']);const snap=unwrap(await call(token,'session.get',{sessionId}));
      if(value.projectId!==snap.projectHandle)throw failure('PERMISSION_REQUIRED',403);
      if(typeof host.approveResumeCore!=='function'||await host.approveResumeCore({sessionId,projectId:value.projectId,origin:token.origin,signal:shutdown.signal})!==true)throw failure('PERMISSION_REQUIRED',403);
      authenticateAgain(token);json(res,200,snap,token.origin);return true;
    }
    throw failure('METHOD_NOT_ALLOWED',405);
  }});
}
