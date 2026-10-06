import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { normalizeSnapshot, historicalSamples, buildHistory, creditChanges, resetCause } = require('../lib/codex-reset-history');
const date = (s) => Date.parse(s);
const snapshot = (at, reset, used, credits = [{ id: 'test-credit', status: 'available', expiresAt: '2026-12-01T00:00:00Z' }], account = 'test-account') => normalizeSnapshot({
  accountId: account, rateLimits: { primary: { usedPercent: used, resetsAt: date(reset) / 1000, windowDurationMins: 10080 } },
  rateLimitResetCredits: { availableCount: credits === null ? 2 : credits.filter(c => c.status === 'available').length, credits }
}, at);
const before = snapshot('2026-09-03T11:59:00Z', '2026-09-08T12:00:00Z', 95);
const after = snapshot('2026-09-03T12:01:00Z', '2026-09-10T12:00:00Z', 1, []);
assert(!JSON.stringify(before).includes('test-account'));
assert(!JSON.stringify(before).includes('test-credit'));
assert.equal(normalizeSnapshot({ rateLimits: {} }), null);
assert.equal(before.window.usedPercent, 95);
assert.equal(before.credits.complete, true);
assert.equal(creditChanges(before, after)[0].confidence, 'inferred');
const replaced = snapshot(after.at, after.window.resetsAt, 1, [{ id: 'replacement', status: 'available', expiresAt: '2026-12-01T00:00:00Z' }]);
assert.equal(creditChanges(before, replaced).filter(e => e.type === 'redeemed').length, 1, 'offsetting grant must not hide disappearing credit');
const confirmed = snapshot(after.at, after.window.resetsAt, 1, [{ id: 'test-credit', status: 'redeemed' }]);
assert.equal(creditChanges(before, confirmed)[0].confidence, 'confirmed');
const expiredBefore = snapshot(before.at, before.window.resetsAt, 95, [{ id: 'expired', status: 'available', expiresAt: '2026-09-03T12:00:00Z' }]);
assert.equal(creditChanges(expiredBefore, after)[0].type, 'expired', 'expiry is not a redemption');
const incomplete = snapshot(before.at, before.window.resetsAt, 95, null);
assert.equal(incomplete.credits.complete, false);
assert.equal(creditChanges(incomplete, after)[0].type, 'count_decreased');
assert.equal(creditChanges(before, snapshot(after.at, after.window.resetsAt, 1, [], 'another-account')).length, 0);
const redeeming = snapshot(before.at, before.window.resetsAt, 95, [{id:'test-credit',status:'redeeming',expiresAt:'2026-12-01T00:00:00Z'}]);
assert.equal(creditChanges(redeeming, after)[0].confidence, 'inferred');
const noExpiry = snapshot(before.at, before.window.resetsAt, 95, [{ id: 'test-credit', status: 'available' }]);
assert.equal(creditChanges(noExpiry, after)[0].type, 'missing', 'unknown expiry cannot prove a redemption');
const history = buildHistory([before, after], [], { now: date(after.at) });
assert.equal(history.windows.length, 1);
assert.equal(history.windows[0].resetType, 'early');
assert.equal(history.summary.averageDurationDays, 2);
assert.equal(history.summary.averageMaxUsedPercent, 95);
assert.equal(history.summary.inferredRedemptions, 1);
assert.equal(history.credits.availableCount, 0);
assert.deepEqual(history.windows[0].resetCause, {type:'manual',confidence:'inferred'});
assert.equal(history.summary.manualResets, 1);
const confirmedHistory = buildHistory([before, confirmed], [], {now:date(after.at)});
assert.deepEqual(confirmedHistory.windows[0].resetCause, {type:'manual',confidence:'confirmed'});
const noCreditUsed = snapshot(after.at, after.window.resetsAt, 1);
const providerHistory = buildHistory([before, noCreditUsed], [], {now:date(after.at)});
assert.deepEqual(providerHistory.windows[0].resetCause, {type:'provider_inferred',confidence:'inferred'});
assert.equal(providerHistory.summary.providerResetsInferred, 1);
assert.equal(providerHistory.summary.manualResets, 0);
assert.equal(buildHistory([before, replaced], [], {now:date(after.at)}).summary.manualResets, 1, 'same count with a replacement credit is still manual');
for (const pair of [[incomplete,after],[noExpiry,after],[expiredBefore,after],[redeeming,noCreditUsed],[before,{...noCreditUsed,planType:'different-plan'}]]) {
  assert.equal(resetCause(...pair, 'early').type, 'unknown', 'partial, expired, pending or changed-plan evidence cannot identify a provider reset');
}
assert.equal(resetCause(before,snapshot(after.at, after.window.resetsAt, 1, [], 'different-account'),'early').type,'unknown');
const zeroCreditsBefore = snapshot(before.at,before.window.resetsAt,95,[]);
assert.equal(resetCause(zeroCreditsBefore,after,'early').type,'provider_inferred','complete empty inventories still provide evidence');
const timelyRegularBefore = snapshot('2026-09-08T11:59:00Z',before.window.resetsAt,99);
const timelyRegularAfter = snapshot('2026-09-08T12:01:00Z','2026-09-15T12:00:00Z',1);
assert.equal(buildHistory([timelyRegularBefore,timelyRegularAfter],[],{now:date(timelyRegularAfter.at)}).windows[0].resetCause.type,'scheduled');
const interruptedHistory = buildHistory([before,{kind:'gap',at:'2026-09-03T12:00:00Z'},noCreditUsed],[],{now:date(after.at)});
assert.equal(interruptedHistory.windows[0].resetCause.type,'unknown','an interrupted transition cannot exclude credit use');
const interruptedRedemption = buildHistory([before,{kind:'gap',at:'2026-09-03T12:00:00Z'},after],[],{now:date(after.at)});
assert.deepEqual(interruptedRedemption.windows[0].resetCause,{type:'manual',confidence:'inferred'},'a short failed poll cannot erase before-expiry credit-redemption evidence');
assert.equal(interruptedRedemption.summary.manualResets,1);
assert.equal(interruptedRedemption.summary.recordingGaps,1,'the failed poll remains visible');
assert.equal(resetCause(before,after,'early',true,true).type,'unknown','overlapping windows still block credit attribution');
for (const pair of [[incomplete,after],[noExpiry,after],[expiredBefore,after]]) assert.equal(resetCause(...pair,'early',true).type,'unknown');

const regular = buildHistory([before, snapshot('2026-09-08T12:01:00Z', '2026-09-15T12:00:00Z', 1)], [], { now: date('2026-09-08T12:02:00Z') });
assert.equal(regular.windows[0].resetType, 'regular');
assert.equal(regular.summary.uncertainWindows, 1, 'long observation gap is explicit');
assert.equal(regular.summary.averageDurationDays, null);
assert.equal(regular.windows[0].resetCause.type,'unknown','a scheduled deadline across a long gap does not prove the cause');
const jitter = snapshot('2026-09-03T12:01:00Z', '2026-09-08T12:00:50Z', 96);
assert.equal(buildHistory([before, jitter], [], { now: date(after.at) }).summary.totalWindows, 0);
const rollingZeros = Array.from({length:10}, (_,i) => {
  const at = date('2026-09-01T00:00:00Z') + i * 60000;
  return snapshot(new Date(at).toISOString(), new Date(at + 7 * 86400000).toISOString(), 0);
});
assert.equal(buildHistory(rollingZeros).summary.totalWindows, 0, 'rolling empty deadlines do not create cycles');
const zeroA = snapshot('2026-09-03T12:00:00Z', '2026-09-10T12:00:00Z', 0, []);
const zeroB = snapshot('2026-09-03T12:02:00Z', '2026-09-10T12:00:00Z', 0, []);
assert.equal(buildHistory([before, zeroA, zeroB], [], { now: date(zeroB.at) }).summary.totalWindows, 1);
const stale = snapshot('2026-09-03T13:00:00Z', '2026-09-08T12:00:00Z', 99);
const overlap = buildHistory([before, after, stale], [], { now: date(stale.at) });
assert.equal(overlap.windows[0].overlap, true);
assert.equal(overlap.summary.averageDurationDays, null);
assert.equal(overlap.summary.earlyResets, 0);
assert.equal(overlap.windows[0].resetCause.type,'unknown');
const gaps = buildHistory([before, {kind:'gap',at:'2026-09-03T12:00:00Z'}, {kind:'gap',at:'2026-09-03T12:05:00Z'}], [], { now: date('2026-09-03T12:05:00Z') });
assert.equal(gaps.liveStatus, 'unavailable');
assert.equal(gaps.summary.recordingGaps, 1);
assert.equal(buildHistory([before, after, snapshot(after.at, after.window.resetsAt, 2, [], 'another-account')]).summary.totalWindows, 0, 'live accounts stay separate');
const raw = { timestamp: before.at, rateLimits: { primary: { used_percent:95, window_minutes:10080, resets_at:date(before.window.resetsAt)/1000 } }, transcript:'private', path:'/private/example' };
const imported = historicalSamples([raw, raw]);
assert.equal(imported.length, 1);
assert(!JSON.stringify(imported).includes('private'));
assert.equal(historicalSamples([{...raw, timestamp:'2026-08-01T00:00:00Z'}]).length, 0);
const legacy = buildHistory([], [raw, { ...raw, timestamp:after.at, rateLimits:{primary:{used_percent:1,window_minutes:10080,resets_at:date(after.window.resetsAt)/1000}} }], {now:date(after.at)});
assert.equal(legacy.windows[0].accountScope, 'historical_unscoped');
assert.equal(legacy.windows[0].resetCause.type,'unknown','early historical timing is not an OpenAI reset');
assert.equal(legacy.summary.providerResetsInferred,0);
assert.equal(legacy.summary.unknownResetCauses,1);
// Every language has the same keys and interpolation contract.
const fs = require('node:fs');
const locales = fs.readdirSync(new URL('../public/i18n/', import.meta.url)).filter(n => n.endsWith('.json'));
const en = JSON.parse(await readFile(new URL('../public/i18n/en.json',import.meta.url),'utf8')).codexResets;
for (const name of locales) {
  const translated = JSON.parse(await readFile(new URL('../public/i18n/'+name,import.meta.url),'utf8')).codexResets;
  assert.deepEqual(Object.keys(translated).sort(),Object.keys(en).sort(),name);
  for (const key of Object.keys(en)) assert.deepEqual((translated[key].match(/\{\w+\}/g)||[]).sort(),(en[key].match(/\{\w+\}/g)||[]).sort(),name+':'+key);
}
// Render evidence labels and unavailable values without bootstrap or network calls.
const app = (await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace('\ninit();','\n// bootstrap disabled');
const context = { document:{getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[]}, window:{},navigator:{},localStorage:{getItem:()=>null},Intl,Date,console,URLSearchParams,setTimeout,clearTimeout };
const html = vm.runInNewContext(app+`\nstate.translations = ${JSON.stringify({codexResets:en})}; renderCodexResetHistoryContent(${JSON.stringify(history)});`,context);
assert(html.includes('Credit redeemed: inferred'));
assert(html.includes('95 %'));
assert(html.includes('2 days'));
assert(html.includes('Reset cause'));
assert(html.includes('Manual · credit'));
assert(html.includes('Causes: 1 credit · 0 OpenAI (inferred) · 0 scheduled · 0 unknown'));
assert(!html.includes('test-account'));
const unavailableHtml = vm.runInNewContext(app+`\nstate.translations = ${JSON.stringify({codexResets:en})}; renderCodexResetHistoryContent(${JSON.stringify({...history,credits:null})});`,{...context, document:{...context.document}, window:{}});
assert(unavailableHtml.includes('<strong>—</strong>'));
// Re-open the ledger in a fresh process and verify the authenticated HTTP route.
const { mkdtemp, rm, stat } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { execFileSync } = await import('node:child_process');
const dir = await mkdtemp(join(tmpdir(), 'codex-reset-history-'));
const serverPath = require.resolve('../server.js');
const environment = {...process.env, LLM_USAGE_DATA_DIR:dir, CODEX_LIVE_RATE_LIMITS:'false', DASHBOARD_PASSWORD:'', OIDC_ISSUER_URL:''};
try {
  execFileSync(process.execPath, ['-e', `
    const { _test } = require(${JSON.stringify(serverPath)});
    (async () => {
      await _test.recordCodexResetSnapshot(${JSON.stringify(before)});
      await _test.recordCodexResetSnapshot(${JSON.stringify(after)});
      await _test.saveCodexHistoricalSamples(${JSON.stringify([raw])});
    })().catch(e => {console.error(e);process.exitCode=1});
  `], {env:environment});
  execFileSync(process.execPath, ['-e', `
    const assert=require('node:assert/strict');
    const {app}=require(${JSON.stringify(serverPath)});
    const server=app.listen(0,'127.0.0.1',async()=>{
      try {
        const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/codex-reset-history?limit=10');
        assert.equal(r.status,200); const h=await r.json();
        assert.equal(h.summary.inferredRedemptions,1); assert.equal(h.windows.length,1);
        assert.equal(h.credits.availableCount,0);
        assert.equal(h.windows[0].resetCause.type,'manual');
        assert.equal(h.summary.manualResets,1);
      } catch(e) {console.error(e);process.exitCode=1} finally {server.close()}
    });
  `], {env:environment});
  if (process.platform !== 'win32') assert.equal((await stat(join(dir,'codex-reset-snapshots.jsonl'))).mode & 0o777,0o600);
} finally {await rm(dir,{recursive:true,force:true})}
console.log('Codex reset history: evidence, privacy, gaps, accounts, rolling deadlines, locales and rendering passed.');
