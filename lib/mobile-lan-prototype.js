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
const { createMobilePush } = require("./mobile-notifications");
const { privateAddress, sameSubnet, parseVpnNetworks, networkAllowed } = require("./mobile-access-policy");

const MULTICAST = "239.255.41.78";
const ELECTION_PORT = 41781;
const WEB_PORT = 41780;
const PEER_TIMEOUT = 6000;
const COOKIE = "llm_mobile_prototype";
const BOOTSTRAP_COOKIE = "llm_mobile_bootstrap";
const DAY = 24 * 60 * 60_000;
const PAIR_LIFETIME = DAY;
const PHONE_LIFETIME = 365 * DAY;
const READ_ROUTES = new Set(["/api/usage", "/api/chat-usage", "/api/system/live", "/api/subscription-history", "/api/codex-reset-history", "/api/quota-history"]);
const MAC = (key, value) => crypto.createHmac("sha256", Buffer.from(key, "base64url")).update(value).digest("base64url");
const equal = (a, b) => typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function lanInterfaces() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, rows]) =>
    /^(utun|tun|tap|tailscale|docker|br-|veth)/i.test(name) ? [] : rows.filter((row) => row.family === "IPv4" && !row.internal && privateAddress(row.address)).map((row) => ({ name, address: row.address, netmask: row.netmask })));
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

function encodeToken(group, value) {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${MAC(group.key, body)}`;
}

function signToken(group, purpose, lifetime, now = Date.now()) {
  return encodeToken(group, { purpose, id: crypto.randomUUID(), expires: now + lifetime });
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
  const vpnNetworks = parseVpnNetworks(options.vpnNetworks === undefined ? "" : options.vpnNetworks);
  const languages = (await fs.readdir(path.join(root, "public", "i18n"))).filter((file) => /^[a-z]{2}\.json$/.test(file)).map((file) => file.slice(0, 2));
  const accessCopy = new Map(await Promise.all(languages.map(async (language) => [language,
    JSON.parse(await fs.readFile(path.join(root, "public", "i18n", `${language}.json`), "utf8")).mobilePrototype])));
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const denyAccess = (req, res, reason, remote) => {
    if (!/\btext\/html\b/i.test(req.get("accept") || "")) return res.status(403).json({ error: "lan_only", reason });
    const language = (req.get("accept-language") && req.acceptsLanguages(languages)) || "en";
    const copy = accessCopy.get(language) || accessCopy.get("en");
    const key = reason === "network_not_allowed" ? "accessNetwork" : reason === "host_not_allowed" || reason === "proxy_not_allowed" ? "accessHost" : "accessOrigin";
    const source = reason !== "network_not_allowed" ? "" : privateAddress(remote)
      ? `<p>${escapeHtml(copy.accessSource)}: <code dir="ltr">${escapeHtml(remote)}</code></p><p><label for="vpn-source-entry">${escapeHtml(copy.accessEntry)}</label><br><input id="vpn-source-entry" type="text" dir="ltr" readonly value="${escapeHtml(remote)}/32"></p><p>${escapeHtml(copy.accessNat)}</p>`
      : `<p>${escapeHtml(copy.accessUnavailable)}</p>`;
    // This page cannot load protected assets. Keep it self-contained and never
    // echo URLs, pairing codes, cookies, server addresses or configured ranges.
    // Only a network denial may show its validated private TCP peer and /32.
    return res.status(403).set({ "Content-Language": language, "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", Vary: "Accept, Accept-Language" }).type("html").send(
      `<!doctype html><html lang="${language}" dir="${language === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(copy.accessDenied)}</title></head><body><main><h1>${escapeHtml(copy.accessDenied)}</h1><p>${escapeHtml(copy[key])}</p>${source}</main></body></html>`);
  };
  const group = await loadGroup(options.groupFile);
  const directory = path.dirname(options.groupFile);
  let httpsOrigin = null;
  if (options.httpsOrigin) {
    const value = new URL(options.httpsOrigin);
    if (value.protocol !== "https:" || value.username || value.password || value.pathname !== "/" || value.search || value.hash) throw new Error("https_origin_required");
    httpsOrigin = value.origin;
  }
  const push = httpsOrigin ? await createMobilePush({ file: path.join(directory, `mobile-push-${group.id}-${digest(httpsOrigin).slice(0, 12)}.json`), origin: httpsOrigin, ...(options.pushSend ? { send: options.pushSend } : {}) }) : null;
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
  const requestOrigin = (req) => req.mobileHttps ? httpsOrigin : `http://${req.get("host")}`;
  const sameOrigin = (req) => !req.get("origin") || req.get("origin") === requestOrigin(req);
  const cookies = (req) => Object.fromEntries((req.get("cookie") || "").split(";").map((part) => part.trim().split("=")));
  const paired = (req) => verifyToken(group, cookies(req)[COOKIE], "phone");
  const phone = (req) => {
    if (req.mobilePhone) return req.mobilePhone;
    const token = cookies(req)[COOKIE];
    const value = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    return { id: value.owner || digest(token), expires: value.expires };
  };
  const phoneCookie = (req, res, token) => res.cookie(COOKIE, token, { httpOnly: true, secure: !!req.mobileHttps, sameSite: "strict", maxAge: PHONE_LIFETIME, path: "/" });
  let notificationFeed = null, notificationRead = null, notificationTimer = null;
  const notifications = async () => {
    if (notificationFeed && Date.now() - notificationFeed.at < 30000) return notificationFeed.value;
    if (!notificationRead) notificationRead = (async () => {
      const response = await fetch(new URL("/api/notifications/mobile", options.upstream), { signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error("mobile_notifications_unavailable");
      const value = sanitize(await response.json());
      notificationFeed = { at: Date.now(), value };
      if (push) await push.publish(value);
      return value;
    })().finally(() => { notificationRead = null; });
    return notificationRead;
  };
  const pairingEvents = [];
  const codeState = (code) => !code ? "missing" : typeof code !== "string" || !/^[\w-]+\.[\w-]{43}$/.test(code) || !verifyToken(group, code, "pair", 0) ? "invalid" :
    !verifyToken(group, code, "pair") ? "expired" : spent[digest(code)] ? "used" : "valid";
  const pairingEvent = (req, action, state) => {
    pairingEvents.push({ at: new Date().toISOString(), action, state, client: /iPhone|iPad|Android/i.test(req.get("user-agent") || "") ? "mobile" : "other" });
    if (pairingEvents.length > 12) pairingEvents.shift();
  };

  const web = express();
  web.disable("x-powered-by");
  web.set("trust proxy", false);
  web.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" });
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/i, "");
    const proxyAllowed = req.mobileHttps && remote === "127.0.0.1" && req.get("host") === new URL(httpsOrigin).host && req.get("x-forwarded-proto") === "https";
    if (req.mobileHttps) {
      if (!proxyAllowed) return denyAccess(req, res, "proxy_not_allowed");
    } else {
      // Only the TCP peer counts. Forwarded / X-Forwarded-* never grant access.
      if (!options.testing && !networkAllowed(remote, iface, vpnNetworks)) return denyAccess(req, res, "network_not_allowed", remote);
      if (![hostname, iface.address].includes(req.hostname)) return denyAccess(req, res, "host_not_allowed");
    }
    if (!sameOrigin(req) || req.get("sec-fetch-site") === "cross-site") return denyAccess(req, res, "origin_not_allowed");
    next();
  });
  web.use(express.json({ limit: "4kb" }));
  const pairPage = async (req, res) => {
    if (paired(req)) return res.redirect("/");
    const code = req.params.code || cookies(req)[BOOTSTRAP_COOKIE];
    const state = codeState(code);
    pairingEvent(req, req.params.code ? "link" : "page", state);
    if (state === "valid" && req.params.code) {
      const expires = JSON.parse(Buffer.from(code.split(".")[0], "base64url").toString()).expires;
      res.cookie(BOOTSTRAP_COOKIE, code, { httpOnly: true, secure: !!req.mobileHttps, sameSite: "strict", maxAge: expires - Date.now(), path: "/pair" });
    }
    try {
      const html = await fs.readFile(path.join(root, "public", "mobile-prototype", "pair.html"), "utf8");
      // Only a verified URL-safe signed token is inserted in this hidden field.
      res.type("html").send(html.replace('id="prototypeCode" value=""', `id="prototypeCode" value="${state === "valid" ? code : ""}"`)
        .replace('name="mobile-prototype-pairing-state" content=""', `name="mobile-prototype-pairing-state" content="${state}"`));
    } catch { res.status(503).json({ error: "pair_page_unavailable" }); }
  };
  // GET supplies the code directly to the page, including on a cleaned-URL
  // reload. It never redeems a token or grants dashboard access.
  web.get("/pair", pairPage);
  web.get("/pair/:code", pairPage);
  web.get("/mobile-prototype/client.js", (_req, res) => res.sendFile(path.join(root, "public", "mobile-prototype", "client.js")));
  web.get("/mobile-prototype/styles.css", (_req, res) => res.sendFile(path.join(root, "public", "mobile-prototype", "styles.css")));
  // Home-screen installers may fetch these assets without the browser's cookie.
  web.get(["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/mobile-prototype/icon.png"], (_req, res) => res.sendFile(path.join(root, "public", "mobile-prototype", "icon.png")));
  web.get("/mobile-prototype/manifest.webmanifest", (_req, res) => res.type("application/manifest+json").json({
    id: "/", name: "LLM Usage Dashboard", short_name: "LLM Usage", start_url: "/", scope: "/", display: "standalone",
    icons: [{ src: "/mobile-prototype/icon.png", sizes: "512x512", type: "image/png" }]
  }));
  web.get("/i18n/:language.json", (req, res, next) => /^[a-z]{2}$/.test(req.params.language) ? res.sendFile(path.join(root, "public", "i18n", `${req.params.language}.json`)) : next());
  const attempts = new Map();
  web.post("/pair", async (req, res) => {
    const remote = req.socket.remoteAddress;
    const limit = attempts.get(remote) || { at: Date.now(), count: 0 };
    if (Date.now() - limit.at > 60_000) { limit.at = Date.now(); limit.count = 0; }
    if (++limit.count > 12) return res.status(429).json({ error: "pair_rate_limited" });
    attempts.set(remote, limit);
    const code = req.body?.code || cookies(req)[BOOTSTRAP_COOKIE];
    const state = codeState(code);
    pairingEvent(req, "connect", state);
    if (state !== "valid") return res.status(401).json({ error: `pair_${state}` });
    const expires = JSON.parse(Buffer.from(code.split(".")[0], "base64url").toString()).expires;
    spent[digest(code)] = expires;
    try { await rememberSpent(); } catch { return res.status(503).json({ error: "pair_storage_failed" }); }
    update();
    phoneCookie(req, res, signToken(group, "phone", PHONE_LIFETIME));
    res.clearCookie(BOOTSTRAP_COOKIE, { httpOnly: true, secure: !!req.mobileHttps, sameSite: "strict", path: "/pair" });
    res.json({ ok: true });
  });
  web.use(async (req, res, next) => {
    if (!paired(req)) return req.path.startsWith("/api/") ? res.status(401).json({ error: "phone_pairing_required" }) : res.redirect("/pair");
    try {
      const token = cookies(req)[COOKIE];
      const value = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
      const current = phone(req);
      // Upgrade existing 30-day pairings too, without changing their push owner.
      if (current.expires < Date.now() + PHONE_LIFETIME - DAY) {
        current.expires = Date.now() + PHONE_LIFETIME;
        phoneCookie(req, res, encodeToken(group, { ...value, owner: current.id, expires: current.expires }));
        if (push) await push.renew(current.id, current.expires);
      }
      req.mobilePhone = current;
      next();
    } catch (error) { next(error); }
  });
  web.post("/api/mobile-prototype/push/:action", async (req, res) => {
    if (!req.mobileHttps || !push) return res.status(409).json({ error: "https_required" });
    if (req.get("origin") !== httpsOrigin || !req.is("application/json")) return res.status(403).json({ error: "same_origin_required" });
    try {
      const current = phone(req);
      if (req.params.action === "subscribe") {
        const value = await push.subscribe(current.id, current.expires, req.body.subscription, req.body.language);
        notificationFeed = null;
        notifications().catch(() => {});
        return res.json(value);
      }
      if (req.params.action === "unsubscribe") { await push.unsubscribe(current.id); return res.json({ subscribed: false }); }
      if (req.params.action === "test") return res.json(await push.test(current.id));
      res.sendStatus(404);
    } catch { res.status(400).json({ error: "push_request_failed" }); }
  });
  web.use((req, res, next) => {
    if (req.method !== "GET") return res.status(405).json({ error: "read_only" });
    next();
  });
  web.get("/api/mobile-prototype/status", (_req, res) => res.json(status()));
  web.get("/api/mobile-prototype/notifications", async (req, res) => {
    try {
      const available = !!req.mobileHttps && !!push;
      res.json({ ...(await notifications()), pushAvailable: available, publicKey: available ? push.publicKey : null,
        ...(available ? push.status(phone(req).id) : { subscribed: false }) });
    } catch { res.status(503).json({ error: "mobile_notifications_unavailable" }); }
  });
  web.get("/mobile-prototype/sw.js", (_req, res) => res.set("Service-Worker-Allowed", "/").sendFile(path.join(root, "public", "mobile-prototype", "sw.js")));
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
    res.type("html").send(html.replace("</head>", '<link rel="manifest" href="/mobile-prototype/manifest.webmanifest"><link rel="apple-touch-icon" sizes="512x512" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-title" content="LLM Usage"><link rel="stylesheet" href="/mobile-prototype/styles.css"></head>').replace("</body>", '<script src="/mobile-prototype/client.js"></script></body>'));
  });
  web.use(express.static(path.join(root, "public"), { index: false }));
  web.use("/vendor/lucide", express.static(path.join(path.dirname(require.resolve("lucide/package.json")), "dist", "umd")));
  const listen = (app, listenPort, address) => new Promise((resolve, reject) => {
    const server = app.listen(listenPort, address, () => resolve(server)); server.once("error", reject);
  });
  const server = await listen(web, port, iface.address);
  let proxyServer = null;
  if (httpsOrigin) {
    const proxy = express();
    proxy.use((req, _res, next) => { req.mobileHttps = true; next(); });
    proxy.use(web);
    try { proxyServer = await listen(proxy, options.httpsProxyPort || 0, "127.0.0.1"); }
    catch (error) { server.close(); throw error; }
    notificationTimer = setInterval(() => notifications().catch(() => {}), 30000);
  }
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
  control.get("/api/status", (_req, res) => res.json({ ...status(), pairing: pairingEvents }));
  control.post("/api/code", async (req, res) => {
    const code = signToken(group, "pair", PAIR_LIFETIME);
    const origin = req.body?.https === true && httpsOrigin ? httpsOrigin : req.body?.direct === true ? `http://${iface.address}:${server.address().port}` : baseUrl;
    const url = `${origin}/pair#${code}`;
    const linkUrl = `${origin}/pair/${code}`;
    try { res.json({ url, linkUrl, svg: await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 4 }), expiresAt: Date.now() + PAIR_LIFETIME }); }
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
  let controlServer;
  try { controlServer = await listen(control, options.controlPort || 0, "127.0.0.1"); }
  catch (error) {
    await Promise.all([server, proxyServer].filter(Boolean).map((item) => new Promise((resolve) => { item.close(resolve); item.closeAllConnections(); })));
    throw error;
  }
  const controlUrl = `http://127.0.0.1:${controlServer.address().port}`;
  const closeServer = (item) => new Promise((resolve) => { item.close(resolve); item.closeAllConnections(); });
  const stop = async () => {
    if (stopped) return;
    stopped = true; clearInterval(timer); clearInterval(notificationTimer); if (leader?.id === id) announce(0);
    if (bus) await new Promise((resolve) => bus.send(wire("leave"), ELECTION_PORT, MULTICAST, () => bus.close(resolve)));
    if (dns) await new Promise((resolve) => dns.destroy(resolve));
    await Promise.all([closeServer(server), closeServer(controlServer), proxyServer ? closeServer(proxyServer) : null, saveQueue, notificationRead?.catch(() => {}), push?.flush()]);
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
          for (const [hash, expires] of Object.entries(message.spent || {})) if (/^[a-f0-9]{64}$/.test(hash) && Number.isSafeInteger(expires) && expires > Date.now() && expires < Date.now() + PAIR_LIFETIME && !spent[hash]) { spent[hash] = expires; rememberSpent().catch(() => { diagnostic = "pair_storage_failed"; }); }
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
    return { group, controlUrl, url: baseUrl, status, stop, server, controlServer, proxyServer };
  } catch (error) { await stop(); throw error; }
}

module.exports = { startMobilePrototype, loadGroup, signToken, verifyToken, sanitize, elect, lanInterfaces, privateAddress, sameSubnet };
