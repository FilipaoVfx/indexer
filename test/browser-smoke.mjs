import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {chromium} from 'playwright';
const extensionDir=new URL('../extension',import.meta.url).pathname;
let executablePath=chromium.executablePath();
try { await fs.access(executablePath); } catch {
  const cache=path.join(os.homedir(),'.cache/ms-playwright');
  const installed=(await fs.readdir(cache)).filter(name=>/^chromium-\d+$/.test(name)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]));
  if(installed.length)executablePath=path.join(cache,installed[0],'chrome-linux64','chrome');
}
const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/bookmarks.json',import.meta.url),'utf8'));
fixture.data.bookmark_timeline_v2.timeline.instructions.push({type:'TimelineTerminateTimeline',direction:'Bottom'});

test('real MV3 extension keeps import running after popup closes with an early main-world bridge',async()=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'indexer-mv3-'));
  const stored=new Set();const captures=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    res.setHeader('Content-Type','application/json');
    if(req.method==='POST'){
      const parsed=JSON.parse(body);const items=parsed.items || parsed.bookmarks || [];
      for(const item of items){stored.add(item.tweet_id);captures.push(item);}
      res.end(JSON.stringify({ok:true,imported_ids:items.map(i=>i.tweet_id),stored_ids:items.map(i=>i.tweet_id),duplicate_ids:[]}));
    }else res.end(JSON.stringify({ok:true,ids:[...stored],version:'test'}));
  });
  let context;
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');
    context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chromium',executablePath,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-sandbox']});
    let worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId=new URL(worker.url()).hostname;
    const pageErrors=[];context.on('page',page=>page.on('pageerror',error=>pageErrors.push(error.message)));
    // Entire X surface is a local fixture: no live login, API call, or bookmark mutation.
    await context.route('https://x.com/**',route=>{
      if(route.request().url().includes('/i/api/graphql/'))return route.fulfill({contentType:'application/json',body:JSON.stringify(fixture)});
      return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Bookmarks fixture</title><body><main></main></body>'});
    });
    const apiBaseUrl=`http://127.0.0.1:${server.address().port}`;
    await worker.evaluate(async settings=>chrome.storage.local.set(settings),{apiBaseUrl,userId:'test-user',apiKey:'test-key'});
    const page=await context.newPage();await page.goto('https://x.com/i/bookmarks');
    const bridge=await page.evaluate(()=>window.__xIndexerPageBridgeInstalled);assert.equal(bridge,true);
    // Wait for the isolated-world scanner to initialize, then trigger the page's request.
    await page.waitForTimeout(750);
    await page.evaluate(()=>fetch('/i/api/graphql/hash/Bookmarks'));
    await page.waitForTimeout(600);
    const popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const job=await popup.evaluate(async tabId=>chrome.runtime.sendMessage({type:'START_BOOKMARK_IMPORT',payload:{tabId,range:{min:1,max:1}}}),await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({url:'https://x.com/i/bookmarks'});return tabs[0].id;}));
    assert.equal(job.ok,true,job.error);await popup.close();
    await page.waitForTimeout(1500);
    const journal=await worker.evaluate(async()=> (await chrome.storage.local.get('delivery_state_v2')).delivery_state_v2);
    assert.equal(journal.jobs[job.jobId].phase,'confirmed');assert.equal(journal.jobs[job.jobId].confirmed,1);assert.equal(journal.queue.length,0);assert.deepEqual([...stored],['100']);assert.equal(captures[0].entity_type,'Tweet');assert.equal(captures[0].capture,'network');
    assert.deepEqual(pageErrors,[]);
  }finally{
    await context?.close();server.close();await once(server,'close');await fs.rm(profile,{recursive:true,force:true});
  }
});
