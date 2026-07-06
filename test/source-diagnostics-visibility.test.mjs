import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { _test } = require("../server.js");

function instance(overrides = {}) {
  return {
    pid: process.pid,
    port: 4177,
    uid: 1000,
    user: "gerhard",
    url: "http://localhost:4177",
    ...overrides
  };
}

function discovery(overrides = {}) {
  const candidates = overrides.candidates || [];
  const otherDashboardInstances = overrides.otherDashboardInstances || [];
  return {
    generatedAt: "2026-07-06T00:00:00.000Z",
    currentUser: { name: "gerhard", home: "/home/gerhard" },
    os: { platform: "linux", supported: true, supportLevel: "full" },
    candidates,
    processEvidence: [],
    serviceEvidence: [],
    otherDashboardInstances,
    counts: {
      total: candidates.length,
      readable: candidates.filter((source) => ["readable", "mixed"].includes(source.accessStatus)).length,
      denied: candidates.filter((source) => source.accessStatus === "denied").length,
      missing: candidates.filter((source) => source.accessStatus === "missing").length,
      processOnly: candidates.filter((source) => source.accessStatus === "process_only").length,
      otherDashboardInstances: otherDashboardInstances.length
    },
    ...overrides
  };
}

function connectedSettings(sourceId) {
  return {
    version: 1,
    sources: [{ id: sourceId, providerId: "codex", enabled: true, paths: [] }]
  };
}

const selfOnlyConnected = _test.buildSourceDiagnosticsPayload(
  connectedSettings("codex-current"),
  discovery({
    candidates: [{ id: "codex-current", providerId: "codex", accessStatus: "readable", owner: { current: true } }],
    otherDashboardInstances: [instance()]
  })
);

assert.equal(selfOnlyConnected.otherDashboardInstances.length, 0, "own dashboard marker should not be returned");
assert.equal(selfOnlyConnected.counts.otherDashboardInstances, 0, "own dashboard marker should not be counted");
assert.equal(selfOnlyConnected.status, "connected_live", "connected source status should not become other-dashboard");

const otherInstancePayload = _test.buildSourceDiagnosticsPayload(
  { version: 1, sources: [] },
  discovery({ otherDashboardInstances: [instance(), instance({ pid: process.pid + 1000, port: 5177 })] })
);

assert.equal(otherInstancePayload.otherDashboardInstances.length, 1, "other dashboard marker should remain visible");
assert.equal(otherInstancePayload.counts.otherDashboardInstances, 1, "other dashboard marker should remain counted");
assert.equal(otherInstancePayload.status, "other_dashboard_found");

const appPath = path.join(ROOT, "public", "app.js");
const appSource = await readFile(appPath, "utf8");
const testSource = appSource.replace("\ninit();\n", "\n// init suppressed for source diagnostics visibility smoke test.\n");

assert.notEqual(testSource, appSource, "test should suppress app bootstrap before evaluating app.js");

function createElement(id = "") {
  return {
    id,
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    value: "",
    dataset: {},
    style: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      }
    },
    addEventListener() {},
    appendChild() {},
    close() {},
    focus() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    remove() {},
    setAttribute(name, value) {
      this[name] = value;
    },
    showModal() {}
  };
}

const elements = new Map();
const documentElement = createElement("html");
const body = createElement("body");
const appShell = createElement("appShell");

const document = {
  body,
  documentElement,
  hidden: false,
  addEventListener() {},
  createElement,
  elementFromPoint() {
    return null;
  },
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, createElement(id));
    return elements.get(id);
  },
  querySelector(selector) {
    if (selector === "main.app-shell") return appShell;
    return createElement(selector);
  },
  querySelectorAll() {
    return [];
  }
};

const context = {
  console,
  document,
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  localStorage: {
    getItem() {
      return null;
    },
    setItem() {}
  },
  navigator: {
    clipboard: { writeText: async () => {} },
    language: "en-US",
    languages: ["en-US"],
    platform: "MacIntel"
  },
  setInterval() {
    return 1;
  },
  setTimeout() {
    return 1;
  },
  window: { lucide: null }
};

vm.runInNewContext(
  `${testSource}\nglobalThis.__dashboardTest = { state, els, renderSourceDiagnostics, renderSourceSettings, shouldShowSourceDiagnostics };`,
  context,
  { filename: "public/app.js" }
);

const { state, els, renderSourceDiagnostics, renderSourceSettings, shouldShowSourceDiagnostics } = context.__dashboardTest;

function diagnostics(overrides = {}) {
  return {
    generatedAt: "2026-07-06T00:00:00.000Z",
    status: "partial_unsupported",
    currentUser: { name: "gerhard", home: "/Users/gerhard" },
    os: { platform: "darwin", supported: false, supportLevel: "stub" },
    candidates: [],
    connected: [],
    counts: { connected: 0, readable: 0, denied: 0, processOnly: 0, otherDashboardInstances: 0 },
    otherDashboardInstances: [],
    ...overrides
  };
}

function renderDashboardDiagnostics(payload, error = "") {
  state.auth = { authenticated: true };
  state.sourceDiagnostics = payload;
  state.sourceDiagnosticsError = error;
  renderSourceDiagnostics();
  return els.sourceDiagnosticsSection.hidden;
}

assert.equal(renderDashboardDiagnostics(diagnostics()), true, "macOS stub diagnostics should not occupy the dashboard");
assert.equal(
  renderDashboardDiagnostics(diagnostics({ status: "current_user_empty", os: { platform: "linux", supported: true, supportLevel: "full" } })),
  true,
  "empty source diagnostics should stay out of the dashboard"
);
assert.equal(
  renderDashboardDiagnostics(selfOnlyConnected),
  true,
  "healthy connected diagnostics with only this app instance should stay out of the dashboard"
);
assert.equal(
  renderDashboardDiagnostics(diagnostics({ status: "candidates_denied", candidates: [{ accessStatus: "denied", connected: false }] })),
  false,
  "denied source candidates should remain visible"
);
assert.equal(
  renderDashboardDiagnostics(diagnostics({ status: "candidates_readable_empty", candidates: [{ accessStatus: "readable", connected: false }] })),
  false,
  "readable source candidates should remain visible"
);
assert.equal(renderDashboardDiagnostics(otherInstancePayload), false, "other dashboard instances should remain visible");
assert.equal(renderDashboardDiagnostics(null, "discovery failed"), false, "discovery errors should remain visible");

state.sourceDiagnostics = diagnostics();
state.sourceDiagnosticsError = "";
renderSourceSettings();
assert.match(els.settingsSourceSummary.innerHTML, /settings\.sources\.summaryStatus/u, "settings should keep diagnostics available");
assert.equal(shouldShowSourceDiagnostics(diagnostics(), "partial_unsupported"), false);
