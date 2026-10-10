"use strict";

const path = require("node:path");
const os = require("node:os");
const { startMobilePrototype, lanInterfaces } = require("../lib/mobile-lan-prototype");

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  const address = flag("--address") || lanInterfaces()[0]?.address;
  const upstream = new URL(flag("--upstream") || "http://127.0.0.1:4177");
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname) || upstream.username || upstream.password) throw new Error("loopback_upstream_required");
  let prototype, controlPort = Number(flag("--control-port") || 0);
  const start = () => startMobilePrototype({
    address, upstream: upstream.origin,
    groupFile: flag("--group-file") || path.join(os.homedir(), ".llm-usage-mobile-prototype", "group.json"),
    label: flag("--label") || os.hostname(), nodeId: flag("--node-id") || undefined,
    controlPort,
    onJoin: async () => { await prototype.stop(); prototype = await start(); }
  });
  prototype = await start();
  controlPort = Number(new URL(prototype.controlUrl).port);
  // Pairing secrets and group credentials deliberately never enter stdout.
  console.log(JSON.stringify({ controlUrl: prototype.controlUrl, url: prototype.url, transport: "http_trusted_lan_prototype" }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => prototype.stop().then(() => process.exit(0)));
}

main().catch((error) => { console.error(error.code || error.message); process.exitCode = 1; });
