import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import http from "node:http";

const require = createRequire(import.meta.url);
const { DeviceSync, createIdentity, signedSnapshot, seal } = require("../lib/device-sync");
const { hash } = require("../lib/device-sync-data");
const temporary = await mkdtemp(path.join(os.tmpdir(), "llm-sync-revisions-"));
const devices = [];
const pendingWrites = [];
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
try {
  for (const name of ["source", "reader"]) {
    const device = new DeviceSync({ dataDir: path.join(temporary, name), port: 0, discovery: false, host: "127.0.0.1", intervalMs: 1_000_000 });
    devices.push(device); await device.configure({ enabled: true, name });
  }
  const [source, reader] = devices;
  const invite = source.createInvite();
  const value = JSON.parse(Buffer.from(invite.code.split(":")[1], "base64url"));
  value.endpoints = [`http://127.0.0.1:${source.port}`];
  const persist = source.persist.bind(source);
  let pairingDurable = false;
  source.persist = () => {
    const pending = (async () => {
      // A busy origin must commit trust before replying, even when its existing
      // snapshot write queue takes longer than the connection attempt budget.
      await new Promise((resolve) => setTimeout(resolve, 5200));
      await persist(); pairingDurable = true;
    })();
    pendingWrites.push(pending); return pending;
  };
  await reader.join(`llm-device-v1:${Buffer.from(JSON.stringify(value)).toString("base64url")}`);
  assert.equal(pairingDurable, true, "pairing waits for durable trust storage before succeeding");
  assert.equal(reader.config.peers.length, 1);
  assert.equal(source.config.peers.length, 1, "slow persistence still pairs both sides on the first attempt");
  source.persist = persist;
  const events = Array.from({ length: 2401 }, (_, index) => ({
    key: hash(`revision-test-${index}`), providerId: "codex", model: "gpt-fixture",
    timestamp: new Date(clock - 60_000).toISOString(), usage: { inputTokens: 1, totalTokens: 1 }
  }));
  const payload = { events, excludedEvents: 0, accounts: [] };
  await source.capture(payload);
  const originalSnapshot = source.snapshots.get(source.identity.id);
  const exchange = reader.exchange.bind(reader);
  let changed = false, receivedPages = 0, activePages = 0, peakPages = 0;
  reader.exchange = async (peer, request) => {
    if (request.type === "page") { activePages += 1; peakPages = Math.max(peakPages, activePages); }
    try {
      const reply = await exchange(peer, request);
      if (request.type === "page") {
        receivedPages += 1;
        if (!changed) {
          changed = true;
          clock += 30_000; // A real collection interval passes during this transfer.
          await new Promise((resolve) => setTimeout(resolve, 2));
          await source.capture({ ...payload, events: [...events, { ...events[0], key: hash("next-revision") }] });
        }
      }
      return reply;
    } finally { if (request.type === "page") activePages -= 1; }
  };
  await reader.sync();
  assert.equal(receivedPages, 7, "later request batches can still read the leased revision after a new capture");
  assert.equal(peakPages, 4, "page transfers run concurrently within the four-request bound");
  assert.equal(reader.snapshots.get(source.identity.id)?.revision, originalSnapshot.revision,
    "a transfer spanning a capture must publish the complete original signed snapshot");
  assert.notEqual(source.snapshots.get(source.identity.id).revision, originalSnapshot.revision);
  assert.equal(reader.config.peers[0].error, null);
  reader.exchange = exchange;
  await reader.sync();
  assert.equal(reader.snapshots.get(source.identity.id).events.length, 2402, "the next sync receives the newer revision");

  const peer = reader.config.peers[0];
  clock += 61_000;
  source.pruneTransferSnapshots();
  assert.equal(source.transferSnapshots.size, 0, "idle revisions release their event references");
  await assert.rejects(exchange(peer, { type: "pages", id: source.identity.id, revision: originalSnapshot.revision }), /peer_denied/);
  const prior = source.snapshots.get(source.identity.id);
  await exchange(peer, { type: "pages", id: source.identity.id, revision: prior.revision });
  await source.capture({ ...payload, excludedEvents: 1 });
  // Activity renews idle expiry, but must not bypass the absolute lifetime.
  for (let minute = 0; minute < 10; minute += 1) {
    clock += 59_000;
    await exchange(peer, { type: "pages", id: source.identity.id, revision: prior.revision });
  }
  clock += 11_000;
  await assert.rejects(exchange(peer, { type: "pages", id: source.identity.id, revision: prior.revision }), /peer_denied/);
  assert.equal(source.transferSnapshots.size, 0, "an active old revision still expires after ten minutes");

  const retained = [];
  for (let index = 0; index < 9; index += 1) {
    const identity = createIdentity();
    const snapshot = signedSnapshot(identity, "Capacity fixture", { events: [], excludedEvents: 0, accounts: [] });
    source.snapshots.set(identity.id, snapshot); retained.push(snapshot);
    const request = exchange(peer, { type: "pages", id: identity.id, revision: snapshot.revision });
    if (index < 8) await request;
    else await assert.rejects(request, /peer_denied/);
  }
  assert.equal(source.transferSnapshots.size, 8, "lease count is bounded even for empty snapshots");
  await source.forget(retained[0].device.id);
  assert.equal(source.transferSnapshots.size, 7, "revoking an origin removes its leased data");
  await source.forget(reader.identity.id);
  assert.equal(source.transferSnapshots.size, 0, "revoking the only reader releases its leases");

  // Check the retained-event budget without allocating a million full events
  // or opening more listeners. The network cases above exercise real signatures.
  const budget = new DeviceSync({ dataDir: path.join(temporary, "budget") });
  for (const id of ["first", "second"]) budget.snapshots.set(id, { device: { id }, revision: id, events: new Array(500_001) });
  budget.transferSnapshot("first", "first", "reader");
  assert.throws(() => budget.transferSnapshot("second", "second", "reader"), /transfer_capacity/);
  assert.equal(budget.transferSnapshots.size, 1, "the total retained-event budget cannot be bypassed with fewer revisions");
  await budget.stop();
  assert.equal(budget.transferSnapshots.size, 0, "stopping releases all leased revisions");

  // Exercise transport timeouts and delayed, still nonce-bound signed replies
  // without holding the suite open for real 30-second network waits.
  const transport = new DeviceSync({ dataDir: path.join(temporary, "transport") });
  transport.identity = createIdentity(); transport.config.enabled = true; transport.server = {};
  const remote = createIdentity(), remotePeer = { ...remote, endpoint: "http://127.0.0.1:41778" };
  const realRequest = http.request;
  let replyAge = 0, wrongNonce = false, observedTimeout = null, connectedTimeout = null;
  http.request = (_url, options, respond) => {
    observedTimeout = options.timeout; connectedTimeout = null;
    const request = new EventEmitter();
    request.setTimeout = (timeout) => { connectedTimeout = timeout; return request; };
    request.end = (body) => queueMicrotask(() => {
      const socket = new EventEmitter(); socket.connecting = true;
      request.emit("socket", socket); socket.connecting = false; socket.emit("connect");
      const incoming = JSON.parse(body);
      const receivedAt = clock;
      let packet;
      try {
        clock -= replyAge;
        packet = seal(remote, transport.identity, { type: "fixture", requestNonce: wrongNonce ? "wrong" : incoming.nonce });
      } finally { clock = receivedAt; }
      const response = new EventEmitter(); response.statusCode = 200;
      respond(response); response.emit("data", Buffer.from(JSON.stringify(packet))); response.emit("end"); request.emit("close");
    });
    return request;
  };
  try {
    for (const type of ["manifest", "pages", "page"]) {
      replyAge = 45_000;
      assert.equal((await transport.exchange(remotePeer, { type })).type, "fixture");
      assert.equal(observedTimeout, 30_000, "authenticated transfers allow a busy peer's aggregation to finish");
    }
    replyAge = 0;
    await transport.exchange(remotePeer, { type: "pair" });
    assert.equal(observedTimeout, 5000, "unreachable pairing endpoints retain the short timeout");
    assert.equal(connectedTimeout, 30_000, "connected pairing peers get enough time to durably persist trust");
    replyAge = 30_001;
    await assert.rejects(transport.exchange(remotePeer, { type: "pair" }), /peer_identity_changed/);
    replyAge = 60_001;
    await assert.rejects(transport.exchange(remotePeer, { type: "manifest" }), /peer_identity_changed/);
    replyAge = 0; wrongNonce = true;
    await assert.rejects(transport.exchange(remotePeer, { type: "manifest" }), /replayed_reply/);
    assert.equal(transport.requests.size, 0);

    const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
    const timer = { unref() {} };
    let connectExpired = null, timerCleared = false;
    globalThis.setTimeout = (callback, delay) => {
      assert.equal(delay, 5000); connectExpired = callback; return timer;
    };
    globalThis.clearTimeout = (value) => { assert.equal(value, timer); timerCleared = true; };
    http.request = () => {
      const request = new EventEmitter(); request.end = () => {};
      request.destroy = (error) => { request.destroyed = true; request.emit("error", error); request.emit("close"); };
      return request;
    };
    try {
      const pending = transport.exchange(remotePeer, { type: "pair" });
      connectExpired();
      await assert.rejects(pending, /peer_unreachable/);
      assert.equal(timerCleared, true, "an unreachable socket releases its connection timer");
      assert.equal(transport.requests.size, 0);
    } finally { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; }
  } finally { http.request = realRequest; }
} finally {
  Date.now = realNow;
  await Promise.allSettled(pendingWrites);
  await Promise.all(devices.map((device) => device.stop()));
  await rm(temporary, { recursive: true, force: true });
}
console.log("Device sync revisions: stable signed transfer across concurrent captures passed.");
