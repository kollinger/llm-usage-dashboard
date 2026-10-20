import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const colors = require("../public/provider-colors");
const { PROVIDERS } = require("../lib/desktop-widget");
const { contrastRatio } = require("./fixtures/color-contrast.cjs");
const source = await readFile(new URL("../public/provider-colors.js", import.meta.url), "utf8");
const browser = vm.createContext({ window: {} });
vm.runInContext(source, browser);
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = app.indexOf("const providerMeta = {");
const end = app.indexOf("\nconst providerBrandAliases", start);
vm.runInContext(app.slice(start, end) + "\nwindow.metadata = providerMeta; window.brands = providerBrandMeta;", browser);
const baseline = { codex: "#23745c", openCode: "#316f8f", codexSpark: "#5b6ee1", copilot: "#6f42c1",
  claudeCode: "#d55e00", anthropic: "#8d5d3b", openai: "#2e6ea6", gemini: "#b94e5c",
  kimi: "#227eaa", glm: "#48505a", ollama: "#4f6d2f" };
for (const [provider, expected] of Object.entries(baseline)) {
  assert.equal(colors.accent(provider), expected, `${provider}: preserve existing dashboard palette`);
  assert.equal(browser.window.metadata[provider].accent, expected);
}
for (const [widget, dashboard] of Object.entries({ gpt: "codex", claude: "claudeCode", moonshot: "kimi", zai: "glm", local: "codex" })) {
  assert.equal(colors.accent(widget), colors.accent(dashboard), widget);
}
for (const provider of Object.keys(PROVIDERS)) assert.notEqual(colors.accent(provider), colors.accent("unknown"), provider);
for (const provider of ["unknown", "constructor", "__proto__", "toString", "Claude Team", '<script>', null, undefined, ""]) {
  assert.equal(colors.accent(provider), "#697078", "only exact stable IDs establish a provider colour");
}
for (const provider of [...Object.keys(browser.window.brands), ...Object.keys(PROVIDERS), "unknown"]) {
  assert.match(colors.accent(provider), /^#[0-9a-f]{6}$/);
  for (const background of ["#e9eee9", "#2d3933", "#eff0f1", "#232629", "#000000", "#ffffff", "#777777"]) {
    const accent = colors.quotaAccent(provider, background);
    assert(contrastRatio(accent, background) >= 3, `${provider}/${background}: meter contrast`);
    assert.equal(browser.window.llmUsageProviderColors.quotaAccent(provider, background), accent, "browser/CommonJS parity");
  }
}
for (const provider of ["gpt", "claude", "kimi"]) {
  assert.equal(colors.quotaAccent(provider, "#e9eee9"), colors.accent(provider), "core light-theme hues stay exact");
}
for (const background of [undefined, null, "", "invalid", "#fff", "#ffffffff"]) {
  assert.equal(colors.quotaAccent("claude", background), "#d55e00", "invalid background has a safe palette fallback");
}
for (const [file, consumer] of [["index.html", "app.js"], ["widget.html", "widget.js"]]) {
  const html = await readFile(new URL(`../public/${file}`, import.meta.url), "utf8");
  assert(html.indexOf('src="/provider-colors.js"') < html.indexOf(`src="/${consumer}"`), "shared source loads before its consumer");
}
console.log("Provider colours: preserved dashboard palette, all widget IDs, exact aliases, safe fallback, browser parity and light/dark contrast passed.");
