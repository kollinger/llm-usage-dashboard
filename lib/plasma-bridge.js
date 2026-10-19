"use strict";

const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");

const MAX_BYTES = 2 * 1024 * 1024;
const SOCKET_DIRECTORY = "llm-usage-dashboard";
const SOCKET_NAME = "plasma.sock";

async function privateDirectory(directory) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error("plasma_private_directory_required");
  }
}

// No TCP listener, discovery token or persisted quota cache. The OS user boundary
// protects the transport; readSnapshot must still enforce dashboard authentication.
async function startPlasmaBridge({ runtimeDirectory = process.env.XDG_RUNTIME_DIR, readSnapshot, getLanguage = () => null }) {
  if (!runtimeDirectory || !path.isAbsolute(runtimeDirectory)) throw new Error("plasma_runtime_unavailable");
  await privateDirectory(runtimeDirectory);
  const directory = path.join(runtimeDirectory, SOCKET_DIRECTORY);
  await fs.mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  await privateDirectory(directory);
  const socketPath = path.join(directory, SOCKET_NAME);
  try {
    const previous = await fs.lstat(socketPath);
    if (!previous.isSocket() || previous.uid !== process.getuid() || (previous.mode & 0o077)) throw new Error("plasma_socket_unsafe");
    const alive = await new Promise((resolve, reject) => {
      const client = net.connect(socketPath);
      client.once("connect", () => { client.destroy(); resolve(true); });
      client.once("error", (error) => ["ECONNREFUSED", "ENOENT"].includes(error.code) ? resolve(false) : reject(error));
      client.setTimeout(1000, () => { client.destroy(); reject(new Error("plasma_socket_busy")); });
    });
    if (alive) throw new Error("plasma_socket_busy");
    await fs.unlink(socketPath);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  let pending = null;
  const clients = new Set();
  const server = net.createServer((client) => {
    clients.add(client);
    client.on("error", () => {});
    client.once("close", () => clients.delete(client));
    client.setTimeout(95_000, () => client.destroy());
    // Coalesce simultaneous widget instances without caching an authenticated
    // result beyond the request (logout must take effect on the next request).
    if (!pending) pending = Promise.resolve().then(readSnapshot).catch(() => ({ status: "unavailable" })).finally(() => { pending = null; });
    pending.then((result) => {
      const envelope = { schema: 1, language: getLanguage(), status: ["ready", "locked"].includes(result?.status) ? result.status : "unavailable" };
      if (envelope.status === "ready") envelope.snapshot = result.snapshot;
      let body = JSON.stringify(envelope);
      if (Buffer.byteLength(body) > MAX_BYTES) body = JSON.stringify({ schema: 1, status: "unavailable" });
      if (!client.destroyed) client.end(body);
    }).catch(() => client.destroy());
  });
  // The private parent prevents the short listen/chmod interval being visible
  // to another user. Never change the process-global umask in an async server.
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  const identity = await fs.lstat(socketPath);
  return {
    socketPath,
    async close() {
      for (const client of clients) client.destroy();
      await new Promise((resolve) => server.close(resolve));
      try {
        const current = await fs.lstat(socketPath);
        if (current.ino === identity.ino && current.dev === identity.dev) await fs.unlink(socketPath);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  };
}

// Fetch only the existing projected endpoint, using the desktop's cookie jar.
// No sync/admin token and no auth-middleware exception is introduced.
async function readPlasmaSnapshot(session, origin) {
  const url = new URL(origin);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/") {
    throw new Error("plasma_loopback_required");
  }
  const response = await session.fetch(`${url.origin}/api/desktop-widget`, {
    credentials: "include", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(90_000)
  });
  if (response.status === 401) return { status: "locked" };
  if (!response.ok) return { status: "unavailable" };
  return { status: "ready", snapshot: await response.json() };
}

module.exports = { startPlasmaBridge, readPlasmaSnapshot, MAX_BYTES };
