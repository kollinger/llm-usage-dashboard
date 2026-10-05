import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { createUsageViewCache } from '../lib/usage-view-cache.js';
import { createUsageAggregation } from '../lib/usage-aggregation.js';
const dir = await mkdtemp(join(tmpdir(),'usage-views-'));
const directory = join(dir,'private');
const store = createUsageViewCache({directory,context:async()=> 'current-trust'});
const timestamp = new Date().toISOString();
const local = {generatedAt:timestamp,codex:{id:'codex',status:'live',limits:{fiveHour:{usedPercent:33}}},gptAccounts:{accounts:[]}};
const snapshot = id => ({device:{id:id.repeat(32),name:id},revision:id,capturedAt:timestamp,
 events:[{key:id.repeat(64),providerId:'codex',timestamp,model:'gpt-test',usage:{totalTokens:2}}],accounts:[],connections:[]});
const snapshots = [snapshot('a'),snapshot('b')];
try {
 const first = createUsageAggregation({viewCache:store});
 const result = await first.get(local,snapshots);
 assert.equal(result.local.totals.allTime.totalTokens,4);
 await first.close();
 let release;
 const restarted = createUsageAggregation({viewCache:store,createWorker:()=>{
  const worker=new Worker(new URL('../lib/usage-aggregation-worker.js',import.meta.url));
  const post=worker.postMessage.bind(worker);worker.postMessage=message=>{release=()=>post(message);};return worker;
 }});
 try {
  const restored=await restarted.get({...local,codex:{...local.codex,limits:{fiveHour:{usedPercent:49}}}},snapshots);
  assert.equal(restored.local.totals.allTime.totalTokens,4,'restart returns completed consumption without waiting for the worker');
  assert.equal(restored.cache.refreshing,true);
  assert.equal(restored.local.updatedAt,result.local.updatedAt,'cached readings keep their actual timestamp');
  assert.equal(restored.codex.limits.fiveHour.usedPercent,49,'current quotas overlay cached consumption');
  const refreshed=restarted.get(local,snapshots,'all',{force:true});
  while(!release) await new Promise(resolve=>setImmediate(resolve));
  release();
  assert.equal((await refreshed).local.totals.allTime.totalTokens,4);
 } finally {await restarted.close();}
 const revoked=createUsageAggregation({viewCache:store});
 try { assert.equal((await revoked.get(local,[snapshots[0]])).local.totals.allTime.totalTokens,2,'a removed origin cannot survive in restored consumption'); }
 finally {await revoked.close();}
 await store.write('local','current-trust',{...result,raw:'private transcript',credential:'secret-key',connectedAccounts:[{accessToken:'secret-token'}],codex:{...result.codex,raw:'private provider payload'}});
 const saved=await store.read('local','current-trust');
 assert.equal(saved.value.codex.limits,null);
 assert.deepEqual(saved.value.connectedAccounts,[]);
 assert.deepEqual(saved.value.gptAccounts.accounts,[]);
 assert.equal(await store.read('local','revoked-trust'),null);
 const nextVersion=createUsageViewCache({directory,context:store.context,version:2});
 assert.equal(await nextVersion.read('local','current-trust'),null);
 if(process.platform !== 'win32') assert.equal((await stat(directory)).mode&0o777,0o700);
 for(const file of await readdir(directory)) {
  if(process.platform !== 'win32') assert.equal((await stat(join(directory,file))).mode&0o777,0o600);
  const text=gunzipSync(await readFile(join(directory,file))).toString();
  for(const secret of ['private transcript','secret-key','secret-token','private provider payload']) assert.ok(!text.includes(secret));
 }
 const file=join(directory,(await readdir(directory))[0]);await writeFile(file,'damaged');
 const scope=JSON.parse(gunzipSync(await readFile(join(directory,(await readdir(directory))[1])))).scope;
 assert.equal(await store.read(scope==='all'?'local':'all','current-trust'),null);
 console.log('Usage view cache: restart without worker wait, honest timestamps, fresh quotas, revoked origins, context/version invalidation, corruption, permissions and credential exclusion passed.');
} finally {await rm(dir,{recursive:true,force:true});}
