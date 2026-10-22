"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { writePrivateEncryptedJson } = require("../../lib/private-json-file");

module.exports = async function verifyNativeLargeStorage() {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "llm-native-storage-"));
  const file = path.join(temporary, "snapshot.json");
  // Larger than the encrypted history that exhausted V8 while stringifying
  // the whole packet in the installed Electron app.
  const packet = { nonce: "fixture", body: "A".repeat(400 * 1024 * 1024), tag: "fixture" };
  const prefix = '{"nonce":"fixture","body":"';
  const suffix = '","tag":"fixture"}';
  try {
    await writePrivateEncryptedJson(file, packet);
    const size = prefix.length + packet.body.length + suffix.length;
    assert.equal((await fsp.stat(file)).size, size);
    const handle = await fsp.open(file, "r");
    try {
      const head = Buffer.alloc(prefix.length + 16), tail = Buffer.alloc(suffix.length + 16);
      await handle.read(head, 0, head.length, 0);
      await handle.read(tail, 0, tail.length, size - tail.length);
      assert.equal(head.toString(), prefix + "A".repeat(16));
      assert.equal(tail.toString(), "A".repeat(16) + suffix);
    } finally {
      await handle.close();
    }
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
  console.log("Native storage: 400 MiB encrypted history saved in bounded blocks without changing its JSON format.");
};
