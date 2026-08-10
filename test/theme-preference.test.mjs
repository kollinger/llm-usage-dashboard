import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapSource = fs.readFileSync(path.join(repoRoot, "public", "theme-bootstrap.js"), "utf8");

function createThemeHarness({ storedPreference = null, nativePreference = "system", systemDark = false } = {}) {
  const storage = new Map();
  if (storedPreference !== null) storage.set("llmUsage.theme", storedPreference);
  const windowListeners = new Map();
  const mediaListeners = new Set();
  const nativeCalls = [];
  const events = [];
  const root = { dataset: {}, style: {} };
  const themeColor = {
    content: "#f6f7f4",
    setAttribute(name, value) {
      if (name === "content") this.content = value;
    }
  };
  let nativeThemeListener = null;
  const media = {
    matches: systemDark,
    addEventListener(type, listener) {
      if (type === "change") mediaListeners.add(listener);
    },
    setDark(value) {
      this.matches = Boolean(value);
      for (const listener of mediaListeners) listener({ matches: this.matches });
    }
  };
  const window = {
    matchMedia: () => media,
    llmUsageDashboard: {
      initialThemePreference: nativePreference,
      setThemePreference(preference) {
        nativeCalls.push(preference);
        return Promise.resolve({ preference });
      },
      onSystemThemeChange(listener) {
        nativeThemeListener = listener;
      }
    },
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    dispatchEvent(event) {
      events.push(event);
      for (const listener of windowListeners.get(event.type) || []) listener(event);
      return true;
    }
  };
  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const context = vm.createContext({
    CustomEvent,
    Promise,
    Set,
    String,
    document: {
      documentElement: root,
      querySelector: (selector) => selector === 'meta[name="theme-color"]' ? themeColor : null
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value))
    },
    window
  });
  vm.runInContext(bootstrapSource, context, { filename: "theme-bootstrap.js" });
  return {
    events,
    media,
    nativeCalls,
    root,
    storage,
    themeColor,
    theme: window.llmUsageTheme,
    dispatchStorage(newValue) {
      window.dispatchEvent({ type: "storage", key: "llmUsage.theme", newValue });
    },
    dispatchNativeThemeChange() {
      nativeThemeListener?.({ resolvedTheme: media.matches ? "dark" : "light" });
    }
  };
}

{
  const harness = createThemeHarness({ storedPreference: "dark", systemDark: false });
  assert.equal(harness.theme.getPreference(), "dark");
  assert.equal(harness.theme.getResolvedTheme(), "dark");
  assert.equal(harness.root.dataset.theme, "dark");
  assert.equal(harness.root.dataset.themePreference, "dark");
  assert.equal(harness.root.style.colorScheme, "dark");
  assert.equal(harness.themeColor.content, "#0f1512");
  assert.deepEqual(harness.nativeCalls, ["dark"]);

  harness.theme.setPreference("light");
  assert.equal(harness.storage.get("llmUsage.theme"), "light");
  assert.equal(harness.root.dataset.theme, "light");
  assert.equal(harness.themeColor.content, "#f6f7f4");
  assert.deepEqual(harness.nativeCalls, ["dark", "light"]);
}

{
  const harness = createThemeHarness({ systemDark: true });
  assert.equal(harness.theme.getPreference(), "system");
  assert.equal(harness.root.dataset.theme, "dark");

  harness.media.setDark(false);
  assert.equal(harness.root.dataset.theme, "light");
  harness.media.setDark(true);
  assert.equal(harness.root.dataset.theme, "dark");

  harness.theme.setPreference("light");
  harness.media.setDark(false);
  harness.media.setDark(true);
  assert.equal(harness.root.dataset.theme, "light", "manual selection must ignore system changes");

  harness.dispatchStorage("dark");
  assert.equal(harness.theme.getPreference(), "dark");
  assert.equal(harness.root.dataset.theme, "dark");
}

{
  const harness = createThemeHarness({ nativePreference: "dark", systemDark: false });
  assert.equal(harness.theme.getPreference(), "dark", "Electron preference seeds an empty renderer store");
  harness.dispatchNativeThemeChange();
  assert.equal(harness.root.dataset.theme, "dark", "native system events do not override a manual theme");
}

const indexHtml = fs.readFileSync(path.join(repoRoot, "public", "index.html"), "utf8");
assert.ok(
  indexHtml.indexOf('src="/theme-bootstrap.js"') < indexHtml.indexOf('rel="stylesheet"'),
  "theme bootstrap must run before the stylesheet and first visible render"
);

const styles = fs.readFileSync(path.join(repoRoot, "public", "styles.css"), "utf8");
assert.match(styles, /:root\[data-theme="dark"\]/);
assert.match(styles, /--bg:\s*#0f1512/);
assert.match(styles, /\.modal\s*\{[^}]*background:\s*var\(--panel\)/s);

const electronMain = fs.readFileSync(path.join(repoRoot, "electron", "main.js"), "utf8");
assert.match(electronMain, /additionalArguments:\s*\[`--llm-usage-theme=\$\{themePreference\}`\]/);
assert.match(electronMain, /backgroundColor:\s*THEME_BACKGROUND_COLORS\[resolvedTheme\]/);

const i18nDir = path.join(repoRoot, "public", "i18n");
for (const file of fs.readdirSync(i18nDir).filter((name) => name.endsWith(".json"))) {
  const translations = JSON.parse(fs.readFileSync(path.join(i18nDir, file), "utf8"));
  for (const key of ["label", "system", "light", "dark"]) {
    assert.equal(typeof translations.settings?.theme?.[key], "string", `${file} is missing settings.theme.${key}`);
    assert.ok(translations.settings.theme[key].trim(), `${file} has an empty settings.theme.${key}`);
  }
}

console.log("theme preference tests passed");
