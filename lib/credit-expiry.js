"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function createCreditExpiryStore(file) {
  let queue = Promise.resolve();
  const read = async () => {
    try { return JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  };
  return {
    async get(scope) { const values = await read(); return validDate(values[scope]) ? values[scope] : null; },
    set(scope, value) {
      if (!/^[a-f0-9]{64}$/.test(scope) || (value !== null && !validDate(value))) throw new Error("invalid_credit_expiry");
      const next = queue.then(async () => {
        const values = await read();
        if (value === null) delete values[scope]; else values[scope] = value;
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(values), { mode: 0o600 });
        await fs.rename(temporary, file);
      });
      queue = next.catch(() => {});
      return next;
    }
  };
}

function creditExpiryAlert(row, now = new Date()) {
  if (!validDate(row?.expiresOn) || !(row.balance > 0)) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((Date.parse(row.expiresOn) - today) / 86400000);
  if (days < 0 || days > 30) return null;
  const stage = days <= 1 ? 1 : days <= 7 ? 7 : 30;
  return { type: "credit_expiry", windowKey: "credits", windowLabel: "Codex credits", provider: "codex",
    expiresOn: row.expiresOn, daysRemaining: days, balance: row.balance,
    expirySource: row.expirySource, id: `credit-expiry:${row.expiresOn}:${stage}` };
}

module.exports = { createCreditExpiryStore, creditExpiryAlert, validDate };
