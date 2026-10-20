// Shared by the dashboard, compact window and generated Plasma package.
// Keep this source compatible with both browser JavaScript and Qt's JS imports.
var providerPalette = Object.freeze({
  codex: "#23745c", openCode: "#316f8f", codexSpark: "#5b6ee1", copilot: "#6f42c1",
  claudeCode: "#d55e00", anthropic: "#8d5d3b", openai: "#2e6ea6", gemini: "#b94e5c",
  kimi: "#227eaa", glm: "#48505a", ollama: "#4f6d2f", minimax: "#2459d8",
  deepseek: "#4d63d8", alibaba: "#d86a1d", xai: "#111827", mistral: "#c76619", stepfun: "#1e7c75"
});
var providerColorAliases = Object.freeze({ gpt: "codex", claude: "claudeCode", moonshot: "kimi", zai: "glm", local: "codex" });

function providerAccent(provider) {
  var key = Object.prototype.hasOwnProperty.call(providerColorAliases, provider) ? providerColorAliases[provider] : provider;
  return Object.prototype.hasOwnProperty.call(providerPalette, key) ? providerPalette[key] : "#697078";
}

function colorChannels(hex) {
  return [1, 3, 5].map(function(offset) { return parseInt(hex.slice(offset, offset + 2), 16); });
}

function colorLuminance(channels) {
  var linear = channels.map(function(channel) {
    var value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

// Preserve the dashboard hue, adjusting only when the actual meter background
// needs more contrast. Both renderers use the same 3:1 non-text contrast floor.
function quotaAccent(provider, background) {
  var accent = providerAccent(provider);
  if (typeof background !== "string" || !/^#[0-9a-f]{6}$/i.test(background)) return accent;
  var channels = colorChannels(accent), base = colorLuminance(colorChannels(background));
  var endpoint = base > 0.179 ? 0 : 255;
  for (var step = 0; step <= 100; step++) {
    var mixed = channels.map(function(channel) { return Math.round(channel + (endpoint - channel) * step / 100); });
    var light = colorLuminance(mixed);
    if ((Math.max(light, base) + 0.05) / (Math.min(light, base) + 0.05) >= 3.1) {
      return "#" + mixed.map(function(channel) { return ("0" + channel.toString(16)).slice(-2); }).join("");
    }
  }
  return accent;
}

if (typeof window !== "undefined") window.llmUsageProviderColors = Object.freeze({ accent: providerAccent, quotaAccent: quotaAccent });
if (typeof module !== "undefined") module.exports = Object.freeze({ accent: providerAccent, quotaAccent: quotaAccent });
