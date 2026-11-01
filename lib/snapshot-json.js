"use strict";

const crypto = require("node:crypto");

// Sync snapshots and their events are normalized plain JSON. Preserve their
// signed representation while keeping each event's serialization independent.
function* fragments(value) {
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index) yield ",";
      yield* fragments(value[index]);
    }
    yield "]";
  } else if (value && typeof value === "object" && Array.isArray(value.events)) {
    yield "{";
    let separator = "";
    for (const [key, item] of Object.entries(value)) {
      const encoded = key === "events" ? null : JSON.stringify(item);
      if (key !== "events" && encoded === undefined) continue;
      yield `${separator}${JSON.stringify(key)}:`;
      if (key === "events") yield* fragments(item);
      else yield encoded;
      separator = ",";
    }
    yield "}";
  } else yield JSON.stringify(value) ?? "null";
}

function* snapshotJsonChunks(value) {
  let chunk = "";
  for (const fragment of fragments(value)) {
    if (chunk.length + fragment.length > 64 * 1024 && chunk) {
      yield chunk; chunk = "";
    }
    chunk += fragment;
  }
  if (chunk) yield chunk;
}

function snapshotHash(value) {
  const digest = crypto.createHash("sha256");
  for (const chunk of snapshotJsonChunks(value)) digest.update(chunk, "utf8");
  return digest.digest("hex");
}

module.exports = { snapshotJsonChunks, snapshotHash };
