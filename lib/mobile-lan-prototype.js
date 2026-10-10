"use strict";

// Experimental, explicitly started, read-only LAN gateway. Not a production
// security boundary: HTTP on a trusted LAN has no transport encryption.
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const mdns = require("multicast-dns");
const QRCode = require("qrcode");

const MULTICAST = "239.255.41.78";
const ELECTION_PORT = 41781;
const WEB_PORT = 41780;
const PEER_TIMEOUT = 6000;
const COOKIE = "llm_mobile_prototype";
const READ_ROUTES = new Set(["/api/usage", "/api/system/live", "/api/subscription-history", "/api/codex-reset-history", "/api/quota-history"]);
const MAC = (key, value) => crypto.createHmac("sha256", Buffer.from(key, "base64url")).update(value).digest("base64url");
const equal = (a, b) => typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function privateAddress(ip) {
  const parts = String(ip).split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
}

function lanInterfaces() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, rows]) =>
    /^(utun|tun|tap|tailscale|docker|br-|veth)/i.test(name) ? [] : rows.filter((row) => row.family === "IPv4" && !row.internal && privateAddress(row.address)).map((row) => ({ name, address: row.address, netmask: row.netmask })));
}

function sameSubnet(left, right, mask) {
  const parts = (value) => value.split(".").map(Number);
  return parts(left).every((value, i) => (value & parts(mask)[i]) === (parts(right)[i] & parts(mask)[i]));
}

async function savePrivate(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, file);
}

async function loadGroup(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (value.version !== 1 || !/^[a-f0-9]{16}$/.test(value.id) || !/^[\w-]{43}$/.test(value.key)) throw new Error("invalid_group");
    return value;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const value = { version: 1, id: crypto.randomBytes(8).toString("hex"), key: crypto.randomBytes(32).toString("base64url") };
    await savePrivate(file, value);
    return value;
  }
}

function signToken(group, purpose, lifetime, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ purpose, id: crypto.randomUUID(), expires: now + lifetime })).toString("base64url");
  return `${body}.${MAC(group.key, body)}`;
}

function verifyToken(group, token, purpose, now = Date.now()) {
  if (typeof token !== "string" || token.length > 600) return false;
  const [body, signature, extra] = token.split(".");
  if (extra || !body || !equal(signature, MAC(group.key, body))) return false;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString());
    return value.purpose === purpose && Number.isSafeInteger(value.expires) && value.expires > now;
  } catch { return false; }
}

function sanitize(value) {
  if (typeof value === "string") return /(?:^(?:\/Users\/|\/home\/|[A-Z]:\\)|Bearer\s|sk-[A-Za-z0-9]{12})/.test(value) ? null : value;
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  const blocked = /^(?:.*(?:path|file|directory|password|secret|credential|transcript|prompt|payload|cookie|email|command|endpoint).*|accessToken|refreshToken|apiKey|privateKey|storeKey|sourceFiles|sourcePaths|accountId|orgId|organizationId)$/i;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !blocked.test(key)).map(([key, item]) => [key, sanitize(item)]));
}

function elect(peers, now = Date.now()) {
  return [...peers.values()].filter((peer) => now - peer.seen < PEER_TIMEOUT).sort((a, b) => a.id.localeCompare(b.id))[0] || null;
}

async function startMobilePrototype(options) {
  const root = path.resolve(__dirname, "..");
  const group = await loadGroup(options.groupFile);
  const directory = path.dirname(options.groupFile);
  const nodeFile = path.join(directory, "mobile-prototype-node.json");
  let node;
  try { node = JSON.parse(await fs.readFile(nodeFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; node = { id: crypto.randomUUID() }; await savePrivate(nodeFile, node); }
  const id = options.nodeId || node.id;
  const iface = lanInterfaces().find((row) => row.address === options.address) || (options.testing ? { address: options.address, netmask: "255.0.0.0" } : null);
  if (!iface || (!privateAddress(iface.address) && !options.testing)) throw new Error("private_lan_interface_required");
  const port = options.port ?? WEB_PORT;
  const hostname = `llm-${group.id}.local`;
  let baseUrl = `http://${hostname}:${port}`;
  const label = String(options.label || os.hostname()).slice(0, 80);
  const spentFile = path.join(directory, "mobile-prototype-spent.json");
  let spent = {};
  try { spent = JSON.parse(await fs.readFile(spentFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const peers = new Map();
  let stopped = false, ready = false, leader = null, dns = null, bus = null;
  let diagnostic = null, timer = null, saveQueue = Promise.resolve();
  const self = () => ({ id, address: iface.address, label, seen: Date.now() });
  const used = () => Object.fromEntries(Object.entries(spent).filter(([, expires]) => expires > Date.now()));
  const rememberSpent = () => { spent = used(); saveQueue = saveQueue.then(() => savePrivate(spentFile, spent)); return saveQueue; };
  const wire = (kind) => {
    const body = JSON.stringify({ version: 1, group: group.id, id, address: iface.address, label, at: Date.now(), kind, spent: used() });
    return Buffer.from(JSON.stringify({ body, mac: MAC(group.key, body) }));
  };
  const announce = (ttl = 3, remote, query) => {
    if (dns && ready && (leader?.id === id || ttl === 0)) dns.respond({
      ...(query ? { id: query.id, questions: query.questions } : {}),
      answers: [{ name: hostname, type: "A", flush: !remote, ttl, data: iface.address },
        { name: hostname, type: "NSEC", flush: !remote, ttl, data: { nextDomain: hostname, rrtypes: ["A"] } }]
    }, remote);
  };
  const update = () => {
    peers.set(id, self());
    const next = elect(peers);
    if (leader?.id !== next?.id) {
      if (leader?.id === id) announce(0);
      leader = next;
    }
    if (ready) announce();
    if (bus) bus.send(wire("alive"), ELECTION_PORT, MULTICAST);
  };
  const status = () => ({ version: 1, hostname, url: baseUrl, label, nodeId: id, leader: leader?.label || null, active: ready && leader?.id === id,
    transport: "http_trusted_lan_prototype", diagnostic, peers: [...peers.values()].filter((peer) => Date.now() - peer.seen < PEER_TIMEOUT).map(({ label: peerLabel, id: peerId }) => ({ label: peerLabel, id: peerId })) });
  const sameOrigin = (req) => !req.get("origin") || req.get("origin") === `http://${req.get("host")}`;
  const cookies = (req) => Object.fromEntries((req.get("cookie") || "").split(";").map((part) => part.trim().split("=")));
  const paired = (req) => verifyToken(group, cookies(req)[COOKIE], "phone");

  const web = express();
  web.disable("x-powered-by");
  web.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" });
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, "");
    if ((!options.testing && (!privateAddress(remote) || !sameSubnet(remote, iface.address, iface.netmask))) ||
      ![hostname, iface.address].includes(req.hostname) || !sameOrigin(req) || req.get("sec-fetch-site") === "cross-site") return res.status(403).json({ error: "lan_only" });
    next();
  });
  web.use(express.json({ limit: "2kb" }));
  web.get("/pair", (_req, res) => res.sendFile(path.join(root, "public", "mobile-prototype", "pair.html")));
  // Clickable links use a path because embedded browsers may lose fragments.
  // GET never redeems a token: previews and prefetching cannot consume it.
  web.get("/pair/:code", (_req, res) => res.sendFile(path.join(root, "public", "mobile-prototype", "pair.html")));
  web.get("/mobile-prototype/client.js", (_req, res) => res.sendFile(path.join(root, "public", "mobile-prototype", "client.js")));
  web.get("/mobile-prototype/styles.css", (_req, res) => res.sendFile(path.join(root, "public", "mobile-prototype", "styles.css")));
  web.get("/i18n/:language.json", (req, res, next) => /^[a-z]{2}$/.test(req.params.language) ? res.sendFile(path.join(root, "public", "i18n", `${req.params.language}.json`)) : next());
  const attempts = new Map();
  web.post("/pair", async (req, res) => {
    const remote = req.socket.remoteAddress;
    const limit = attempts.get(remote) || { at: Date.now(), count: 0 };
    if (Date.now() - limit.at > 60_000) { limit.at = Date.now(); limit.count = 0; }
    if (++limit.count > 12) return res.status(429).json({ error: "pair_rate_limited" });
    attempts.set(remote, limit);
    const code = req.body?.code;
    if (!verifyToken(group, code, "pair") || spent[digest(code)]) return res.status(401).json({ error: "pair_invalid_or_used" });
    const expires = JSON.parse(Buffer.from(code.split(".")[0], "base64url").toString()).expires;
    spent[digest(code)] = expires;
    try { await rememberSpent(); } catch { return res.status(503).json({ error: "pair_storage_failed" }); }
    update();
    const phone = signToken(group, "phone", 30 * 24 * 60 * 60_000);
    res.cookie(COOKIE, phone, { httpOnly: true, sameSite: "strict", maxAge: 30 * 24 * 60 * 60_000, path: "/" });
    res.json({ ok: true });
  });
  web.use((req, res, next) => {
    if (!paired(req)) return req.path.startsWith("/api/") ? res.status(401).json({ error: "phone_pairing_required" }) : res.redirect("/pair");
    if (req.method !== "GET") return res.status(405).json({ error: "read_only" });
    next();
  });
  web.get("/api/mobile-prototype/status", (_req, res) => res.json(status()));
  web.get("/api/auth/me", (_req, res) => res.json({ authenticated: true, protected: true, user: { name: "Mobile" }, methods: {} }));
  web.get("/api/device-sync", (_req, res) => res.json({ enabled: false, devices: [] }));
  web.get("/api/sources/diagnostics", (_req, res) => res.json({ unavailable: true }));
  web.get("/api/subscriptions/settings", (_req, res) => res.json({}));
  web.get("/api/*", async (req, res) => {
    if (!READ_ROUTES.has(req.path)) return res.status(403).json({ error: "read_only_route_unavailable" });
    try {
      const upstream = new URL(req.originalUrl, options.upstream);
      upstream.searchParams.delete("force");
      const response = await fetch(upstream, { signal: AbortSignal.timeout(25_000) });
      if (!response.ok) return res.status(503).json({ error: "local_dashboard_unavailable" });
      res.json(sanitize(await response.json()));
    } catch { res.status(503).json({ error: "local_dashboard_unavailable" }); }
  });
  web.get("/", async (_req, res) => {
    const html = await fs.readFile(path.join(root, "public", "index.html"), "utf8");
    res.type("html").send(html.replace("</head>", '<link rel="stylesheet" href="/mobile-prototype/styles.css"></head>').replace("</body>", '<script src="/mobile-prototype/client.js"></script></body>'));
  });
  web.use(express.static(path.join(root, "public"), { index: false }));
  web.use("/vendor/lucide", express.static(path.join(path.dirname(require.resolve("lucide/package.json")), "dist", "umd")));
  const listen = (app, listenPort, address) => new Promise((resolve, reject) => {
    const server = app.listen(listenPort, address, () => resolve(server)); server.once("error", reject);
  });
  const server = await listen(web, port, iface.address);
  baseUrl = `http://${hostname}:${server.address().port}`;
  const control = express();
  control.disable("x-powered-by");
  control.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    if (!["127.0.0.1", "localhost"].includes(req.hostname) || !sameOrigin(req) || req.get("sec-fetch-site") === "cross-site") return res.sendStatus(403);
    next();
  });
  control.use(express.json({ limit: "2kb" }));
  control.get("/", (_req, res) => res.sendFile(path.join(root, "public", "mobile-prototype", "control.html")));
  control.get("/api/status", (_req, res) => res.json(status()));
  control.post("/api/code", async (req, res) => {
    const code = signToken(group, "pair", 5 * 60_000);
    const origin = req.body?.direct === true ? `http://${iface.address}:${server.address().port}` : baseUrl;
    const url = `${origin}/pair#${code}`;
    const linkUrl = `${origin}/pair/${code}`;
    try { res.json({ url, linkUrl, svg: await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 4 }), expiresAt: Date.now() + 5 * 60_000 }); }
    catch { res.status(503).json({ error: "qr_unavailable" }); }
  });
  control.post("/api/group-code", (_req, res) => {
    res.json({ code: Buffer.from(JSON.stringify({ ...group, expires: Date.now() + 5 * 60_000 })).toString("base64url") });
  });
  control.post("/api/join", async (req, res) => {
    if (!options.onJoin) return res.status(403).json({ error: "join_unavailable" });
    try {
      if (typeof req.body?.code !== "string" || req.body.code.length > 1000) throw new Error("invalid_group");
      const invite = JSON.parse(Buffer.from(req.body.code, "base64url").toString());
      if (invite.version !== 1 || !/^[a-f0-9]{16}$/.test(invite.id) || !/^[\w-]{43}$/.test(invite.key) || !Number.isSafeInteger(invite.expires) || invite.expires <= Date.now() || invite.expires > Date.now() + 5 * 60_000) throw new Error("invalid_group");
      await savePrivate(options.groupFile, { version: 1, id: invite.id, key: invite.key });
      res.json({ ok: true });
      // The old control connection can finish before the gateway restarts.
      setTimeout(() => options.onJoin().catch(() => { diagnostic = "join_restart_failed"; }), 200);
    } catch { res.status(400).json({ error: "invalid_group" }); }
  });
  control.get("/i18n/:language.json", (req, res, next) => /^[a-z]{2}$/.test(req.params.language) ? res.sendFile(path.join(root, "public", "i18n", `${req.params.language}.json`)) : next());
  control.use("/mobile-prototype", express.static(path.join(root, "public", "mobile-prototype")));
  const controlServer = await listen(control, options.controlPort || 0, "127.0.0.1");
  const controlUrl = `http://127.0.0.1:${controlServer.address().port}`;
  const closeServer = (item) => new Promise((resolve) => { item.close(resolve); item.closeAllConnections(); });
  const stop = async () => {
    if (stopped) return;
    stopped = true; clearInterval(timer); if (leader?.id === id) announce(0);
    if (bus) await new Promise((resolve) => bus.send(wire("leave"), ELECTION_PORT, MULTICAST, () => bus.close(resolve)));
    if (dns) await new Promise((resolve) => dns.destroy(resolve));
    await Promise.all([closeServer(server), closeServer(controlServer), saveQueue]);
  };
  try {
    if (!options.testing) {
      // Multicast receivers bind to the wildcard address, while membership
      // and outgoing packets stay on the selected LAN interface.
      dns = mdns({ bind: "0.0.0.0", interface: iface.address, loopback: true, reuseAddr: true });
      dns.on("error", () => { diagnostic = "mdns_unavailable"; });
      dns.on("warning", () => { diagnostic = "mdns_unavailable"; });
      dns.on("query", (packet, remote) => {
        if (packet.questions.some((question) => question.name.toLowerCase() === hostname && ["A", "AAAA", "ANY"].includes(question.type))) {
          announce(3, remote.port === 5353 ? undefined : remote, remote.port === 5353 ? undefined : packet);
        }
      });
      bus = dgram.createSocket({ type: "udp4", reuseAddr: true });
      bus.on("error", () => { diagnostic = "lan_discovery_unavailable"; });
      bus.on("message", (data, remote) => {
        if (data.length > 16000 || !privateAddress(remote.address) || !sameSubnet(remote.address, iface.address, iface.netmask)) return;
        try {
          const envelope = JSON.parse(data.toString());
          if (!equal(envelope.mac, MAC(group.key, envelope.body))) return;
          const message = JSON.parse(envelope.body);
          if (message.version !== 1 || message.group !== group.id || message.id === id || typeof message.id !== "string" || message.id.length > 80 || message.address !== remote.address || Math.abs(Date.now() - message.at) > 10_000) return;
          if (message.kind === "leave") peers.delete(message.id);
          else if (message.kind === "alive") peers.set(message.id, { id: message.id, address: message.address, label: String(message.label).slice(0, 80), seen: Date.now() });
          for (const [hash, expires] of Object.entries(message.spent || {})) if (/^[a-f0-9]{64}$/.test(hash) && Number.isSafeInteger(expires) && expires > Date.now() && expires < Date.now() + 5 * 60_000 && !spent[hash]) { spent[hash] = expires; rememberSpent().catch(() => { diagnostic = "pair_storage_failed"; }); }
          const next = elect(peers);
          if (leader?.id !== next?.id) { if (leader?.id === id) announce(0); leader = next; announce(); }
        } catch { /* Only authenticated members of this group participate. */ }
      });
      await new Promise((resolve, reject) => {
        bus.once("error", reject);
        bus.bind(ELECTION_PORT, () => {
          try {
            bus.addMembership(MULTICAST, iface.address); bus.setMulticastInterface(iface.address); bus.setMulticastTTL(1);
            bus.removeListener("error", reject); resolve();
          } catch (error) { reject(error); }
        });
      });
    }
    update();
    timer = setInterval(update, 1000);
    // Listen for existing owners before announcing the shared name.
    if (!options.testing) await new Promise((resolve) => setTimeout(resolve, 1800));
    ready = true; update();
    return { group, controlUrl, url: baseUrl, status, stop, server, controlServer };
  } catch (error) { await stop(); throw error; }
}

module.exports = { startMobilePrototype, loadGroup, signToken, verifyToken, sanitize, elect, lanInterfaces, privateAddress, sameSubnet };
