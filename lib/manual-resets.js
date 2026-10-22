"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const iso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1000 ? value : null;

// Shared provider contract. No grant IDs, account IDs or provider payloads leave here.
function normalizeManualResets(raw) {
  if (!raw || !["available", "unavailable"].includes(raw.status)) return null;
  const offers = (Array.isArray(raw.offers) ? raw.offers : []).slice(0, 20).flatMap((offer) => {
    if (!offer || count(offer.remaining) === null) return [];
    return [{ remaining: offer.remaining, expiresAt: iso(offer.expiresAt), startsAt: iso(offer.startsAt),
      scope: ["full", "session", "weekly"].includes(offer.scope) ? offer.scope : "full",
      usable: offer.usable === true, paused: offer.paused === true }];
  });
  return { status: raw.status, updatedAt: iso(raw.updatedAt),
    source: raw.source === "claude_desktop_cache" ? raw.source : "provider", offers };
}

function claudeManualResets(block, updatedAt, source = "provider") {
  if (!block || typeof block !== "object" || typeof block.eligible !== "boolean") return null;
  return normalizeManualResets({ status: block.eligible ? "available" : "unavailable", updatedAt, source,
    offers: (Array.isArray(block.grants) ? block.grants : []).map((grant) => {
      const clears = Array.isArray(grant.clears) ? grant.clears : [];
      const session = clears.includes("five_hour"), weekly = clears.includes("seven_day");
      return { remaining: grant.resets_left, expiresAt: grant.ends_at, startsAt: grant.starts_at,
        scope: session && weekly ? "full" : session ? "session" : weekly ? "weekly" : null,
        usable: block.eligible && grant.usable_now === true, paused: grant.paused === true };
    }).filter((offer) => offer.scope) });
}

function decodeCacheEntry(bytes, expectedOrg) {
  if (bytes.length < 48 || bytes.readBigUInt64LE(0) !== 0xfcfb6d1ba7725c30n) return null;
  const keyLength = bytes.readUInt32LE(12);
  if (keyLength > 8192 || 24 + keyLength >= bytes.length) return null;
  const key = bytes.subarray(24, 24 + keyLength).toString("utf8");
  const start = key.indexOf("https://claude.ai/");
  if (start < 0) return null;
  let url;
  try { url = new URL(key.slice(start)); } catch { return null; }
  if (url.origin !== "https://claude.ai" || url.pathname !== `/api/organizations/${expectedOrg}/usage` || url.searchParams.get("cedar_ember") !== "1") return null;
  // Chromium Simple Cache stream 1 is followed by a SimpleFileEOF record.
  const eof = bytes.indexOf(Buffer.from("d8410d97456ffaf4", "hex"), 24 + keyLength);
  if (eof < 0) return null;
  let body = bytes.subarray(24 + keyLength, eof);
  const options = { maxOutputLength: 512 * 1024 };
  const metadata = bytes.subarray(eof).toString("latin1");
  if (body.subarray(0, 4).equals(Buffer.from("28b52ffd", "hex"))) {
    if (typeof zlib.zstdDecompressSync !== "function") return null;
    body = zlib.zstdDecompressSync(body, options);
  } else if (body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body, options);
  else if (/content-encoding[:\x00 ]+br/i.test(metadata)) body = zlib.brotliDecompressSync(body, options);
  return JSON.parse(body.toString("utf8"));
}

// Read only the current organization's usage response, never cookies or chats.
// Unsupported/missing desktop caches simply leave the metric unavailable.
function readClaudeDesktopResets({ orgId, platform = process.platform, home = os.homedir(),
  appData = process.env.APPDATA, configHome = process.env.XDG_CONFIG_HOME, cacheDir, now = Date.now() } = {}) {
  if (typeof orgId !== "string" || !/^[a-f0-9-]{36}$/i.test(orgId)) return null;
  const root = cacheDir || (platform === "darwin" ? path.join(home, "Library", "Application Support", "Claude", "Cache", "Cache_Data") :
    platform === "win32" && appData ? path.join(appData, "Claude", "Cache", "Cache_Data") :
    platform === "linux" ? path.join(configHome || path.join(home, ".config"), "Claude", "Cache", "Cache_Data") : null);
  if (!root) return null;
  try {
    const entries = fs.readdirSync(root).filter((name) => /^[a-f0-9]{16}_0$/.test(name)).flatMap((name) => {
      try {
        const file = path.join(root, name), stat = fs.statSync(file);
        return stat.isFile() && stat.size <= 1024 * 1024 && stat.mtimeMs <= now + 60_000 && now - stat.mtimeMs <= 24 * 3600_000 ? [{ file, at: stat.mtimeMs }] : [];
      } catch { return []; }
    }).sort((a, b) => b.at - a.at).slice(0, 512);
    for (const entry of entries) {
      try {
        const payload = decodeCacheEntry(fs.readFileSync(entry.file), orgId);
        const resets = claudeManualResets(payload?.cedar_ember, new Date(entry.at).toISOString(), "claude_desktop_cache");
        if (resets) return resets;
      } catch { /* Cache writes and unsupported formats must not break usage. */ }
    }
  } catch { /* Desktop app is optional on every platform. */ }
  return null;
}

module.exports = { normalizeManualResets, claudeManualResets, readClaudeDesktopResets, decodeCacheEntry };
