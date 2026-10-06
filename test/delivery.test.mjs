import test from 'node:test';
import assert from 'node:assert/strict';
import {backgroundHarness as harness,tick} from './harness.mjs';
const enqueue = (h,id,extra='') => h.run(`enqueueBatch({requestId:'r-${id}',bookmarks:[{tweet_id:'${id}',text:'capture ${id}'}]${extra}})`);
const json = (payload,status=200) => ({ok:status>=200&&status<300,status,headers:{get:()=>null},json:async()=>payload});

test('concurrent startup and enqueues preserve every acknowledged capture after restart', async()=>{
  const h=harness();
  await Promise.all([h.run('loadQueueState()'),...Array.from({length:25},(_,i)=>enqueue(h,i+1))]);
  assert.equal(h.db.delivery_state_v2.queue.length,25);
  const restarted=harness({db:h.db});await restarted.run('loadQueueState()');
  assert.equal(restarted.run('state.queue.length'),25);
});
test('legacy migration binds destination and never deletes original on failed journal write',async()=>{
  const db={apiBaseUrl:'https://old.invalid',userId:'alice',ingest_queue_v1:[{id:'old',bookmarks:[{tweet_id:'1',text:'a'}]}],failed_queue_v1:[{id:'f',bookmarks:[{tweet_id:'2',text:'b'}]}]};
  let reject=true;const h=harness({db,beforeSet:()=>{if(reject)throw Error('quota');}});
  await assert.rejects(h.run('loadQueueState()'),/quota/);assert.equal(db.ingest_queue_v1.length,1);assert.equal(db.failed_queue_v1.length,1);
  reject=false;await h.run('loadQueueState()');assert.equal(db.ingest_queue_v1,undefined);
  assert.equal(db.delivery_state_v2.queue[0].userId,'alice');assert.equal(db.delivery_state_v2.failed.length,1);
});
test('enqueue rejection does not mutate memory or report acceptance',async()=>{
  let reject=false;const h=harness({beforeSet:()=>{if(reject)throw Error('quota');}});
  await enqueue(h,1);reject=true;await assert.rejects(enqueue(h,2),/quota/);
  assert.equal(h.run('state.queue.length'),1);assert.equal(h.db.delivery_state_v2.queue.length,1);
});
test('55 captures survive an outage without bounded dead-letter eviction',async()=>{
  const h=harness();for(let i=0;i<55;i++)await enqueue(h,i+1);
  await h.run('flushQueue()');assert.equal(h.db.delivery_state_v2.queue.length,55);assert.equal(h.db.delivery_state_v2.failed.length,0);
  assert.equal(h.run('state.counters.delivered'),0);
});
test('rejected atomic dead-letter write leaves the active capture recoverable',async()=>{
  let reject=false;const h=harness({fetchImpl:async()=>json({ok:false},401),beforeSet:()=>{if(reject)throw Error('quota');}});
  await enqueue(h,1);reject=true;await assert.rejects(h.run('flushQueue()'),/quota/);
  assert.equal(h.db.delivery_state_v2.queue.length,1);assert.equal(h.db.delivery_state_v2.failed.length,0);
});
test('partial acknowledgement confirms only committed IDs and retains rejected payloads',async()=>{
  const h=harness({fetchImpl:async()=>json({ok:true,stored_ids:['1'],invalid:[{tweet_id:'2',reason:'bad'}]})});
  await h.run(`enqueueBatch({requestId:'batch',bookmarks:[{tweet_id:'1',text:'good'},{tweet_id:'2',text:'bad'}]})`);
  await h.run('flushQueue()');assert.equal(h.run('state.counters.delivered'),1);assert.equal(h.db.delivery_state_v2.failed[0].bookmarks[0].tweet_id,'2');
  assert.equal(h.db.delivery_state_v2.receipts.batch.complete,false);
});
test('HTTP 200 without per-ID acknowledgement never counts delivery',async()=>{
  const h=harness({fetchImpl:async()=>json({ok:true,inserted:1})});await enqueue(h,1);await h.run('flushQueue()');
  assert.equal(h.run('state.counters.delivered'),0);assert.equal(h.db.delivery_state_v2.queue.length,1);
});
test('successful transport followed by local write failure replays safely after restart',async()=>{
  let reject=false;const response=async()=>json({ok:true,stored_ids:['1']});
  const h=harness({fetchImpl:response,beforeSet:()=>{if(reject)throw Error('quota');}});await enqueue(h,1);reject=true;
  await assert.rejects(h.run('flushQueue()'),/quota/);assert.equal(h.db.delivery_state_v2.queue.length,1);
  const restarted=harness({db:h.db,fetchImpl:response});await restarted.run('flushQueue()');assert.equal(h.db.delivery_state_v2.queue.length,0);
});
test('captured user is frozen and changed backend cannot redirect credentials',async()=>{
  const sent=[];const h=harness({fetchImpl:async(url,opts)=>{sent.push({url,body:JSON.parse(opts.body)});return json({ok:true,stored_ids:['1']});}});
  await enqueue(h,1);await h.run('updateSettings({userId:"bob"})');await h.run('flushQueue()');assert.equal(sent[0].body.user_id,'alice');
  await enqueue(h,2);await h.run('updateSettings({apiBaseUrl:"https://other.invalid"})');await h.run('flushQueue()');assert.equal(sent.length,1);
  assert.equal(h.db.delivery_state_v2.failed[0].apiBaseUrl,'https://audit.invalid');
});
test('scanner drafts and provenance survive restart, and jobs outlive popup response',async()=>{
  const h=harness();await h.run(`stageScannerDrafts([{tweet_id:'1',text:'full\\n\\ntext',capture:'network',entity_type:'Tweet'}],'["https://audit.invalid","alice"]')`);
  const result=await h.message({type:'START_BOOKMARK_IMPORT',payload:{tabId:17,range:{min:1,max:1}}});assert.equal(result.ok,true);await tick();
  assert.equal(h.messages.find(m=>m.type==='BOOKMARK_SCANNER_RUN_JOB').payload.id,result.jobId);
  const restarted=harness({db:h.db});const restored=await restarted.message({type:'BOOKMARK_SCANNER_RESTORE'});
  assert.equal(restored.items[0].capture,'network');assert.equal(restored.items[0].entity_type,'Tweet');assert.match(restored.items[0].text,/\n\n/);
  h.registered.removed(17);await tick();assert.equal(h.db.delivery_state_v2.jobs[result.jobId].phase,'interrupted');
});
test('same request is idempotent after all split chunks are delivered',async()=>{
  const h=harness({fetchImpl:async(_url,opts)=>json({ok:true,stored_ids:JSON.parse(opts.body).bookmarks.map(b=>b.tweet_id)})});
  h.context.input=Array.from({length:25},(_,i)=>({tweet_id:String(i+1),text:'capture'}));
  await h.run(`enqueueBatch({requestId:'split',bookmarks:input})`);await h.run('flushQueue()');
  await h.run(`enqueueBatch({requestId:'split',bookmarks:input})`);assert.equal(h.db.delivery_state_v2.queue.length,0);assert.equal(h.db.delivery_state_v2.receipts.split.ids.length,25);
});
test('body decoding remains under deadline even if abort is ignored',async()=>{
  const h=harness({fetchImpl:async()=>({ok:true,json:()=>new Promise(()=>{})})});
  const work=h.run('fetchJson("https://audit.invalid",{},20)');await tick();assert.equal(h.timers.size,1);
  [...h.timers.values()][0].fn();await assert.rejects(work,/request_timeout/);assert.equal(h.timers.size,0);
});
test('content script cannot read API key or update settings',async()=>{
  const h=harness();const sender={id:'extension-id',url:'https://x.com/i/bookmarks',tab:{id:17}};
  assert.equal((await h.message({type:'GET_SETTINGS'},sender)).apiKey,undefined);
  assert.equal((await h.message({type:'SETTINGS_UPDATE',payload:{userId:'bob'}},sender)).ok,false);assert.equal(h.db.userId,'alice');
});
test('staging and final enqueue reject a changed account namespace',async()=>{
  const h=harness();await h.run('updateSettings({userId:"bob"})');
  await assert.rejects(h.run(`stageScannerDrafts([{tweet_id:'1',text:'a'}],'["https://audit.invalid","alice"]')`),/settings_changed/);
  await assert.rejects(enqueue(h,1,`,namespace:'["https://audit.invalid","alice"]'`),/settings_changed/);
});
test('request ID cannot acknowledge different bookmarks after a restart',async()=>{
  const h=harness({fetchImpl:async()=>json({ok:true,stored_ids:['1']})});await enqueue(h,1);await h.run('flushQueue()');
  await assert.rejects(h.run(`enqueueBatch({requestId:'r-1',bookmarks:[{tweet_id:'2',text:'different'}]})`),/payload_mismatch/);
});
test('a richer draft staged during transport survives the older ACK and is sent afterward',async()=>{
  const bodies=[];let release;const firstResponse=new Promise(resolve=>release=resolve);
  const h=harness({fetchImpl:async(_url,opts)=>{const body=JSON.parse(opts.body);bodies.push(body);return bodies.length===1?firstResponse:json({ok:true,stored_ids:['1']});}});
  await h.run(`stageScannerDrafts([{tweet_id:'1',text:'short',capture:'dom'}],'["https://audit.invalid","alice"]')`);
  await h.run(`importBookmarkScannerPending([{tweet_id:'1',text:'short',capture:'dom'}])`);
  const flush=h.run('flushQueue()');await tick();
  await h.run(`stageScannerDrafts([{tweet_id:'1',text:'Full network content',capture:'network',entity_type:'Tweet'}],'["https://audit.invalid","alice"]')`);
  release(json({ok:true,imported_ids:['1'],duplicate_ids:[]}));await flush;
  assert.equal(bodies.length,2);assert.equal(bodies[1].bookmarks[0].text,'Full network content');assert.equal(h.db.delivery_state_v2.queue.length,0);
  const notices=h.messages.filter(m=>m.type==='DELIVERY_CONFIRMED');assert.ok(notices.slice(0,2).every(m=>m.payload.ids.length===0));
});
test('a richer capture arriving after confirmation creates an update rather than being discarded',async()=>{
  const h=harness({fetchImpl:async()=>json({ok:true,stored_ids:['1']})});await enqueue(h,1);await h.run('flushQueue()');
  await h.run(`stageScannerDrafts([{tweet_id:'1',text:'Complete network note',capture:'network',entity_type:'Tweet'}],'["https://audit.invalid","alice"]')`);
  assert.equal(h.db.delivery_state_v2.queue.length,1);assert.equal(h.db.delivery_state_v2.queue[0].kind,'capture_update');
});
test('discarding an unqueued draft is persistent and preserves accepted deliveries',async()=>{
  const h=harness();await h.run(`stageScannerDrafts([{tweet_id:'1',text:'a'},{tweet_id:'2',text:'b'}],'["https://audit.invalid","alice"]')`);await enqueue(h,2);
  const result=await h.message({type:'BOOKMARK_SCANNER_CLEAR_DRAFTS',payload:{namespace:'["https://audit.invalid","alice"]',ids:['1','2']}});assert.equal(result.ok,true);
  const restarted=harness({db:h.db});const restored=await restarted.message({type:'BOOKMARK_SCANNER_RESTORE'});assert.deepEqual(restored.items.map(i=>i.tweet_id),['2']);
});
test('immutable job selection rejects unstaged data and is reused after restart',async()=>{
  const h=harness();await h.run(`stageScannerDrafts([{tweet_id:'1',text:'a'},{tweet_id:'2',text:'b'}],'["https://audit.invalid","alice"]')`);
  const job=await h.run('startCaptureJob(17,{min:1,max:1})');const sender={id:'extension-id',tab:{id:17},url:'https://x.com/i/bookmarks'};
  const select=ids=>({type:'BOOKMARK_SCANNER_SELECT_JOB',payload:{jobId:job.jobId,namespace:'["https://audit.invalid","alice"]',ids}});
  assert.equal((await h.message(select(['9']),sender)).ok,false);assert.deepEqual((await h.message(select(['1']),sender)).ids,['1']);
  const restarted=harness({db:h.db});assert.deepEqual((await restarted.message(select(['2']),sender)).ids,['1']);
});
test('legacy relookup state cannot evict the new cursor and exhausted page advances',async()=>{
  const db={apiBaseUrl:'https://audit.invalid',userId:'alice',fcl_relookup_state_v1:Object.fromEntries(Array.from({length:500},(_,i)=>[String(i+1),{attempts:6,lastAt:1}]))};const offsets=[];
  const h=harness({db,fetchImpl:async url=>{const offset=Number(new URL(url).searchParams.get('offset'));offsets.push(offset);return json({ok:true,items:[],next_offset:offset+40});}});
  await h.run('runFirstCommentRelookupPass()');await h.run('runFirstCommentRelookupPass()');assert.deepEqual(offsets,[0,40]);assert.equal(db.fcl_relookup_state_v1.version,2);
});
test('uncertain commit plus richer retry uses merge endpoint instead of insert-only acknowledgement',async()=>{
  let persisted='',posts=0;const paths=[];const h=harness({fetchImpl:async(url,opts)=>{paths.push(new URL(url).pathname);const body=JSON.parse(opts.body);const text=body.bookmarks[0].text;if(text.length>persisted.length)persisted=text;posts++;if(posts===1)throw Error('lost response after commit');return json({ok:true,stored_ids:['1']});}});
  await h.run(`importBookmarkScannerPending([{tweet_id:'1',text:'short',capture:'dom'}])`);await h.run('flushQueue()');
  await h.run(`stageScannerDrafts([{tweet_id:'1',text:'Complete network content',capture:'network',entity_type:'Tweet'}],deliveryNamespace({apiBaseUrl:'https://audit.invalid',userId:'alice'}))`);
  await h.run('changeDelivery(draft=>{draft.queue[0].nextAttemptAt=0;})');await h.run('flushQueue()');
  assert.equal(persisted,'Complete network content');assert.deepEqual(paths,['/api/bookmarks/batch','/api/bookmarks/batch']);assert.equal(h.db.delivery_state_v2.queue.length,0);
});
test('upgrade preserves a user ID containing separator characters',async()=>{
  const sent=[];const h=harness({fetchImpl:async(_url,opts)=>{sent.push(JSON.parse(opts.body));return json({ok:true,stored_ids:['1']});}});
  await h.run('updateSettings({userId:"team|alice"})');await enqueue(h,1);await h.run('flushQueue()');
  await h.run(`stageScannerDrafts([{tweet_id:'1',text:'Complete network note',capture:'network',entity_type:'Tweet'}],deliveryNamespace({apiBaseUrl:'https://audit.invalid',userId:'team|alice'}))`);await h.run('flushQueue()');
  assert.equal(sent[1].user_id,'team|alice');
});
