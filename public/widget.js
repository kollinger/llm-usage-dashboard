(function desktopWidget() {
  "use strict";
  const bridge = window.llmUsageWidget;
  const languages = ["ar", "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "ga", "hr", "hu", "it", "lt", "lv", "mt", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "zh"];
  const providerNames = { gpt: "ChatGPT / Codex", claude: "Claude Code", kimi: "Kimi Code", glm: "GLM / Z.AI",
    openai: "OpenAI API", anthropic: "Anthropic API", moonshot: "Moonshot API", copilot: "GitHub Copilot", gemini: "Gemini CLI" };
  const el = (id) => document.getElementById(id);
  const list = el("widgetList");
  const textAt = (object, key) => key.split(".").reduce((value, part) => value?.[part], object);
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const languageCode = (value) => languages.find((code) => code === String(value || "").toLowerCase().split("-")[0]);
  let preferences = { favorites: [], view: "all", provider: "all", scale: 1 };
  let nativeState = {}, dictionary = {}, fallback = {}, language = "en", snapshot = null;
  let timer = null, request = null, stopped = false, failed = false, authRequired = false, languageRequest = 0;
  const t = (key, values = {}) => String(textAt(dictionary, key) ?? textAt(fallback, key) ?? "")
    .replace(/\{([^}]+)\}/g, (_match, name) => String(values[name] ?? ""));
  const number = (value, maximumFractionDigits = 0) => new Intl.NumberFormat(language, { maximumFractionDigits }).format(value);
  const date = (value) => {
    if (!value || !Number.isFinite(Date.parse(value))) return t("widget.unavailable");
    return new Intl.DateTimeFormat(language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  };
  function savePreferences() {
    bridge?.savePreferences(preferences).catch(() => { failed = true; render(); });
  }
  async function loadLanguage(value) {
    const sequence = ++languageRequest;
    const code = languageCode(value) || "en";
    const english = await fetch("/i18n/en.json").then((response) => { if (!response.ok) throw new Error(); return response.json(); });
    const translated = code === "en" ? english : await fetch(`/i18n/${code}.json`)
      .then((response) => { if (!response.ok) throw new Error(); return response.json(); }).catch(() => english);
    if (sequence !== languageRequest || stopped) return;
    fallback = english; dictionary = translated; language = code;
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    document.title = t("widget.title");
    document.querySelectorAll("[data-widget-text]").forEach((element) => { element.textContent = t(element.dataset.widgetText); });
    document.querySelectorAll("[data-widget-label]").forEach((element) => {
      const label = t(element.dataset.widgetLabel); element.setAttribute("aria-label", label); element.title = label;
    });
    render();
  }
  function windowLabel(window, provider) {
    if (window.key === "fiveHour" || window.windowMinutes === 300) return t("limits.fiveHour");
    if (window.key === "weekly" || window.key === "allModels" || window.windowMinutes === 10080) {
      const period = t("limits.weekly");
      if (provider !== "claude") return period;
      const scopeKey = window.key === "weekly" || window.key === "allModels" ? "allModels" :
        window.key === "sonnetOnly" ? "sonnetOnly" : window.key === "claudeDesign" ? "claudeDesign" : null;
      const scope = scopeKey ? t(`limits.${scopeKey}`) : window.label || t("limits.default");
      return t("widget.scopedPeriod", { scope, period });
    }
    return window.label || (window.windowMinutes ? t("widget.minutes", { minutes: number(window.windowMinutes) }) : t("limits.default"));
  }
  function renderWindow(window, provider) {
    const remaining = typeof window.remainingPercent === "number" && Number.isFinite(window.remainingPercent) ? window.remainingPercent : null;
    const stale = remaining !== null && (failed || window.status === "stale" || !window.measuredAt ||
      Date.now() - Date.parse(window.measuredAt) > (snapshot?.staleAfterMs || 900_000) ||
      (window.resetsAt && Date.parse(window.resetsAt) <= Date.now()));
    const status = remaining === null ? "unavailable" : stale ? "stale" : "current";
    const label = windowLabel(window, provider);
    const value = remaining === null ? "—" : t("limits.leftValue", { percent: number(remaining, 1) });
    const reset = t("limits.resetPrefix", { time: date(window.resetsAt) });
    const qualityKey = { measured: "qualityMeasured", calculated_from_logs: "qualityCalculated", estimated: "qualityEstimated" }[window.quality] || "unavailable";
    const freshness = stale ? t("widget.stale", { time: date(window.measuredAt) }) : t(`widget.${qualityKey}`);
    return `<div class="widget-window" data-status="${status}" title="${escape(t("widget.updated", { time: date(window.measuredAt) }))}">
      <div class="widget-window-heading"><span class="widget-window-label" title="${escape(label)}">${escape(label)}</span><strong class="widget-window-value">${escape(value)}</strong></div>
      ${remaining === null ? "" : `<div class="widget-track" role="meter" aria-label="${escape(t("limits.freeLabel", { label }))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${remaining}"><span style="width:${remaining}%"></span></div>`}
      <div class="widget-reset">${escape(reset)}</div><div class="widget-quality${stale ? " widget-stale" : ""}">${escape(freshness)}</div>
    </div>`;
  }
  function renderAccount(account) {
    const favorite = preferences.favorites.includes(account.id);
    const label = account.labelIndex ? `${account.label} · ${number(account.labelIndex)}` : account.label;
    const action = t(favorite ? "widget.removeFavorite" : "widget.addFavorite", { name: label });
    const sources = (account.sources || []).map((source) => ({ codex: "Codex", openCode: "OpenCode", local: t("widget.localSource") }[source])).filter(Boolean).join(" · ");
    return `<article class="widget-account" role="listitem" data-account="${escape(account.id)}">
      <button class="widget-star" data-favorite="${escape(account.id)}" type="button" aria-pressed="${favorite}" aria-label="${escape(action)}" title="${escape(action)}">${favorite ? "★" : "☆"}</button>
      <div class="widget-identity"><div class="widget-name-line" title="${escape(label)}"><bdi class="widget-name">${escape(account.label)}</bdi>${account.labelIndex ? `<span class="widget-number">${escape(number(account.labelIndex))}</span>` : ""}</div><span class="widget-source" title="${escape(providerNames[account.provider])}">${escape(sources || providerNames[account.provider])}</span></div>
      ${account.windows?.length ? `<div class="widget-windows">${account.windows.map((window) => renderWindow(window, account.provider)).join("")}</div>` : `<p class="widget-missing">${escape(t("widget.noQuota"))}</p>`}
    </article>`;
  }
  function render() {
    if (!Object.keys(fallback).length) return;
    const top = list.scrollTop;
    const focused = document.activeElement?.dataset.favorite;
    const accounts = snapshot?.accounts || [];
    const shown = accounts.filter((account) => (preferences.provider === "all" || preferences.provider === account.provider) &&
      (preferences.view === "all" || preferences.favorites.includes(account.id)));
    const groups = [...new Set(shown.map((account) => account.provider))];
    const favoriteSet = new Set(preferences.favorites);
    list.innerHTML = groups.length ? groups.map((provider) => {
      const items = shown.filter((account) => account.provider === provider).sort((a, b) =>
        Number(favoriteSet.has(b.id)) - Number(favoriteSet.has(a.id)));
      return `<section class="widget-group"><h2>${escape(providerNames[provider])}</h2><div role="list">${items.map(renderAccount).join("")}</div></section>`;
    }).join("") : `<div class="widget-empty"><p>${escape(t(!snapshot ? "widget.loading" : accounts.length ? "widget.emptyFiltered" : "widget.empty"))}</p></div>`;
    list.scrollTop = top;
    if (focused) {
      const target = [...list.querySelectorAll("[data-favorite]")].find((element) => element.dataset.favorite === focused);
      (target || list).focus({ preventScroll: true });
    }
    const providers = [...new Set(accounts.map((account) => account.provider))];
    if (preferences.provider !== "all" && !providers.includes(preferences.provider)) providers.push(preferences.provider);
    el("widgetProvider").innerHTML = `<option value="all">${escape(t("widget.allProviders"))}</option>` + providers.map((provider) =>
      `<option value="${escape(provider)}">${escape(providerNames[provider])}</option>`).join("");
    el("widgetProvider").value = preferences.provider;
    el("widgetScale").value = String(preferences.scale);
    document.documentElement.style.fontSize = `${14 * preferences.scale}px`;
    el("widgetAll").setAttribute("aria-pressed", String(preferences.view === "all"));
    el("widgetFavorites").setAttribute("aria-pressed", String(preferences.view === "favorites"));
    el("widgetCount").textContent = t("widget.count", { shown: number(shown.length), total: number(accounts.length) });
    const pin = el("widgetPin");
    pin.hidden = !nativeState.pinSupported;
    pin.setAttribute("aria-pressed", String(Boolean(nativeState.pinned)));
    pin.setAttribute("aria-label", t(nativeState.pinned ? "widget.unpin" : "widget.pin"));
    pin.title = pin.getAttribute("aria-label");
    el("widgetWayland").hidden = !nativeState.wayland;
    el("widgetNotice").hidden = !failed && !authRequired;
    el("widgetNotice").textContent = t(authRequired ? "widget.authRequired" : "widget.error");
  }
  async function refresh() {
    if (stopped || request) return;
    clearTimeout(timer); timer = null;
    request = new AbortController();
    const timeout = setTimeout(() => request?.abort(), 90_000);
    el("widgetRefresh").disabled = true;
    list.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/api/desktop-widget", { cache: "no-store", signal: request.signal });
      if (response.status === 401) { snapshot = null; authRequired = true; throw new Error(); }
      if (!response.ok) throw new Error();
      snapshot = await response.json(); failed = false; authRequired = false;
    } catch { if (!stopped) failed = true; }
    finally {
      clearTimeout(timeout); request = null;
      el("widgetRefresh").disabled = false; list.setAttribute("aria-busy", "false");
      if (!stopped) { render(); timer = setTimeout(refresh, 60_000); }
    }
  }
  const dashboard = (target) => {
    if (bridge) bridge.openDashboard(target).catch(() => { failed = true; render(); });
    else location.assign("/");
  };
  el("widgetDashboard").addEventListener("click", () => dashboard("dashboard"));
  el("widgetAccounts").addEventListener("click", () => dashboard("accounts"));
  el("widgetRefresh").addEventListener("click", refresh);
  el("widgetPin").addEventListener("click", async () => {
    const button = el("widgetPin");
    button.disabled = true;
    try { nativeState = await bridge.setPinned(!nativeState.pinned); }
    catch { failed = true; }
    finally { render(); button.disabled = false; }
  });
  for (const [id, view] of [["widgetAll", "all"], ["widgetFavorites", "favorites"]]) el(id).addEventListener("click", () => {
    preferences.view = view; list.scrollTop = 0; savePreferences(); render();
  });
  el("widgetProvider").addEventListener("change", (event) => { preferences.provider = event.target.value; list.scrollTop = 0; savePreferences(); render(); });
  el("widgetScale").addEventListener("change", (event) => { preferences.scale = Number(event.target.value); savePreferences(); render(); });
  list.addEventListener("click", (event) => {
    const star = event.target.closest("[data-favorite]");
    if (!star) return;
    const id = star.dataset.favorite;
    preferences.favorites = preferences.favorites.includes(id) ? preferences.favorites.filter((value) => value !== id) : [...preferences.favorites, id];
    savePreferences(); render();
  });
  const removeAppearance = bridge?.onAppearance(({ theme, language: value }) => {
    if (theme) window.llmUsageTheme?.setPreference(theme);
    if (value && value !== language) loadLanguage(value).catch(() => { failed = true; render(); });
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "llmUsage.language" && event.newValue) loadLanguage(event.newValue).catch(() => {});
  });
  window.addEventListener("pagehide", () => { stopped = true; clearTimeout(timer); request?.abort(); removeAppearance?.(); }, { once: true });
  (async () => {
    nativeState = await bridge?.getState().catch(() => ({})) || {};
    if (nativeState.preferences) preferences = nativeState.preferences;
    let stored;
    try { stored = localStorage.getItem("llmUsage.language"); } catch { /* Use native or browser language. */ }
    await loadLanguage(window.llmUsageDashboard?.initialLanguagePreference || stored || navigator.language);
    await refresh();
  })().catch(() => { failed = true; render(); });
})();
