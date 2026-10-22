"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

function createUsageWorker() {
  const file = path.join(__dirname, "usage-aggregation-worker.js");
  if (!process.versions.electron || process.type !== "browser") return new Worker(file);

  // Keep large immutable history indexes outside Electron's main-process heap.
  const child = require("electron").utilityProcess.fork(file, [], {
    serviceName: "LLM usage aggregation",
    stdio: "ignore"
  });
  let exited = false;
  child.once("exit", () => { exited = true; });
  return {
    kind: "utility",
    get pid() { return child.pid; },
    postMessage: child.postMessage.bind(child),
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child),
    terminate() {
      if (exited) return Promise.resolve();
      return new Promise((resolve) => {
        child.once("exit", resolve);
        if (!child.kill()) child.once("spawn", () => child.kill());
      });
    }
  };
}

module.exports = { createUsageWorker };
