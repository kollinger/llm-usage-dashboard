"use strict";

const crypto = require("node:crypto");
const dgram = require("node:dgram");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { sanitizeAccounts, sanitizeConnections, sanitizeEvent, hash } = require("./device-sync-data");

const DISCOVERY_PORT = 41779;
const DISCOVERY_GROUP = "239.255.41.77";
const PAGE_SIZE = 400;
const PAGE_CONCURRENCY = 4;
const MAX_EVENTS = 1_000_000;
const MAX_BODY = 512 * 1024;
const MAX_TRANSFER_SNAPSHOTS = 8;
const MAX_TRANSFER_EVENTS = MAX_EVENTS;
const TRANSFER_IDLE_MS = 60_000;
const TRANSFER_MAX_MS = 10 * 60_000;
const PUBLIC_KEYS = ["encryptionKey", "signingKey"];
const encode = (key) => key.export({ type: "spki", format: "der" }).toString("base64");
const importPublic = (value) => crypto.createPublicKey({ key: Buffer.from(value, "base64"), type: "spki", format: "der" });

function createIdentity() {
  const encryption = crypto.generateKeyPairSync("x25519");
  const signing = crypto.generateKeyPairSync("ed25519");
  const identity = { encryptionKey: encode(encryption.publicKey), signingKey: encode(signing.publicKey) };
  identity.id = identityId(identity);
  return { ...identity,
    encryptionPrivate: encryption.privateKey.export({ type: "pkcs8", format: "pem" }),
    signingPrivate: signing.privateKey.export({ type: "pkcs8", format: "pem" }),
    storageKey: crypto.randomBytes(32).toString("base64") };
}

function identityId(identity) { return hash(`${identity.encryptionKey}:${identity.signingKey}`).slice(0, 32); }

function publicIdentity(identity) {
  return { id: identity.id, encryptionKey: identity.encryptionKey, signingKey: identity.signingKey };
}

function validateIdentity(value) {
  if (!value || PUBLIC_KEYS.some((key) => typeof value[key] !== "string" || value[key].length > 100)) throw new Error("invalid_identity");
  if (importPublic(value.encryptionKey).asymmetricKeyType !== "x25519" || importPublic(value.signingKey).asymmetricKeyType !== "ed25519") throw new Error("invalid_identity");
  if (value.id !== identityId(value)) throw new Error("invalid_identity");
  return publicIdentity(value);
}

function sharedKey(own, other) {
  const secret = crypto.diffieHellman({ privateKey: crypto.createPrivateKey(own.encryptionPrivate), publicKey: importPublic(other.encryptionKey) });
  return Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.alloc(0), Buffer.from(`llm-device-sync-v1:${[own.id, other.id].sort().join(":")}`), 32));
}

function encrypt(key, value, aad) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { nonce: nonce.toString("base64"), body: body.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decrypt(key, box, aad) {
  const nonce = Buffer.from(box.nonce || "", "base64");
  const tag = Buffer.from(box.tag || "", "base64");
  if (nonce.length !== 12 || tag.length !== 16) throw new Error("invalid_packet");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.body, "base64")), decipher.final()]).toString("utf8"));
}

function seal(own, other, value) {
  const from = publicIdentity(own);
  const at = Date.now();
  const aad = JSON.stringify({ from, to: other.id, at });
  const box = encrypt(sharedKey(own, other), value, aad);
  const packet = { from, to: other.id, at, ...box };
  return { ...packet, signature: crypto.sign(null, Buffer.from(JSON.stringify(packet)), own.signingPrivate).toString("base64") };
}

function open(own, packet) {
  const from = validateIdentity(packet.from);
  if (packet.to !== own.id || !Number.isSafeInteger(packet.at) || Math.abs(Date.now() - packet.at) > 300_000) throw new Error("expired_packet");
  const signed = { from, to: packet.to, at: packet.at, nonce: packet.nonce, body: packet.body, tag: packet.tag };
  if (!crypto.verify(null, Buffer.from(JSON.stringify(signed)), importPublic(from.signingKey), Buffer.from(packet.signature || "", "base64"))) throw new Error("invalid_signature");
  return decrypt(sharedKey(own, from), packet, JSON.stringify({ from, to: packet.to, at: packet.at }));
}

function safeEndpoint(value) {
  const url = new URL(value);
  // Direct connections only. No hostnames, public targets, URL credentials,
  // redirects, DNS rebinding, discovery servers, STUN or relay services.
  const parts = url.hostname.split(".").map(Number);
  const privateIp = net.isIPv4(url.hostname) && (parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || (parts[0] === 169 && parts[1] === 254));
  if (url.protocol !== "http:" || !privateIp || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.port) throw new Error("invalid_endpoint");
  return url.origin;
}

function localEndpoints(port) {
  return Object.values(os.networkInterfaces()).flat().filter((row) => row && row.family === "IPv4" && !row.internal)
    .flatMap((row) => { try { return [safeEndpoint(`http://${row.address}:${port}`)]; } catch { return []; } }).slice(0, 12);
}

function snapshotBody(value) {
  const device = { ...validateIdentity(value.device), name: cleanName(value.device.name) };
  if (!Array.isArray(value.events) || value.events.length > MAX_EVENTS || !Number.isSafeInteger(value.excludedEvents) || value.excludedEvents < 0) throw new Error("invalid_snapshot");
  const capturedAt = new Date(value.capturedAt).toISOString();
  if (Date.parse(capturedAt) > Date.now() + 300_000) throw new Error("invalid_snapshot");
  const events = value.events.map(sanitizeEvent);
  if (events.some((row) => !row)) throw new Error("invalid_snapshot");
  const body = { device, capturedAt, excludedEvents: value.excludedEvents, accounts: sanitizeAccounts({ accounts: value.accounts }), events };
  // Preserve the old signed representation when reading an earlier snapshot.
  if (Object.hasOwn(value, "connections")) body.connections = sanitizeConnections(value.connections);
  return body;
}

function signedSnapshot(identity, name, payload) {
  const body = snapshotBody({ ...payload, device: { ...publicIdentity(identity), name }, capturedAt: new Date().toISOString() });
  const revision = hash(JSON.stringify(body));
  return { ...body, revision, signature: crypto.sign(null, Buffer.from(revision), identity.signingPrivate).toString("base64") };
}

function verifySnapshot(value) {
  const body = snapshotBody(value);
  const revision = hash(JSON.stringify(body));
  if (revision !== value.revision || !crypto.verify(null, Buffer.from(revision), importPublic(body.device.signingKey), Buffer.from(value.signature || "", "base64"))) throw new Error("invalid_snapshot_signature");
  return { ...body, revision, signature: value.signature };
}

function cleanName(value) {
  return String(value || "Device").replace(/[\x00-\x1f\x7f<>]/g, "").slice(0, 60).trim() || "Device";
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function writePrivate(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fsp.chmod(temporary, 0o600);
  await fsp.rename(temporary, file);
}

function snapshotRevisionKey(snapshots) {
  return JSON.stringify(snapshots.map((snapshot) => [snapshot.device.id, snapshot.revision]).sort((left, right) => left[0].localeCompare(right[0])));
}

class DeviceSync {
  constructor({ dataDir, port = 41778, discovery = true, intervalMs = 30_000, host = "0.0.0.0" }) {
    this.dir = path.join(dataDir, "device-sync");
    this.port = port; this.host = host; this.discoveryEnabled = discovery; this.intervalMs = intervalMs;
    this.config = { enabled: false, name: "Device", peers: [], revoked: [] };
    this.snapshots = new Map(); this.discovered = new Map(); this.nonces = new Map();
    this.error = null; this.busy = false; this.invite = null;
    this.requests = new Set(); this.networkGeneration = 0;
    this.transferSnapshots = new Map();
    this.writes = Promise.resolve();
    this.persistedSnapshotRevision = null;
    this.pageHashes = new WeakMap();
  }
  async initialize() {
    if (!this.initializing) this.initializing = (async () => {
      this.config = await readJson(path.join(this.dir, "settings.json"), this.config);
      if (Number.isSafeInteger(this.config.listenPort) && this.config.listenPort > 0 && this.config.listenPort <= 65535) this.port = this.config.listenPort;
      if (this.config.enabled) await this.start();
    })();
    await this.initializing;
  }
  async loadIdentity() {
    if (this.identity) return;
    this.identity = await readJson(path.join(this.dir, "identity.json"), null);
    if (!this.identity) { this.identity = createIdentity(); await writePrivate(path.join(this.dir, "identity.json"), this.identity); }
    validateIdentity(this.identity);
    const stored = await readJson(path.join(this.dir, "snapshots.json"), null);
    if (stored) {
      const snapshots = decrypt(Buffer.from(this.identity.storageKey, "base64"), stored, "llm-device-sync-storage-v1");
      for (const raw of snapshots) { const snapshot = verifySnapshot(raw); this.snapshots.set(snapshot.device.id, snapshot); }
      this.persistedSnapshotRevision = snapshotRevisionKey([...this.snapshots.values()]);
    }
  }
  async persist() {
    const operation = async () => {
      await writePrivate(path.join(this.dir, "settings.json"), this.config);
      if (!this.identity) return;
      const snapshots = [...this.snapshots.values()];
      const revision = snapshotRevisionKey(snapshots);
      if (revision === this.persistedSnapshotRevision) return;
      await writePrivate(path.join(this.dir, "snapshots.json"), encrypt(Buffer.from(this.identity.storageKey, "base64"), snapshots, "llm-device-sync-storage-v1"));
      // Mark only the revision actually written, after the atomic replacement.
      // A capture queued during the write will still persist its newer revision.
      this.persistedSnapshotRevision = revision;
    };
    this.writes = this.writes.catch(() => {}).then(operation);
    await this.writes;
  }
  status() {
    return { enabled: this.config.enabled, deviceId: this.identity?.id || null, name: this.config.name,
      error: this.error, discoveredCount: this.discovered.size,
      peers: this.config.peers.map((peer) => ({ id: peer.id, name: peer.name, lastSyncAt: peer.lastSyncAt || null, error: peer.error || null })),
      devices: [...this.snapshots.values()].map((snapshot) => ({ id: snapshot.device.id, name: snapshot.device.name,
        capturedAt: snapshot.capturedAt, eventCount: snapshot.events.length, excludedEvents: snapshot.excludedEvents })) };
  }
  async configure({ enabled, name }) {
    await this.initialize();
    if (typeof enabled !== "boolean") throw new Error("invalid_settings");
    this.config.name = cleanName(name);
    this.config.enabled = enabled;
    try {
      if (enabled) await this.start(); else await this.stop();
    } catch (error) {
      this.config.enabled = false;
      this.error = "listener_unavailable";
      throw error;
    }
    await this.persist();
    return this.status();
  }
  async start() {
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = this.startListener();
    try { await this.starting; }
    finally { this.starting = null; }
  }
  async startListener() {
    await this.loadIdentity();
    const server = http.createServer((req, res) => this.handle(req, res));
    server.requestTimeout = 15_000; server.headersTimeout = 10_000;
    server.maxConnections = 16;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(this.port, this.host, resolve); });
    this.server = server; this.port = server.address().port;
    this.config.listenPort = this.port;
    server.on("error", () => { this.error = "listener_unavailable"; });
    if (this.discoveryEnabled) this.startDiscovery();
    this.timer = setInterval(() => this.sync().catch(() => { this.error = "sync_failed"; }), this.intervalMs);
    this.timer.unref?.();
    this.error = null;
  }
  async stop() {
    this.networkGeneration += 1;
    this.transferSnapshots.clear();
    for (const request of this.requests) request.req.destroy(new Error("sync_cancelled"));
    if (this.starting) await this.starting.catch(() => {});
    clearInterval(this.timer); clearInterval(this.discoveryTimer);
    this.socket?.close(); this.socket = null;
    const server = this.server; this.server = null; this.invite = null;
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  }
  startDiscovery() {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;
    socket.on("error", () => { this.error = "discovery_unavailable"; });
    socket.on("message", (message, sender) => {
      if (message.length > 1000) return;
      try {
        const announcement = JSON.parse(message);
        const identity = validateIdentity(announcement.device);
        if (announcement.v !== 1 || identity.id === this.identity.id || Math.abs(Date.now() - announcement.at) > 90_000) return;
        const body = { v: 1, device: identity, port: announcement.port, at: announcement.at };
        if (!crypto.verify(null, Buffer.from(JSON.stringify(body)), importPublic(identity.signingKey), Buffer.from(announcement.signature || "", "base64"))) return;
        const endpoint = safeEndpoint(`http://${sender.address}:${announcement.port}`);
        this.discovered.set(identity.id, { endpoint, at: Date.now() });
        if (this.discovered.size > 100) this.discovered.delete(this.discovered.keys().next().value);
      } catch { /* Untrusted LAN announcements never authorize a device. */ }
    });
    socket.bind(DISCOVERY_PORT, () => {
      try {
        socket.addMembership(DISCOVERY_GROUP); socket.setMulticastTTL(1);
        const advertise = () => {
          for (const [id, item] of this.discovered) if (Date.now() - item.at > 90_000) this.discovered.delete(id);
          const body = { v: 1, device: publicIdentity(this.identity), port: this.port, at: Date.now() };
          const message = Buffer.from(JSON.stringify({ ...body, signature: crypto.sign(null, Buffer.from(JSON.stringify(body)), this.identity.signingPrivate).toString("base64") }));
          socket.send(message, DISCOVERY_PORT, DISCOVERY_GROUP, () => {});
        };
        advertise(); this.discoveryTimer = setInterval(advertise, 15_000); this.discoveryTimer.unref?.();
      } catch { this.error = "discovery_unavailable"; }
    });
  }
  createInvite() {
    if (!this.server || !this.config.enabled) throw new Error("sync_disabled");
    const secret = crypto.randomBytes(32).toString("base64url");
    this.invite = { secret, expiresAt: Date.now() + 300_000 };
    const value = { v: 1, device: publicIdentity(this.identity), endpoints: localEndpoints(this.port), ...this.invite };
    if (!value.endpoints.length) throw new Error("network_unavailable");
    return { code: `llm-device-v1:${Buffer.from(JSON.stringify(value)).toString("base64url")}`, expiresAt: new Date(value.expiresAt).toISOString() };
  }
  async join(code) {
    if (!this.server || !this.config.enabled) throw new Error("sync_disabled");
    if (typeof code !== "string" || code.length > 4000 || !code.startsWith("llm-device-v1:")) throw new Error("invalid_pairing_code");
    const invite = JSON.parse(Buffer.from(code.slice("llm-device-v1:".length), "base64url").toString("utf8"));
    const identity = validateIdentity(invite.device);
    if (identity.id === this.identity.id || this.config.revoked.includes(identity.id) || invite.v !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(invite.secret || "") || !Number.isSafeInteger(invite.expiresAt) || invite.expiresAt < Date.now() || invite.expiresAt > Date.now() + 300_000) throw new Error("invalid_pairing_code");
    const endpoints = (invite.endpoints || []).slice(0, 12).map(safeEndpoint);
    const discovered = this.discovered.get(identity.id)?.endpoint;
    if (discovered) endpoints.unshift(discovered);
    let connected = null;
    for (const endpoint of [...new Set(endpoints)]) {
      try {
        const reply = await this.exchange({ ...identity, endpoint }, { type: "pair", secret: invite.secret, name: this.config.name, port: this.port });
        if (reply.type !== "paired") throw new Error("pairing_failed");
        connected = { ...identity, endpoint, name: cleanName(reply.name) }; break;
      } catch { /* Try the next private interface, without exposing errors or keys. */ }
    }
    if (!connected) throw new Error("peer_unreachable");
    this.addPeer(connected);
    await this.persist(); await this.sync();
    return this.status();
  }
  addPeer(peer) {
    if (this.config.peers.length >= 20 && !this.config.peers.some((row) => row.id === peer.id)) throw new Error("device_limit");
    const existing = this.config.peers.find((row) => row.id === peer.id);
    if (existing) Object.assign(existing, peer); else this.config.peers.push(peer);
  }
  async forget(id) {
    if (!/^[a-f0-9]{32}$/.test(id || "") || id === this.identity?.id) throw new Error("invalid_device");
    this.config.peers = this.config.peers.filter((peer) => peer.id !== id);
    if (!this.config.revoked.includes(id)) this.config.revoked.push(id);
    for (const [key, transfer] of this.transferSnapshots) {
      transfer.peers.delete(id);
      if (transfer.snapshot.device.id === id || !transfer.peers.size) this.transferSnapshots.delete(key);
    }
    for (const request of this.requests) if (request.peerId === id || request.snapshotId === id) request.req.destroy(new Error("sync_cancelled"));
    this.snapshots.delete(id);
    await this.persist(); return this.status();
  }
  async capture(payload) {
    if (!this.config.enabled || !this.identity) return;
    const previous = this.snapshots.get(this.identity.id);
    const content = { events: payload.events, excludedEvents: payload.excludedEvents, accounts: sanitizeAccounts({ accounts: payload.accounts }) };
    const prior = previous && { events: previous.events, excludedEvents: previous.excludedEvents, accounts: previous.accounts };
    if (Object.hasOwn(payload, "connections")) {
      content.connections = sanitizeConnections(payload.connections);
      if (prior) prior.connections = previous.connections || [];
    }
    if (previous && JSON.stringify(prior) === JSON.stringify(content) && previous.device.name === this.config.name) return;
    const snapshot = signedSnapshot(this.identity, this.config.name, content);
    this.snapshots.set(this.identity.id, snapshot); await this.persist();
  }
  hashesFor(snapshot) {
    if (!this.pageHashes.has(snapshot)) {
      const hashes = [];
      for (let index = 0; index < snapshot.events.length; index += PAGE_SIZE) hashes.push(hash(JSON.stringify(snapshot.events.slice(index, index + PAGE_SIZE))));
      this.pageHashes.set(snapshot, hashes);
    }
    return this.pageHashes.get(snapshot);
  }
  pruneTransferSnapshots() {
    const now = Date.now();
    for (const [key, transfer] of this.transferSnapshots) {
      if (now - transfer.lastUsedAt > TRANSFER_IDLE_MS || now - transfer.startedAt > TRANSFER_MAX_MS) this.transferSnapshots.delete(key);
    }
  }
  transferSnapshot(id, revision, peerId) {
    if (this.config.revoked.includes(id) || this.config.revoked.includes(peerId)) throw new Error("snapshot_changed");
    this.pruneTransferSnapshots();
    const key = `${id}:${revision}`;
    let transfer = this.transferSnapshots.get(key);
    if (!transfer) {
      const snapshot = this.snapshots.get(id);
      if (!snapshot || snapshot.revision !== revision) throw new Error("snapshot_changed");
      const retainedEvents = [...this.transferSnapshots.values()].reduce((count, item) => count + item.snapshot.events.length, 0);
      if (this.transferSnapshots.size >= MAX_TRANSFER_SNAPSHOTS || retainedEvents + snapshot.events.length > MAX_TRANSFER_EVENTS) throw new Error("transfer_capacity");
      // Lease the immutable signed object, not a second copy of its events.
      // Captures may replace the current revision while this one is in flight.
      transfer = { snapshot, peers: new Set(), startedAt: Date.now(), lastUsedAt: Date.now() };
      this.transferSnapshots.set(key, transfer);
    }
    transfer.peers.add(peerId);
    transfer.lastUsedAt = Date.now();
    return transfer.snapshot;
  }
  manifest() {
    return [...this.snapshots.values()].filter((snapshot) => !this.config.revoked.includes(snapshot.device.id)).map((snapshot) => {
      const { events, ...rest } = snapshot;
      return { ...rest, count: events.length };
    });
  }
  async handle(req, res) {
    const send = (status, value) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
    if (req.method !== "POST" || req.url !== "/v1/message" || req.headers.origin || req.headers["content-type"] !== "application/json") { send(403, { error: "forbidden" }); return; }
    let size = 0; const chunks = [];
    try {
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error("payload_too_large"); chunks.push(chunk); }
      const packet = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const identity = validateIdentity(packet.from);
      if (this.config.revoked.includes(identity.id)) throw new Error("revoked");
      const known = this.config.peers.find((peer) => peer.id === identity.id);
      if (!known && (!this.invite || this.invite.expiresAt < Date.now())) throw new Error("unpaired");
      const value = open(this.identity, packet);
      const replayKey = `${identity.id}:${packet.nonce}`;
      for (const [key, at] of this.nonces) if (Date.now() - at > 300_000) this.nonces.delete(key);
      if (this.nonces.has(replayKey) || this.nonces.size > 10_000) throw new Error("replayed");
      this.nonces.set(replayKey, Date.now());
      let reply;
      if (value.type === "pair") {
        const expected = Buffer.from(this.invite?.secret || "");
        const supplied = Buffer.from(String(value.secret || ""));
        if (!expected.length || this.invite.expiresAt < Date.now() || expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) throw new Error("pairing_denied");
        const address = req.socket.remoteAddress?.replace(/^::ffff:/, "");
        const endpoint = safeEndpoint(`http://${address}:${value.port}`);
        this.addPeer({ ...identity, endpoint, name: cleanName(value.name) });
        this.invite = null; await this.persist();
        reply = { type: "paired", name: this.config.name };
      } else {
        if (!known) throw new Error("unpaired");
        if (value.type === "manifest") reply = { type: "manifest", snapshots: this.manifest() };
        else if (value.type === "pages") {
          const snapshot = this.transferSnapshot(value.id, value.revision, identity.id);
          reply = { type: "pages", hashes: this.hashesFor(snapshot) };
        } else if (value.type === "page") {
          const snapshot = this.transferSnapshot(value.id, value.revision, identity.id);
          if (!Number.isSafeInteger(value.page) || value.page < 0 || value.page >= Math.ceil(snapshot.events.length / PAGE_SIZE)) throw new Error("snapshot_changed");
          reply = { type: "page", events: snapshot.events.slice(value.page * PAGE_SIZE, (value.page + 1) * PAGE_SIZE) };
        } else throw new Error("invalid_request");
      }
      send(200, seal(this.identity, identity, { ...reply, requestNonce: packet.nonce }));
    } catch { if (!res.headersSent && !res.destroyed) send(403, { error: "request_denied" }); }
  }
  exchange(peer, value) {
    if (!this.config.enabled || !this.server || this.config.revoked.includes(peer.id) || this.config.revoked.includes(value.id)) throw new Error("sync_cancelled");
    const endpoint = safeEndpoint(peer.endpoint);
    const requestPacket = seal(this.identity, peer, value);
    const body = JSON.stringify(requestPacket);
    // Large local histories can occupy the peer's event loop during a refresh.
    const timeout = value.type === "pair" ? 5000 : 30_000;
    const replyMaxAge = value.type === "pair" ? 30_000 : 60_000;
    return new Promise((resolve, reject) => {
      const req = http.request(`${endpoint}/v1/message`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout }, (res) => {
        const chunks = []; let length = 0;
        res.on("data", (chunk) => { length += chunk.length; if (length > MAX_BODY) res.destroy(new Error("payload_too_large")); else chunks.push(chunk); });
        res.on("error", reject);
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw new Error("peer_denied");
            const packet = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (packet.from?.id !== peer.id || packet.at < Date.now() - replyMaxAge) throw new Error("peer_identity_changed");
            const reply = open(this.identity, packet);
            if (reply.requestNonce !== requestPacket.nonce) throw new Error("replayed_reply");
            resolve(reply);
          } catch (error) { reject(error); }
        });
      });
      // Try unreachable invitation interfaces briefly, then allow the connected
      // peer to durably persist trust and its existing snapshot write queue.
      const connectionTimer = value.type === "pair" ? setTimeout(() => req.destroy(new Error("peer_unreachable")), 5000) : null;
      connectionTimer?.unref?.();
      if (value.type === "pair") req.once("socket", (socket) => {
        const connected = () => { clearTimeout(connectionTimer); if (!req.destroyed) req.setTimeout(30_000); };
        if (socket.connecting) socket.once("connect", connected); else connected();
      });
      const request = { req, peerId: peer.id, snapshotId: value.id, snapshotRevision: value.revision };
      this.requests.add(request);
      req.once("close", () => { clearTimeout(connectionTimer); this.requests.delete(request); });
      req.on("timeout", () => req.destroy(new Error("peer_unreachable"))); req.on("error", reject); req.end(body);
    });
  }
  async sync() {
    this.pruneTransferSnapshots();
    if (!this.config.enabled || !this.server || this.busy) return this.status();
    this.busy = true;
    const generation = this.networkGeneration;
    const assertActive = (peer, snapshotId) => {
      if (!this.config.enabled || !this.server || generation !== this.networkGeneration || this.config.revoked.includes(peer.id) ||
        !this.config.peers.some((item) => item.id === peer.id) || this.config.revoked.includes(snapshotId)) throw new Error("sync_cancelled");
    };
    try {
      for (const peer of this.config.peers) {
        try {
          assertActive(peer);
          const discovered = this.discovered.get(peer.id);
          if (discovered) peer.endpoint = discovered.endpoint;
          const result = await this.exchange(peer, { type: "manifest" });
          assertActive(peer);
          if (result.type !== "manifest" || !Array.isArray(result.snapshots) || result.snapshots.length > 40) throw new Error("invalid_manifest");
          for (const meta of result.snapshots) {
            assertActive(peer);
            validateIdentity(meta.device);
            if (meta.device.id === this.identity.id || this.config.revoked.includes(meta.device.id)) continue;
            const previous = this.snapshots.get(meta.device.id);
            if (previous && (previous.revision === meta.revision || Date.parse(previous.capturedAt) >= Date.parse(meta.capturedAt))) continue;
            if (!Number.isSafeInteger(meta.count) || meta.count < 0 || meta.count > MAX_EVENTS) throw new Error("invalid_manifest");
            const pages = await this.exchange(peer, { type: "pages", id: meta.device.id, revision: meta.revision });
            assertActive(peer, meta.device.id);
            const pageCount = Math.ceil(meta.count / PAGE_SIZE);
            if (pages.type !== "pages" || !Array.isArray(pages.hashes) || pages.hashes.length !== pageCount || pages.hashes.some((value) => !/^[a-f0-9]{64}$/.test(value))) throw new Error("invalid_pages");
            const previousHashes = previous ? this.hashesFor(previous) : [];
            const pageEvents = new Array(pageCount);
            let nextPage = 0, failure = null;
            const download = async () => {
              try {
                while (!failure && nextPage < pageCount) {
                  assertActive(peer, meta.device.id);
                  const page = nextPage++;
                  if (previous && previousHashes[page] === pages.hashes[page]) {
                    pageEvents[page] = previous.events.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
                    continue;
                  }
                  const result = await this.exchange(peer, { type: "page", id: meta.device.id, revision: meta.revision, page });
                  assertActive(peer, meta.device.id);
                  if (result.type !== "page" || !Array.isArray(result.events) || result.events.length > PAGE_SIZE ||
                    hash(JSON.stringify(result.events)) !== pages.hashes[page]) throw new Error("invalid_page");
                  pageEvents[page] = result.events;
                }
              } catch (error) {
                failure ||= error;
                for (const request of this.requests) {
                  if (request.peerId === peer.id && request.snapshotId === meta.device.id && request.snapshotRevision === meta.revision) request.req.destroy(new Error("sync_cancelled"));
                }
              }
            };
            await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, pageCount) }, download));
            if (failure) throw failure;
            const events = pageEvents.flat();
            if (events.length !== meta.count) throw new Error("incomplete_snapshot");
            const snapshot = verifySnapshot({ ...meta, events });
            if (this.snapshots.size >= 40 && !previous) throw new Error("device_limit");
            assertActive(peer, snapshot.device.id);
            this.snapshots.set(snapshot.device.id, snapshot);
          }
          assertActive(peer);
          peer.lastSyncAt = new Date().toISOString(); peer.error = null;
        } catch (error) { if (error.message !== "sync_cancelled") peer.error = "peer_unreachable"; }
      }
      await this.persist();
    } finally { this.busy = false; }
    return this.status();
  }
}

module.exports = { DeviceSync, createIdentity, seal, open, safeEndpoint, signedSnapshot, verifySnapshot };
