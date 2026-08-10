(function bootstrapTheme() {
  "use strict";

  const STORAGE_KEY = "llmUsage.theme";
  const THEME_OPTIONS = new Set(["system", "light", "dark"]);
  const THEME_COLORS = {
    light: "#f6f7f4",
    dark: "#0f1512"
  };
  const root = document.documentElement;
  const systemThemeQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  let preference = "system";

  function normalizePreference(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return THEME_OPTIONS.has(normalized) ? normalized : "system";
  }

  function readStoredPreference() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return normalizePreference(stored);
    } catch {
      // Storage can be disabled; the native or system preference still works.
    }
    return normalizePreference(window.llmUsageDashboard?.initialThemePreference);
  }

  function resolveTheme(selectedPreference = preference) {
    if (selectedPreference === "dark" || selectedPreference === "light") return selectedPreference;
    return systemThemeQuery?.matches ? "dark" : "light";
  }

  function applyTheme(selectedPreference, { persist = false, notifyNative = false } = {}) {
    preference = normalizePreference(selectedPreference);
    const resolvedTheme = resolveTheme(preference);
    root.dataset.theme = resolvedTheme;
    root.dataset.themePreference = preference;
    root.style.colorScheme = resolvedTheme;
    if (themeColorMeta) themeColorMeta.setAttribute("content", THEME_COLORS[resolvedTheme]);

    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, preference);
      } catch {
        // Keep the preference for this session if storage is unavailable.
      }
    }
    if (notifyNative) {
      Promise.resolve(window.llmUsageDashboard?.setThemePreference?.(preference)).catch(() => {});
    }

    window.dispatchEvent(new CustomEvent("llm-usage-theme-change", {
      detail: { preference, resolvedTheme }
    }));
    return resolvedTheme;
  }

  function applySystemChange() {
    if (preference === "system") applyTheme("system");
  }

  preference = readStoredPreference();
  applyTheme(preference, { notifyNative: true });

  if (typeof systemThemeQuery?.addEventListener === "function") {
    systemThemeQuery.addEventListener("change", applySystemChange);
  } else if (typeof systemThemeQuery?.addListener === "function") {
    systemThemeQuery.addListener(applySystemChange);
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    applyTheme(event.newValue || "system", { notifyNative: true });
  });
  window.llmUsageDashboard?.onSystemThemeChange?.(() => applySystemChange());

  window.llmUsageTheme = Object.freeze({
    getPreference: () => preference,
    getResolvedTheme: () => resolveTheme(preference),
    setPreference: (selectedPreference) => applyTheme(selectedPreference, {
      persist: true,
      notifyNative: true
    }),
    storageKey: STORAGE_KEY
  });
})();
