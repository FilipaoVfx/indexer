import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {PGlite} from '@electric-sql/pglite';
import {normalizeBookmark} from '../backend/src/normalize.js';
import {BookmarkStore} from '../backend/src/store.js';
import {createBookmarkServer} from '../backend/src/server.js';
const schema=fs.readFileSync(new URL('../backend/sql/001_bookmarks_schema.sql',import.meta.url),'utf8').match(/CREATE TABLE IF NOT EXISTS bookmarks \([\s\S]+?\n\);/)[0];
const migration=fs.readFileSync(new URL('../backend/sql/017_preserve_bookmark_capture.sql',import.meta.url),'utf8');
const receivedAt='2026-10-02T12:00:00Z';
async function database() {const db=new PGlite();await db.exec(schema);await db.exec(migration);return db;}
function storeFor(db) {
  const store=Object.create(BookmarkStore.prototype);store.init=async()=>{};store.capabilities={bookmarksFirstCommentLinks:true};
  store.processed=[];store.schedulePostIngestPipeline=({bookmarks})=>{store.processed.push(bookmarks);return true;};
  store.supabase={
    rpc:async(name,args)=>{try{return {data:(await db.query('SELECT * FROM merge_bookmark_captures($1::jsonb)',[JSON.stringify(args.p_bookmarks)])).rows,error:null};}catch(error){return {data:null,error};}},
    from:()=>({
      select:()=>({eq:async(_field,user)=>({count:(await db.query('SELECT count(*)::int AS count FROM bookmarks WHERE user_id=$1',[user])).rows[0].count})}),
      upsert:(rows)=>({select:async()=>{const data=[];for(const row of rows){
        const {rows:inserted}=await db.query(`INSERT INTO bookmarks SELECT * FROM jsonb_populate_record(NULL::bookmarks,$1::jsonb) ON CONFLICT(id) DO NOTHING RETURNING *`,[JSON.stringify(row)]);data.push(...inserted);
      }return {data,error:null};}})
    })
  };
  store.getExistingTweetIds=async({userId,tweetIds})=>new Set((await db.query('SELECT tweet_id FROM bookmarks WHERE user_id=$1 AND tweet_id=ANY($2::text[])',[userId,tweetIds])).rows.map(row=>row.tweet_id));
  return store;
}
const capture=(id,extra={})=>({tweet_id:id,text:'hello',author_username:'alice',source_url:`https://x.com/alice/status/${id}`,...extra});

test('SQL merge retains richer content, arrays, author, creation and insertion dates',async()=>{
  const db=await database();try{
    const store=storeFor(db);await store.upsertBatch({userId:'alice',bookmarks:[capture('1',{text:'Full\n\noriginal note',capture:'network',entity_type:'Tweet',created_at:'2020-01-01T00:00:00Z',links:['https://github.com/a/full'],first_comment_links:['https://example.com/reply'],media:['https://pbs.twimg.com/full']})],receivedAt});
    const original=(await db.query('SELECT * FROM bookmarks')).rows[0];
    const summary=await store.upsertBatch({userId:'alice',bookmarks:[capture('1',{text:'short',capture:'dom',created_at:null,author_username:'',links:['https://example.com/new'],media:[]})],receivedAt:'2026-10-02T13:00:00Z'});
    const saved=(await db.query('SELECT * FROM bookmarks')).rows[0];assert.equal(saved.text_content,original.text_content);assert.deepEqual(saved.created_at,original.created_at);assert.deepEqual(saved.inserted_at,original.inserted_at);assert.deepEqual(saved.ingested_at,original.ingested_at);
    assert.equal(saved.author_username,'alice');assert.deepEqual(saved.links,['https://github.com/a/full','https://example.com/new']);assert.deepEqual(saved.first_comment_links,['https://example.com/reply']);assert.equal(saved.capture_source,'network');assert.deepEqual(summary.stored_ids,['1']);
    assert.equal(store.processed.at(-1)[0].text_content,original.text_content);
  }finally{await db.close();}
});
test('concurrent poorer and richer captures converge without losing either link',async()=>{
  const db=await database();try{const store=storeFor(db);await Promise.all([
    store.upsertBatch({userId:'alice',bookmarks:[capture('1',{text:'richer full text',links:['https://a.invalid']})],receivedAt}),
    store.upsertBatch({userId:'alice',bookmarks:[capture('1',{text:'short',links:['https://b.invalid']})],receivedAt})]);
    const row=(await db.query('SELECT * FROM bookmarks')).rows[0];assert.equal(row.text_content,'richer full text');assert.equal(row.links.length,2);
  }finally{await db.close();}
});
test('within-batch duplicates merge and preserve identity fields',async()=>{
  const db=await database();try{const store=storeFor(db);const result=await store.upsertBatch({userId:'alice',bookmarks:[capture('1',{text:'short'}),capture('1',{text:'longer content',author_username:'',links:['https://a.invalid']})],receivedAt});assert.deepEqual(result.stored_ids,['1']);const row=(await db.query('SELECT * FROM bookmarks')).rows[0];assert.equal(row.author_username,'alice');assert.equal(row.text_content,'longer content');}finally{await db.close();}
});
test('network User impostors, mismatched source IDs, empty captures and unsafe URLs are rejected',()=>{
  const context={userId:'alice',receivedAt};
  assert.equal(normalizeBookmark(capture('1',{capture:'network',entity_type:'User'}),context).valid,false);
  assert.equal(normalizeBookmark(capture('1',{source_url:'https://x.com/alice/status/2'}),context).valid,false);
  assert.equal(normalizeBookmark(capture('1',{text:'',author_username:''}),context).valid,false);
  const valid=normalizeBookmark(capture('1',{links:['javascript:alert(1)','https://good.invalid']}),context);assert.deepEqual(valid.bookmark.links,['https://good.invalid']);
});
test('missing merge migration fails safely instead of destructive fallback',async()=>{
  const store=Object.create(BookmarkStore.prototype);store.supabase={rpc:async()=>({error:{message:'function missing'}})};
  await assert.rejects(store.upsertBookmarksWithFallback([{id:'alice:1'}]),error=>error.statusCode===503&&error.code==='capture_merge_unavailable');
});
test('RPC permissions exclude public callers and migration can run twice',async()=>{
  const db=await database();try{await db.exec(migration);const row=(await db.query(`SELECT has_function_privilege('public','merge_bookmark_captures(jsonb)','EXECUTE') AS permitted`)).rows[0];assert.equal(row.permitted,false);}finally{await db.close();}
});
test('real HTTP routes return only persisted per-ID acknowledgements and reject missing auth',async()=>{
  const db=await database();const store=storeFor(db);const server=createBookmarkServer(store,{apiKey:'test-key',writeRateLimitMax:100,writeRateLimitWindowMs:60000,maxBatchSize:50,allowedOrigins:['*'],metricsEnabled:false});
  try{server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
    const post=(path,body,key='test-key')=>fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key},body:JSON.stringify(body)});
    assert.equal((await post('/api/bookmarks/batch',{bookmarks:[capture('1')]},'')).status,401);
    const mixed=await (await post('/api/bookmarks/batch',{user_id:'alice',bookmarks:[capture('1'),capture('2',{capture:'network',entity_type:'User'})]})).json();
    assert.equal(mixed.ok,true);assert.deepEqual(mixed.stored_ids,['1']);assert.equal(mixed.invalid[0].tweet_id,'2');
    const empty=await (await post('/bookmarks/import-batch',{user_id:'alice',items:[{tweet_id:'3'},{tweet_id:'3'}]})).json();assert.deepEqual(empty.imported_ids,[]);assert.deepEqual(empty.duplicate_ids,[]);assert.equal(empty.failed,1);
    const imported=await (await post('/bookmarks/import-batch',{user_id:'alice',items:[capture('1'),capture('4')]})).json();assert.deepEqual(imported.imported_ids,['4']);assert.deepEqual(imported.duplicate_ids,['1']);
  }finally{server.close();await once(server,'close');await db.close();}
});
test('late deferred link enrichment cannot overwrite newer arrays or timestamps',async()=>{
  const db=await database();try{const store=storeFor(db);await store.upsertBatch({userId:'alice',bookmarks:[capture('1',{links:['https://new.invalid'],first_comment_links:['https://new-reply.invalid']})],receivedAt});
    const row=(await db.query('SELECT * FROM append_bookmark_links($1,$2::text[],$3::text[],$4::timestamptz)',['alice:1',['https://resolved.invalid'],['https://old-reply.invalid'],'2026-10-01T00:00:00Z'])).rows[0];
    assert.deepEqual(row.links,['https://new.invalid','https://resolved.invalid']);assert.deepEqual(row.first_comment_links,['https://new-reply.invalid','https://old-reply.invalid']);assert.equal(row.updated_at.toISOString(),'2026-10-02T12:00:00.000Z');
  }finally{await db.close();}
});
