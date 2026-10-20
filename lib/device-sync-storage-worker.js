"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { readStoredSnapshots } = require("./device-sync");

readStoredSnapshots(workerData.file, workerData.storageKey)
  .then((snapshots) => parentPort.postMessage({ snapshots }))
  .catch(() => parentPort.postMessage({ error: "storage_unavailable" }));
