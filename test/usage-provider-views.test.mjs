import assert from 'node:assert/strict';
import { aggregateUsageEvents } from '../lib/usage-events.js';
import { prepareCombinedUsage, combinedUsage } from '../lib/device-sync-data.js';
const now=Date.now();
const events=Array.from({length:520},(_,index)=>({key:index.toString(16).padStart(64,'0'),
 providerId:index%7===0?'claudeCode':'codex',timestamp:new Date(now-index*86400000-3600000).toISOString(),
 model:index%2?'model-a':'model-b',sourceGroupId:index%11===0&&index%7!==0?'codexSpark':'codex',reasoningEffort:index%3?'high':'max',
 usage:{inputTokens:3,outputTokens:2,totalTokens:5},accountId:'gpt-'+ 'c'.repeat(16)}));
const snapshots=[{device:{id:'a'.repeat(32),name:'A'},capturedAt:new Date(now).toISOString(),events},
 {device:{id:'b'.repeat(32),name:'B'},capturedAt:new Date(now).toISOString(),events:events.slice(0,30)}];
const prepared=prepareCombinedUsage({},snapshots);
for(const selected of ['all',snapshots[0].device.id,snapshots[1].device.id]) {
 const rows=selected==='all'?prepared.events:prepared.byDevice.get(selected);
 const actual=combinedUsage({},snapshots,selected,prepared);
 const root=aggregateUsageEvents(rows,{now,dailyHistoryDays:400});
 for(const key of ['totals','daily','slots','sources','attribution']) assert.deepEqual(actual.local[key],root[key]);
 assert.deepEqual(actual.local.eventStats,root.stats);
 for(const id of ['codex','claudeCode']) {
  const expected=aggregateUsageEvents(rows.filter(row=>row.providerId===id),{now,dailyHistoryDays:400,includeAttribution:false,includeSlots:false});
  assert.deepEqual(actual[id].totals,expected.totals);
  assert.deepEqual(actual[id].daily,expected.daily,'sparse provider history keeps its own 400 dates');
  assert.deepEqual(actual[id].byModel,expected.sources.flatMap(source=>source.models||[]));
 }
 const spark=aggregateUsageEvents(rows.filter(row=>row.metadata.sourceGroupId==='codexSpark'),{now,dailyHistoryDays:400,includeAttribution:false,includeSlots:false});
 assert.deepEqual(actual.codex.spark.totals,spark.totals);
 assert.deepEqual(actual.codex.spark.daily,spark.daily);
}
console.log('Provider views: complete root, provider and Spark parity across 520 dates, copied observations, models, rolling windows and device scopes passed.');
