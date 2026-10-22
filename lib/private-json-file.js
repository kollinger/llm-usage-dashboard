"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

async function writePrivateData(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  await fsp.writeFile(temporary, content, { mode: 0o600 });
  await fsp.chmod(temporary, 0o600);
  await fsp.rename(temporary, file);
}

function writePrivateJson(file, value) {
  return writePrivateData(file, JSON.stringify(value));
}

// The body is base64 emitted by the storage cipher, so it needs no JSON
// escaping. Keep its existing on-disk representation without asking V8 to
// stringify another complete copy of a multi-hundred-megabyte history.
function* encryptedJsonChunks(packet) {
  yield `{"nonce":${JSON.stringify(packet.nonce)},"body":"`;
  for (let offset = 0; offset < packet.body.length; offset += 64 * 1024) {
    yield packet.body.slice(offset, offset + 64 * 1024);
  }
  yield `","tag":${JSON.stringify(packet.tag)}}`;
}

function writePrivateEncryptedJson(file, packet) {
  return writePrivateData(file, encryptedJsonChunks(packet));
}

module.exports = { writePrivateJson, writePrivateEncryptedJson };
