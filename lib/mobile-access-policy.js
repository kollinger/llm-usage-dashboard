"use strict";

const { isIPv4 } = require("node:net");

function privateAddress(ip) {
  if (typeof ip !== "string" || !isIPv4(ip)) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const number = (ip) => ip.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
const maskFor = (prefix) => (0xffffffff << (32 - prefix)) >>> 0;

function parseVpnNetworks(value) {
  if (typeof value !== "string" || value.length > 512) throw new Error("invalid_vpn_networks");
  const entries = value.trim() ? value.trim().split(/[\s,]+/) : [];
  if (entries.length > 8) throw new Error("invalid_vpn_networks");
  return [...new Set(entries.map((entry) => {
    const match = /^(\d+\.\d+\.\d+\.\d+)(?:\/(24|25|26|27|28|29|30|31|32))?$/.exec(entry);
    if (!match || !privateAddress(match[1])) throw new Error("invalid_vpn_networks");
    const prefix = Number(match[2] || 32);
    // Reject host bits instead of silently widening the address supplied locally.
    if (((number(match[1]) & maskFor(prefix)) >>> 0) !== number(match[1])) throw new Error("invalid_vpn_networks");
    return `${match[1]}/${prefix}`;
  }))];
}

function sameSubnet(left, right, mask) {
  return [left, right, mask].every((ip) => typeof ip === "string" && isIPv4(ip)) &&
    (number(left) & number(mask)) === (number(right) & number(mask));
}

function networkAllowed(remote, iface, vpnNetworks) {
  if (!privateAddress(remote)) return false;
  return sameSubnet(remote, iface.address, iface.netmask) || vpnNetworks.some((entry) => {
    const [address, prefix] = entry.split("/");
    return (number(remote) & maskFor(Number(prefix))) === (number(address) & maskFor(Number(prefix)));
  });
}

module.exports = { privateAddress, sameSubnet, parseVpnNetworks, networkAllowed };
