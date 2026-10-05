"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const gzip = promisify(require("node:zlib").gzip);
const gunzip = promisify(require("node:zlib").gunzip);

// Persist parser output, never the source transcript. Source permissions and
// fingerprints are checked again on every process's first read of a file.
async function readUsageFileEvents(memory, record, parseFile, { directory, version }) {
  let stat;
  try {
    await fsp.access(record.file, fs.constants.R_OK);
    stat = await fsp.stat(record.file);
  } catch {
    memory.delete(record.realPath);
    return [];
  }
  const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  const matches = (cached) => cached?.version === version && Array.isArray(cached.events) &&
    JSON.stringify(cached.fingerprint) === JSON.stringify(fingerprint);
  const cached = memory.get(record.realPath);
  if (matches(cached)) return cached.events;
  const key = crypto.createHash("sha256").update(record.realPath).digest("hex");
  const file = path.join(directory, `${key}.json.gz`);
  try {
    const saved = JSON.parse(await gunzip(await fsp.readFile(file)));
    if (matches(saved)) { memory.set(record.realPath, saved); return saved.events; }
  } catch { /* Missing or damaged caches fall back to the source file. */ }
  const events = await parseFile(record);
  const value = { version, fingerprint, events };
  memory.set(record.realPath, value);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsp.writeFile(temporary, await gzip(JSON.stringify(value)), { mode: 0o600, flag: "wx" });
    await fsp.rename(temporary, file);
  } catch {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
  return events;
}

module.exports = { readUsageFileEvents };
