// Loaded by the native host at document start in the trusted Studio page only.
// Game previews have neither this script nor its native message handler.
(() => {
  'use strict';
  const allowed = new Set(['hello','project.list','project.read','project.patch','project.search','session.create','session.list','session.get','session.input','session.cancel','session.close','provider.list','provider.use','provider.add','provider.remove','provider.configure','provider.enable','provider.disable','model.list','model.use','model.info','auth.list','auth.request','auth.logout','game.run','game.stop','game.preview']);
  const pending = new Map(), subscriptions = new Map();
  const error = code => Object.assign(new Error(code), {code});
  const opaque = prefix => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return prefix + Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
  };
  const send = value => {
    const message = JSON.stringify(value);
    if(new TextEncoder().encode(message).length>65536)throw error('BODY_TOO_LARGE');
    if(window.webkit?.messageHandlers?.zuku)window.webkit.messageHandlers.zuku.postMessage(message);
    else if(window.chrome?.webview?.postMessage)window.chrome.webview.postMessage(message);
    else throw error('BRIDGE_UNAVAILABLE');
  };
  function call(method,params={}){
    if(pending.size>=128)return Promise.reject(error('REQUEST_LIMIT'));
    const id=opaque('ui_');
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(error('CORE_TIMEOUT'));},30000);
      pending.set(id,{resolve,reject,timer});
      try{send({protocolVersion:1,id,method,params});}
      catch(reason){clearTimeout(timer);pending.delete(id);reject(reason);}
    });
  }
  const receive = value => {
    if(typeof value==='string'){try{value=JSON.parse(value);}catch{return;}}
    if(!value||value.protocolVersion!==1)return;
    if(typeof value.id==='string'){
      const waiter=pending.get(value.id);if(!waiter)return;
      clearTimeout(waiter.timer);pending.delete(value.id);
      if(value.error)waiter.reject(error(/^[A-Z][A-Z0-9_]{0,63}$/.test(value.error.code??'')?value.error.code:'CORE_OPERATION_FAILED'));
      else waiter.resolve(value.result);
    }else if(value.type==='native.subscription'){
      const sub=subscriptions.get(value.data?.subscriptionId);if(sub)sub(value.data.event??value.data.status);
    }
  };
  Object.defineProperty(window,'ZukuStudioReceive',{value:receive,writable:false,configurable:false});
  if(window.chrome?.webview?.addEventListener)window.chrome.webview.addEventListener('message',event=>receive(event.data));
  const bridge=Object.freeze({
    call(method,params){if(!allowed.has(method))return Promise.reject(error('METHOD_NOT_ALLOWED'));return call(method,params);},
    subscribe({sessionId,afterSequence},callback){
      if(typeof callback!=='function'||subscriptions.size>=16)throw error('REQUEST_LIMIT');
      const subscriptionId=opaque('sub_');let active=true;
      subscriptions.set(subscriptionId,callback);
      void call('native.subscribe',{subscriptionId,sessionId,afterSequence}).catch(reason=>{if(active)callback({kind:'status',state:'closed',code:reason.code});});
      return()=>{if(!active)return;active=false;subscriptions.delete(subscriptionId);void call('native.unsubscribe',{subscriptionId}).catch(()=>{});};
    },
    pickProject:()=>call('native.pickProject',{}),
    showPreview({previewHandle,rect}){
      const bounds={};for(const name of ['x','y','width','height']){const value=rect?.[name];if(typeof value!=='number'||!Number.isFinite(value))return Promise.reject(error('INVALID_INPUT'));bounds[name]=Math.round(value);}
      return call('native.previewShow',{previewHandle,rect:bounds});
    },
    hidePreview:()=>call('native.previewHide',{}),
  });
  Object.defineProperty(window,'zukuStudio',{value:bridge,writable:false,configurable:false});
  window.addEventListener('pagehide',()=>{
    for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(error('CORE_CLOSED'));}pending.clear();
    for(const subscriptionId of subscriptions.keys()){try{send({protocolVersion:1,id:opaque('detach_'),method:'native.unsubscribe',params:{subscriptionId}});}catch{}}
    subscriptions.clear();
  },{once:true});
})();
