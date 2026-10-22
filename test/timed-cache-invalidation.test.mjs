import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdtemp, rm} from "node:fs/promises";
import {setImmediate as nextTurn} from "node:timers/promises";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "usage-invalidation-"));
process.env.LLM_USAGE_DATA_DIR = root;
process.env.CODEX_LIVE_RATE_LIMITS = "false";
const {createTimedCache, readThroughCache, invalidateTimedCache} = createRequire(import.meta.url)("../server.js");
try {
  const cache = createTimedCache();
  let loads = 0, active = 0, peak = 0;
  const releases = [];
  const loader = () => {
    const version = ++loads;
    active += 1;
    peak = Math.max(peak, active);
    return new Promise(resolve => releases.push(() => {active -= 1; resolve({version});}));
  };
  const first = readThroughCache(cache, 1000, loader);
  await nextTurn();
  invalidateTimedCache(cache);
  const queued = Array.from({length: 20}, () => readThroughCache(cache, 1000, loader));
  invalidateTimedCache(cache);
  queued.push(readThroughCache(cache, 1000, loader, {force:true}));
  await nextTurn();
  assert.equal(loads, 1, "invalidation must not overlap the active full-history scan");
  releases[0]();
  assert.equal((await first).version, 1);
  await nextTurn();
  assert.equal(loads, 2, "all invalidations coalesce into one fresh scan after the old one finishes");
  releases[1]();
  assert((await Promise.all(queued)).every(row => row.version === 2));
  assert.equal(peak, 1);
  assert.equal(cache.value.version, 2, "the old generation cannot populate the new cache");
  assert.equal((await readThroughCache(cache, 1000, loader)).version, 2);
  assert.equal(loads, 2);

  const failed = createTimedCache();
  let rejectOld;
  const old = readThroughCache(failed, 1000, () => new Promise((_, reject) => {rejectOld = reject;}));
  const rejection = assert.rejects(old, /fixture failure/);
  await nextTurn();
  invalidateTimedCache(failed);
  const fresh = readThroughCache(failed, 1000, async () => ({version:"recovered"}));
  rejectOld(new Error("fixture failure"));
  await rejection;
  assert.equal((await fresh).version, "recovered", "a failed old scan cannot block the next generation");
  console.log("Cache invalidation: no overlapping scans, coalesced refreshes, current-generation results and failure recovery passed.");
} finally {await rm(root, {recursive:true,force:true});}
