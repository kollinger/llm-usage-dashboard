import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

process.env.CODEX_LIVE_RATE_LIMITS = "false";

const require = createRequire(import.meta.url);
const { _test } = require("../server.js");
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const fiveHourResetSeconds = Math.floor(Date.parse("2026-07-18T18:00:00.000Z") / 1000);
const weeklyResetSeconds = Math.floor(Date.parse("2026-07-24T18:00:00.000Z") / 1000);

assertLegacyCodexWindows();
assertCodexBinaryCandidates();
assertWeeklyPrimaryCodexWindow();
assertWeeklyPrimarySparkWindow();
assertUnknownCodexWindow();
await assertCodexCardDomRendering();

function assertCodexBinaryCandidates() {
  const macCandidates = _test.codexBinaryCandidates({
    platform: "darwin",
    homeDir: "/Users/example",
    env: {}
  });
  assert.equal(macCandidates.includes("/Applications/ChatGPT.app/Contents/Resources/codex"), true);
  assert.equal(macCandidates.includes("/Applications/Codex.app/Contents/Resources/codex"), true);
  assert.equal(macCandidates.includes("/Users/example/Applications/ChatGPT.app/Contents/Resources/codex"), true);
  assert.equal(macCandidates.includes("/Users/example/Applications/Codex.app/Contents/Resources/codex"), true);
  assert.equal(macCandidates.includes("/opt/homebrew/bin/codex"), true);

  const linuxCandidates = _test.codexBinaryCandidates({
    platform: "linux",
    homeDir: "/home/example",
    env: { CODEX_BIN: "/custom/codex" }
  });
  assert.equal(linuxCandidates[0], "/custom/codex");
  assert.equal(linuxCandidates.includes("/usr/local/bin/codex"), true);
  assert.equal(linuxCandidates.includes("/home/example/.local/bin/codex"), true);

  const windowsCandidates = _test.codexBinaryCandidates({
    platform: "win32",
    homeDir: "C:\\Users\\example",
    env: { APPDATA: "C:\\Users\\example\\AppData\\Roaming" }
  });
  assert.equal(windowsCandidates.includes("C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd"), true);
  assert.equal(windowsCandidates.includes("C:\\Users\\example\\.local\\bin\\codex.exe"), true);
}

function assertLegacyCodexWindows() {
  const limits = _test.codexRateLimitsFromLive(
    {
      planType: "Pro",
      primary: {
        usedPercent: 12,
        windowDurationMins: 300,
        resetsAt: fiveHourResetSeconds
      },
      secondary: {
        usedPercent: 34,
        windowDurationMins: 10080,
        resetsAt: weeklyResetSeconds
      }
    },
    "Codex"
  );

  assert.equal(limits.planType, "Pro");
  assert.equal(limits.fiveHour.label, "5h Codex limit");
  assert.equal(limits.fiveHour.usedPercent, 12);
  assert.equal(limits.fiveHour.windowMinutes, 300);
  assert.equal(limits.fiveHour.resetsAt, "2026-07-18T18:00:00.000Z");
  assert.equal(limits.weekly.label, "Weekly Codex limit");
  assert.equal(limits.weekly.usedPercent, 34);
  assert.equal(limits.weekly.windowMinutes, 10080);
  assert.deepEqual(limits.rows.map((row) => row.key), ["fiveHour", "weekly"]);
}

function assertWeeklyPrimaryCodexWindow() {
  const limits = _test.codexRateLimitsFromLive(
    {
      primary: {
        usedPercent: 85,
        windowDurationMins: 10080,
        resetsAt: weeklyResetSeconds
      },
      secondary: null
    },
    "Codex"
  );

  assert.equal(limits.fiveHour, null);
  assert.equal(limits.weekly.label, "Weekly Codex limit");
  assert.equal(limits.weekly.usedPercent, 85);
  assert.equal(limits.weekly.remainingPercent, 15);
  assert.deepEqual(limits.rows.map((row) => row.key), ["weekly"]);

  const alerts = _test.buildNotificationAlerts(
    { hardLimitPercent: 80, pacingPercent: 90 },
    { codex: { limits } }
  );
  assert.equal(alerts[0]?.windowKey, "weekly");
  assert.equal(alerts[0]?.windowMinutes, 10080);
}

function assertWeeklyPrimarySparkWindow() {
  const limits = _test.codexSparkRateLimitsFromEvents(
    [],
    {
      primary: {
        used_percent: 9,
        window_minutes: 10080,
        resets_at: weeklyResetSeconds
      },
      secondary: null
    },
    true
  );

  assert.equal(limits.fiveHour, null);
  assert.equal(limits.weekly.label, "Weekly Codex 5.3 Spark limit");
  assert.equal(limits.weekly.usedPercent, 9);
  assert.equal(limits.weekly.windowMinutes, 10080);
  assert.deepEqual(limits.rows.map((row) => row.key), ["weekly"]);
}

function assertUnknownCodexWindow() {
  const limits = _test.codexRateLimitsFromLive(
    {
      primary: {
        usedPercent: 91,
        windowDurationMins: 1440,
        resetsAt: weeklyResetSeconds
      }
    },
    "Codex"
  );

  assert.equal(limits.fiveHour, null);
  assert.equal(limits.weekly, null);
  assert.equal(limits.rows.length, 1);
  assert.equal(limits.rows[0].key, "codexWindow1440m");
  assert.equal(limits.rows[0].label, "Codex limit (1d)");
  assert.equal(/5h|weekly|week/i.test(limits.rows[0].label), false);

  const alerts = _test.buildNotificationAlerts(
    { hardLimitPercent: 80, pacingPercent: 90 },
    { codex: { limits } }
  );
  assert.equal(alerts[0]?.windowKey, "codex_window1440m");
  assert.equal(alerts[0]?.windowMinutes, 1440);
}

async function assertCodexCardDomRendering() {
  const appPath = path.join(rootDir, "public", "app.js");
  const appSource = await readFile(appPath, "utf8");
  const code = appSource.replace("\ninit();", "\n// init disabled for Codex quota DOM test");
  assert.notEqual(code, appSource, "Codex quota DOM test must disable app bootstrap");
  const translations = JSON.parse(await readFile(path.join(rootDir, "public", "i18n", "en.json"), "utf8"));
  const resetIso = "2026-07-24T18:00:00.000Z";

  const result = JSON.parse(vm.runInNewContext(
    `${code}
state.translations = ${JSON.stringify(translations)};
state.fallbackTranslations = {};
const resetIso = ${JSON.stringify(resetIso)};
const baseCodex = {
  status: "live",
  first: { timestamp: "2026-07-10T10:00:00.000Z" },
  latest: { timestamp: "2026-07-18T10:00:00.000Z" },
  totals: {
    allTime: { totalTokens: 1000 },
    last5h: { totalTokens: 100 },
    last24h: { totalTokens: 200 },
    last7d: { totalTokens: 500 }
  },
  spark: {
    totals: {
      allTime: { totalTokens: 0 },
      last5h: { totalTokens: 0 },
      last24h: { totalTokens: 0 },
      last7d: { totalTokens: 0 }
    }
  }
};
const weeklyOnly = normalizeCodexProvider({
  ...baseCodex,
  limits: {
    fiveHour: null,
    weekly: { key: "weekly", label: "Weekly Codex limit", usedPercent: 7, remainingPercent: 93, windowMinutes: 10080, resetsAt: resetIso },
    rows: [
      { key: "weekly", label: "Weekly Codex limit", usedPercent: 7, remainingPercent: 93, windowMinutes: 10080, resetsAt: resetIso }
    ]
  }
});
const legacy = normalizeCodexProvider({
  ...baseCodex,
  limits: {
    fiveHour: { key: "fiveHour", label: "5h Codex limit", usedPercent: 12, remainingPercent: 88, windowMinutes: 300, resetsAt: "2026-07-18T18:00:00.000Z" },
    weekly: { key: "weekly", label: "Weekly Codex limit", usedPercent: 34, remainingPercent: 66, windowMinutes: 10080, resetsAt: resetIso },
    rows: [
      { key: "fiveHour", label: "5h Codex limit", usedPercent: 12, remainingPercent: 88, windowMinutes: 300, resetsAt: "2026-07-18T18:00:00.000Z" },
      { key: "weekly", label: "Weekly Codex limit", usedPercent: 34, remainingPercent: 66, windowMinutes: 10080, resetsAt: resetIso }
    ]
  }
});
const weeklyOnlyHtml = renderProvider(weeklyOnly);
const legacyHtml = renderProvider(legacy);
JSON.stringify({
  weeklyOnlyHasWeek: weeklyOnlyHtml.includes(">Week<") || weeklyOnlyHtml.includes("Week left"),
  weeklyOnlyHasFiveHourLimit: weeklyOnlyHtml.includes("5h Codex limit") || weeklyOnlyHtml.includes("5h left") || weeklyOnlyHtml.includes(">5h<"),
  legacyHasFiveHour: legacyHtml.includes("5h Codex limit") || legacyHtml.includes("5h left") || legacyHtml.includes(">5h<"),
  legacyHasWeek: legacyHtml.includes(">Week<") || legacyHtml.includes("Week left")
});`,
    createAppContext()
  ));

  assert.equal(result.weeklyOnlyHasWeek, true);
  assert.equal(result.weeklyOnlyHasFiveHourLimit, false);
  assert.equal(result.legacyHasFiveHour, true);
  assert.equal(result.legacyHasWeek, true);
}

function createAppContext() {
  const elements = new Map();
  function makeElement(id = "") {
    return {
      id,
      hidden: false,
      disabled: false,
      textContent: "",
      innerHTML: "",
      value: "",
      checked: false,
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
      removeEventListener() {},
      setAttribute() {},
      removeAttribute() {},
      toggleAttribute() {},
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      closest() {
        return null;
      },
      cloneNode() {
        return makeElement(`${id}-clone`);
      },
      getBoundingClientRect() {
        return { width: 100, height: 50, top: 0, left: 0 };
      },
      appendChild() {},
      remove() {},
      focus() {},
      showModal() {},
      close() {}
    };
  }
  function getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  }
  const document = {
    hidden: false,
    documentElement: makeElement("html"),
    body: makeElement("body"),
    getElementById,
    querySelector(selector) {
      if (selector === "main.app-shell") return getElementById("appShell");
      return makeElement(selector);
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    createElement(tag) {
      return makeElement(tag);
    }
  };
  return {
    console,
    document,
    navigator: { platform: "MacIntel", clipboard: { writeText: async () => {} } },
    window: { lucide: null, requestAnimationFrame: (fn) => fn(), Notification: undefined, focus() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setTimeout,
    clearTimeout,
    setInterval() {
      return 0;
    },
    clearInterval() {},
    URLSearchParams,
    Intl,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    Map,
    Set,
    RegExp,
    Error
  };
}
