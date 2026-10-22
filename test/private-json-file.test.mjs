import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fsp = require("node:fs/promises");
const { writePrivateJson, writePrivateEncryptedJson } = require("../lib/private-json-file");
const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "llm-private-json-"));
const file = path.join(temporary, "nested", "snapshot.json");
const realWrite = fsp.writeFile;
try {
  const settings = { enabled: true, name: "Fixture ä 🧪" };
  await writePrivateJson(file, settings);
  assert.equal(await fsp.readFile(file, "utf8"), JSON.stringify(settings));

  for (const length of [0, 1, 65535, 65536, 65537, 200000]) {
    const packet = { nonce: "fixture", body: "Ab0+/=".repeat(Math.ceil(length / 6)).slice(0, length), tag: "fixture" };
    fsp.writeFile = async (target, chunks, options) => {
      assert.equal(typeof chunks, "object", "encrypted history must be an iterable, not one giant JSON string");
      assert.equal(typeof chunks[Symbol.iterator], "function");
      function* checked() {
        for (const chunk of chunks) {
          assert(chunk.length <= 65536, "storage writes must stay bounded");
          yield chunk;
        }
      }
      return realWrite(target, checked(), options);
    };
    await writePrivateEncryptedJson(file, packet);
    assert.equal(await fsp.readFile(file, "utf8"), JSON.stringify(packet), "existing encrypted JSON format must stay byte-identical");
  }
  if (process.platform !== "win32") assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
  const before = await fsp.readFile(file, "utf8");
  fsp.writeFile = async () => { throw new Error("fixture_write_failure"); };
  await assert.rejects(writePrivateEncryptedJson(file, { nonce: "fixture", body: "AA==", tag: "fixture" }), /fixture_write_failure/);
  assert.equal(await fsp.readFile(file, "utf8"), before, "a failed write must preserve the previous complete snapshot");
} finally {
  fsp.writeFile = realWrite;
  await fsp.rm(temporary, { recursive: true, force: true });
}
console.log("Private JSON storage: bounded encrypted writes, identical format, private permissions and atomic replacement passed.");
