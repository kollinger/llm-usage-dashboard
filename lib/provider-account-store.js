"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const ACCOUNT_LIMIT = 32;
const CONTEXT = Buffer.from("llm-usage-provider-accounts-v1");
const validId = (id) => /^key-[a-f0-9-]{36}$/.test(String(id));
const cleanLabel = (value, fallback) => String(value || fallback).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 80) || fallback;
const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function safeMeasurement(value = {}) {
  const limits = Array.isArray(value.limits?.rows) ? {
    rows: value.limits.rows.slice(0, 12).map((row, index) => ({
      key: /^[a-zA-Z0-9_-]{1,40}$/.test(row.key) ? row.key : `window-${index}`,
      usedPercent: finite(row.usedPercent), remainingPercent: finite(row.remainingPercent),
      windowMinutes: finite(row.windowMinutes), resetsAt: timestamp(row.resetsAt)
    })).filter((row) => row.usedPercent !== null || row.remainingPercent !== null)
  } : null;
  return {
    limits, updatedAt: timestamp(value.updatedAt),
    tokenTotal: finite(value.tokenTotal), costTotal: finite(value.costTotal),
    currency: /^(usd|eur|cny)$/i.test(value.currency) ? value.currency.toUpperCase() : null,
    balance: finite(value.balance), periodDays: finite(value.periodDays),
    planType: typeof value.planType === "string" ? cleanLabel(value.planType, "") : null
  };
}

function providerAccountIdentity(provider, region, key) {
  return `connection-${crypto.createHash("sha256").update(JSON.stringify([provider, region, key])).digest("hex")}`;
}

// The key stays in this process. Only the positive public-field allowlist leaves
// the store; callers never receive a record containing an API key.
function createProviderAccountStore({ dataDir, readers, now = Date.now, cacheMs = 60_000 }) {
  const dir = path.join(dataDir, "provider-accounts");
  let initialized, storageKey, records = [], writes = Promise.resolve();
  const pending = new Map();
  const publicAccount = (record) => ({
    id: record.id, provider: record.provider, label: record.label, region: record.region,
    accountId: providerAccountIdentity(record.provider, record.region, record.key),
    kind: ["glm", "kimi"].includes(record.provider) ? "subscription" : "api",
    managed: true, status: record.status, detailCode: record.detailCode || null,
    ...safeMeasurement(record.measurement)
  });
  const initialize = () => initialized ||= (async () => {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    const keyFile = path.join(dir, "storage.key");
    try { storageKey = await fs.readFile(keyFile); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      storageKey = crypto.randomBytes(32);
      try { await fs.writeFile(keyFile, storageKey, { mode: 0o600, flag: "wx" }); }
      catch (writeError) { if (writeError.code !== "EEXIST") throw writeError; storageKey = await fs.readFile(keyFile); }
    }
    if (storageKey.length !== 32) throw new Error("account_storage_unavailable");
    await fs.chmod(keyFile, 0o600);
    try {
      const file = await fs.readFile(path.join(dir, "accounts.enc"));
      if (file.length > 2_000_000 || file.length < 29) throw new Error("account_storage_unavailable");
      const decipher = crypto.createDecipheriv("aes-256-gcm", storageKey, file.subarray(0, 12));
      decipher.setAAD(CONTEXT); decipher.setAuthTag(file.subarray(12, 28));
      const parsed = JSON.parse(Buffer.concat([decipher.update(file.subarray(28)), decipher.final()]).toString("utf8"));
      if (!Array.isArray(parsed) || parsed.length > ACCOUNT_LIMIT || parsed.some((item) => !validId(item.id) || !readers[item.provider] || typeof item.key !== "string")) throw new Error("account_storage_unavailable");
      records = parsed;
    } catch (error) { if (error.code !== "ENOENT") throw new Error("account_storage_unavailable"); }
  })();
  const write = async (nextRecords) => {
    const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", storageKey, nonce);
    cipher.setAAD(CONTEXT);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(nextRecords)), cipher.final()]);
    const temporary = path.join(dir, `.${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), { mode: 0o600, flag: "wx" });
    try { await fs.rename(temporary, path.join(dir, "accounts.enc")); }
    finally { await fs.rm(temporary, { force: true }); }
    records = nextRecords;
  };
  const mutate = (operation) => {
    const result = writes.catch(() => {}).then(operation);
    writes = result; return result;
  };
  const probe = async (record) => {
    try {
      const result = await readers[record.provider]({ key: record.key, region: record.region });
      if (!result?.authenticated) return { status: "unavailable", detailCode: ["invalid_key", "permission_denied", "unsupported_key"].includes(result?.error) ? result.error : "connection_unavailable" };
      return { status: "connected", detailCode: result.detailCode || null, measurement: safeMeasurement(result) };
    } catch { return { status: "unavailable", detailCode: "connection_unavailable" }; }
  };
  return {
    async list() { await initialize(); return records.map(publicAccount); },
    async add({ provider, apiKey, label, region = "global" }) {
      if (provider !== "glm") region = "global";
      if (!Object.hasOwn(readers, provider) || typeof apiKey !== "string" || apiKey.trim().length < 8 || apiKey.length > 4096 || /[\r\n\x00]/.test(apiKey) || !["global", "china"].includes(region)) throw new Error("invalid_account");
      await initialize();
      const record = { id: `key-${crypto.randomUUID()}`, provider, key: apiKey.trim(), region, label: cleanLabel(label, provider), checkedAt: now() };
      const result = await probe(record);
      if (result.status !== "connected") throw new Error(result.detailCode);
      return mutate(async () => {
        const existing = records.find((item) => item.provider === provider && item.region === region && item.key === record.key);
        if (existing) {
          const updated = { ...existing, ...result, label: record.label, checkedAt: now() };
          await write(records.map((item) => item.id === existing.id ? updated : item)); return publicAccount(updated);
        }
        if (records.length >= ACCOUNT_LIMIT) throw new Error("account_limit");
        const added = { ...record, ...result }; await write([...records, added]); return publicAccount(added);
      });
    },
    async refresh({ force = false } = {}) {
      await initialize();
      await Promise.all(records.map(async (record) => {
        if (!force && now() - record.checkedAt < cacheMs) return;
        if (pending.has(record.id)) return pending.get(record.id);
        const task = (async () => {
          const result = await probe(record);
          await mutate(async () => {
            const current = records.find((item) => item.id === record.id);
            if (!current) return;
            const updated = { ...current, ...result, checkedAt: now() };
            await write(records.map((item) => item.id === record.id ? updated : item));
          });
        })();
        pending.set(record.id, task);
        try { await task; } finally { pending.delete(record.id); }
      }));
      return records.map(publicAccount);
    },
    async remove(id) {
      if (!validId(id)) throw new Error("invalid_account");
      await initialize();
      await mutate(async () => { await write(records.filter((record) => record.id !== id)); });
    }
  };
}

module.exports = { createProviderAccountStore, safeMeasurement, providerAccountIdentity };
