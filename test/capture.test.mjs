import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {contentHarness,bridgeHarness} from './harness.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/bookmarks.json',import.meta.url)));
const timeline = entries => ({data:{bookmark_timeline_v2:{timeline:{instructions:[{type:'TimelineAddEntries',entries}]}}}});
const item = (id,tweet)=>({entryId:`tweet-${id}`,content:{itemContent:{tweet_results:{result:tweet}}}});
const tweet = (id,text='tweet')=>({__typename:'Tweet',rest_id:String(id),legacy:{full_text:text,entities:{urls:[]}},core:{user_results:{result:{__typename:'User',rest_id:'900',legacy:{screen_name:'alice',name:'Alice'}}}}});

test('only timeline members become bookmarks; User and quote cannot pollute IDs',async()=>{
  const h=await bridgeHarness(fixture);assert.deepEqual(Array.from(h.entries,e=>e.tweetId),['100']);assert.equal(h.entries[0].entityType,'Tweet');
});
test('visibility wrapper and module membership are supported without recursively importing context',async()=>{
  const h=await bridgeHarness(timeline([item(1,{__typename:'TweetWithVisibilityResults',tweet:tweet(1)}),{entryId:'module-2',content:{items:[{entryId:'module-tweet-2',item:{itemContent:{tweet_results:{result:tweet(2)}}}}]}}]));
  assert.deepEqual(Array.from(h.entries,e=>e.tweetId),['1','2']);
});
test('large pages emit all entries across bounded events',async()=>{
  const h=await bridgeHarness(timeline(Array.from({length:175},(_,i)=>item(i+1,tweet(i+1)))));
  assert.equal(h.entries.length,175);assert.ok(h.events.every(e=>e.detail.entries.length<=80));
});
test('note text preserves paragraphs and marks actual truncation',async()=>{
  const full='Header\n\n'+'Z'.repeat(4999);const t=tweet(1,'short');t.note_tweet={note_tweet_results:{result:{text:full}}};
  const h=await bridgeHarness(timeline([item(1,t),item(2,tweet(2,'X'.repeat(13000)))]));
  assert.equal(h.entries[0].text,full);assert.equal(h.entries[0].contentTruncated,false);assert.equal(h.entries[1].text.length,12000);assert.equal(h.entries[1].contentTruncated,true);
});
test('unsupported tweet shape cannot certify terminal page as healthy',async()=>{
  const payload=timeline([{entryId:'tweet-1',content:{itemContent:{tweet_result:{result:tweet(1)}}}}]);payload.data.bookmark_timeline_v2.timeline.instructions.push({type:'TimelineTerminateTimeline',direction:'Bottom'});
  const h=await bridgeHarness(payload);assert.equal(h.entries.length,0);assert.equal(h.events.at(-1).detail.health,'schema_unknown');
});
test('API and decode failures close pending request with a visible health state',async()=>{
  for(const [payload,health] of [[{errors:[{message:'rate limited'}]},'api_error'],['bad JSON','decode_error']]) {
    const h=await bridgeHarness(payload);assert.equal(h.events.at(-1).detail.health,health);assert.equal(h.events.at(-1).detail.pending,false);assert.ok(h.events.at(-1).detail.requestId);
  }
});
test('late network capture upgrades DOM and reclassifies unknown network-only items',()=>{
  const h=contentHarness();h.run(`bookmarkScannerState.pendingBookmarks.set('100',{tweet_id:'100',text:'short',capture:'dom'});bookmarkScannerState.networkEntries.set('100',{text:'FULL NETWORK TEXT'});scanVisibleBookmarkArticles();bookmarkScannerState.idsLoaded=true;scanVisibleBookmarkArticles();`);
  assert.equal(h.run(`bookmarkScannerState.pendingBookmarks.get('100').capture`),'network');assert.equal(h.run(`bookmarkScannerState.statusByTweetId.get('100')`),'pending');
});
test('reset dismissed entries recovers network-only captures',()=>{
  const h=contentHarness();h.run(`bookmarkScannerState.dismissedPendingIds.add('1');bookmarkScannerState.networkEntries.set('1',{text:'full'});scanVisibleBookmarkArticles({resetDismissed:true});`);
  assert.equal(h.run('bookmarkScannerState.pendingBookmarks.size'),1);
});
test('error state remains false after status fields are added',async()=>{
  const h=contentHarness();h.context.window.location.pathname='/home';assert.equal((await h.run('initializeBookmarkScanner()')).ok,false);
});
test('scroll does not exit on 700ms DOM quiet or claim complete without terminal evidence',async()=>{
  const h=contentHarness();let now=10000;h.context.clock={now:()=>now,advance:ms=>now+=ms};
  h.run(`Date.now=clock.now;sleep=async ms=>clock.advance(ms);initializeBookmarkScanner=async()=>getBookmarkScannerStatus();checkpointScannerDrafts=async()=>{};`);
  const result=await h.run('runBookmarkScannerScrollScan()');assert.ok(now>=16000);assert.equal(result.coverage,'partial');assert.ok(result.rounds>4);
});
test('confirmed terminal response can report complete; schema failure remains partial',async()=>{
  for(const health of ['ok','schema_unknown']){
    const h=contentHarness();h.run(`initializeBookmarkScanner=async()=>getBookmarkScannerStatus();checkpointScannerDrafts=async()=>{};bookmarkScannerState.terminal=true;bookmarkScannerState.bridgeHealth='${health}';`);
    const result=await h.run('runBookmarkScannerScrollScan()');assert.equal(result.coverage,health==='ok'?'complete':'partial');
  }
});
test('self reply requires the original author and verified parent',()=>{
  const h=contentHarness();h.run(`rememberNetworkReplyCandidate({tweetId:'2',inReplyToTweetId:'1',authorUsername:'mallory',links:['https://evil.invalid'],text:'repo below'});`);
  assert.equal(h.run(`getNetworkFirstCommentLinks({tweet_id:'1',author_username:'alice',text:'repo below'}).length`),0);
  h.run(`rememberNetworkReplyCandidate({tweetId:'3',inReplyToTweetId:'1',authorUsername:'alice',links:['https://github.com/alice/repo']});`);
  assert.equal(h.run(`getNetworkFirstCommentLinks({tweet_id:'1',author_username:'alice'}).length`),1);
});
test('ellipsis display URL cannot invent an expanded destination',()=>{
  const h=contentHarness();h.context.anchor={href:'https://t.co/abc',getAttribute:key=>key==='href'?'https://t.co/abc':null,textContent:'example.com/very/long…'};
  assert.equal(h.run('expandUrlFromAnchor(anchor)'),'https://t.co/abc');
});
test('dedupe records acceptance only after enqueue succeeds',()=>{
  const h=contentHarness();assert.equal(h.run(`dedupeCapture('1')`),true);assert.equal(h.run(`dedupeCapture('1')`),true);
  h.run(`recentCapturedAtByTweet.set('1',Date.now())`);assert.equal(h.run(`dedupeCapture('1')`),false);
});
test('auto capture rejects a recycled node and requires X bookmark confirmation',async()=>{
  for(const changed of [true,false]){
    const h=contentHarness();let identityReads=0;h.context.identity=()=>({tweetId:changed&&identityReads++>0?'2':'1',url:'https://x.com/alice/status/1',handle:'alice'});
    h.context.node={querySelector:()=>null};h.context.action={closest:()=>h.context.node};
    h.run(`findActionElement=()=>action;extractBookmarkScannerIdentity=identity;buildBookmarkScannerPendingItem=()=>({tweet_id:'1',text:'body',url:'https://x.com/alice/status/1'});sendRuntimeMessage=async()=>({ok:true,apiBaseUrl:'https://audit.invalid',userId:'alice'});`);
    await h.run('handleBookmarkSave({target:action},"click")');assert.equal(h.messages.filter(m=>m.type==='INGEST_ENQUEUE').length,0);assert.equal(h.run('capturesInFlight.size'),0);
  }
});
test('resumed import uses immutable selection even after early chunks leave pending map',async()=>{
  const h=contentHarness();const sent=[];h.context.send=async message=>{sent.push(message);return {ok:true};};
  h.run(`bookmarkScannerState.initialized=true;bookmarkScannerState.namespace='["https://audit.invalid","alice"]';checkpointScannerDrafts=async()=>{};sendRuntimeMessage=send;`);
  h.context.items=Array.from({length:120},(_,i)=>({tweet_id:String(i+1),text:'capture'}));
  h.run(`for(const item of items)bookmarkScannerState.pendingBookmarks.set(item.tweet_id,item);for(let id=1;id<=40;id++){bookmarkScannerState.pendingBookmarks.delete(String(id));bookmarkScannerState.savedIds.add(String(id));}`);
  h.context.selected=Array.from({length:80},(_,i)=>String(i+1));
  await h.run(`importBookmarkScannerPending({jobId:'job',rangeStart:1,rangeEnd:80,selectedIds:selected})`);
  const batches=sent.filter(m=>m.type==='BOOKMARK_SCANNER_IMPORT_BATCH');assert.equal(batches.length,1);assert.equal(batches[0].payload.requestId,'job-40');assert.deepEqual(batches[0].payload.items.map(b=>b.tweet_id),Array.from({length:40},(_,i)=>String(i+41)));
});
test('timeline sort index orders recovered and newly observed drafts without precision loss',()=>{
  const h=contentHarness();h.run(`bookmarkScannerState.pendingBookmarks.set('old',{tweet_id:'old',text:'old',timeline_order:'18000000000000001'});bookmarkScannerState.pendingBookmarks.set('new',{tweet_id:'new',text:'new',timeline_order:'18000000000000002'});`);
  assert.equal(h.run('getBookmarkScannerPendingItems()[0].tweet_id'),'new');
});
test('invalid Tweet payload cannot mark a known terminal page healthy',async()=>{
  const payload=timeline([item(1,{__typename:'Tweet',rest_id:'1'})]);payload.data.bookmark_timeline_v2.timeline.instructions.push({type:'TimelineTerminateTimeline',direction:'Bottom'});
  const h=await bridgeHarness(payload);assert.equal(h.events.at(-1).detail.health,'schema_unknown');
});
test('later healthy terminal page cannot erase an earlier parsing gap',async()=>{
  const h=contentHarness();h.run(`initializeBookmarkScanner=async()=>getBookmarkScannerStatus();checkpointScannerDrafts=async()=>{};handlePageBridgeNetworkEvent({detail:{source:PAGE_BRIDGE_SOURCE,protocol:2,timeline:'bookmarks',entries:[],health:'schema_unknown',pending:false}});handlePageBridgeNetworkEvent({detail:{source:PAGE_BRIDGE_SOURCE,protocol:2,timeline:'bookmarks',entries:[],health:'ok',terminal:true,pending:false}});`);
  const status=await h.run('runBookmarkScannerScrollScan()');assert.equal(status.coverage,'partial');assert.equal(status.coverageGap,true);
});
