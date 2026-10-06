import fs from 'node:fs';
import vm from 'node:vm';
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const noop = () => {};
export function backgroundHarness({db, fetchImpl, beforeSet} = {}) {
  db ||= {apiBaseUrl:'https://audit.invalid',userId:'alice',apiKey:'fake'};
  const timers = new Map(), registered = {}, messages = [];
  let timerId = 0;
  const storage = {
    get: async keys => Object.fromEntries(keys.filter(k => k in db).map(k => [k,structuredClone(db[k])])),
    set: async changes => { await beforeSet?.(changes); Object.assign(db,structuredClone(changes)); },
    remove: async keys => { for (const key of keys) delete db[key]; },
  };
  const context = vm.createContext({console:{info:noop,warn:noop,error:noop}, URL,AbortController,Date:class extends Date {},structuredClone,
    setTimeout:(fn,ms) => {const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    fetch:fetchImpl || (async()=>{throw Error('offline');}),
    chrome:{storage:{local:storage},action:{setBadgeText:noop,setBadgeBackgroundColor:noop},
      runtime:{id:'extension-id',getURL:p=>`chrome-extension://extension-id/${p}`,sendMessage:(m,cb)=>{messages.push(m);cb?.();},
        onMessage:{addListener:fn=>registered.message=fn},onInstalled:{addListener:noop},onStartup:{addListener:noop}},
      alarms:{create:noop,get:(_n,cb)=>cb({}),onAlarm:{addListener:fn=>registered.alarm=fn}},
      tabs:{query:async()=>[{id:17}],get:async()=>({id:17,url:'https://x.com/i/bookmarks',status:'complete'}),
        sendMessage:async(_id,m)=>{messages.push(m);return {ok:true,links:[]};},create:async()=>({id:17}),remove:async()=>{},
        onRemoved:{addListener:fn=>registered.removed=fn},onUpdated:{addListener:noop,removeListener:noop}}}
  });
  context.importScripts = path => vm.runInContext(read(`extension/${path}`),context);
  vm.runInContext(read('extension/background.js').replace(/bootstrapQueue\("top_level"\);\s*$/,''),context);
  const run = code => vm.runInContext(code,context);
  run('scheduleFlushQueue = () => {};');
  const message = (m,sender={id:'extension-id',url:'chrome-extension://extension-id/popup.html'}) => new Promise(resolve=>registered.message(m,sender,response=>resolve(structuredClone(response))));
  return {db,context,run,timers,registered,messages,storage,message};
}
export function contentHarness() {
  const events=[], messages=[], handlers=new Map();
  const window={location:{hostname:'x.com',pathname:'/i/bookmarks',href:'https://x.com/i/bookmarks'},
    dispatchEvent:e=>{events.push(e);handlers.get(e.type)?.(e);},addEventListener:(n,fn)=>handlers.set(n,fn),
    scrollY:0,innerHeight:800,scrollBy:noop,scrollTo:noop,setTimeout:()=>1,clearTimeout:noop,setInterval:noop};
  const context=vm.createContext({window,document:{title:'Bookmarks',querySelectorAll:()=>[],body:{scrollHeight:800},documentElement:{scrollHeight:800},addEventListener:noop,removeEventListener:noop},
    CustomEvent:class {constructor(type,opts={}){this.type=type;this.detail=opts.detail;}},
    console:{info:noop,warn:noop},URL,Date:class extends Date {},Node:{ELEMENT_NODE:1,TEXT_NODE:3},setTimeout,clearTimeout,
    chrome:{runtime:{lastError:undefined,onMessage:{addListener:fn=>handlers.set('runtime',fn)},getURL:p=>p,sendMessage:(m,cb)=>{messages.push(m);cb?.({ok:true});}}}});
  const src=read('extension/content.js');
  vm.runInContext(src.slice(0,src.lastIndexOf('\nensurePageBridgeInjected();')),context);
  const run=code=>vm.runInContext(code,context);
  run('sleep = async () => {}; showRuntimeNotice = () => {};');
  return {context,run,events,messages,handlers};
}
export async function bridgeHarness(payload,{url='https://x.com/i/api/graphql/hash/Bookmarks'}={}) {
  const h=contentHarness();
  function XHR(){};XHR.prototype.open=noop;XHR.prototype.send=noop;
  h.context.XMLHttpRequest=XHR;
  h.context.window.fetch=async requestUrl=>({url:requestUrl,clone:()=>({text:async()=>typeof payload==='string'?payload:JSON.stringify(payload)})});
  vm.runInContext(read('extension/page-bridge.js'),h.context);
  await h.context.window.fetch(url);
  await new Promise(setImmediate);
  return {...h,entries:h.events.flatMap(e=>e.detail?.entries || [])};
}
export const tick=()=>new Promise(setImmediate);
