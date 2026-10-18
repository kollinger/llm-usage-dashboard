(() => {
  "use strict";

  const REFRESH_MS = 60_000;
  const PAGE_SIZE = 50;
  const panel = document.getElementById("chatUsagePanel");
  if (!panel) return;
  const view = {
    device: null, period: "all", sort: "tokens", kind: "all", provider: "all", model: "all",
    search: "", all: false, page: 0, rows: [], coverage: null, details: new Map(), expanded: new Set(),
    abort: null, detailRequests: new Map(), revision: 0, fetchedAt: 0, loading: false,
    error: false, locked: true, language: null
  };
  const text = (key, values) => t(`chatUsage.${key}`, values);
  const html = (value) => escapeHtml(String(value ?? ""));
  const count = (value) => Math.max(0, Number(value) || 0);
  const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const modelRows = (row) => Array.isArray(row?.models) ? row.models : [];
  const kindLabel = (kind) => ({ codex: "Codex", claudeCode: "Claude Code", multica: text("multica"), other: text("other") })[kind] || text("other");
  const rowTitle = (row) => row.title || row.identifier || `${text("untitled")} · ${String(row.id || "").slice(0, 8)}`;

  // Prices are an explicit catalog-date equivalent. Unknown buckets and mutable
  // model aliases cannot become a reassuring zero or a fully priced total.
  function estimateRowCost(row) {
    let usd = 0;
    let pricedTokens = 0;
    let unpricedTokens = 0;
    const models = modelRows(row);
    for (const model of models) {
      const usage = normalizeBillingTotals(model.sourceId, model);
      const normalizedTotal = Object.values(usage).reduce((sum, value) => sum + count(value), 0);
      const total = Math.max(count(model.totalTokens), normalizedTotal);
      const mutable = /(?:^|[-_:/])(?:latest|default|unknown|auto)(?:$|[-_:/])/iu.test(String(model.model || ""));
      const price = mutable ? null : pricingModelForUsageModel(model.model);
      if (!price) {
        unpricedTokens += total;
        continue;
      }
      const estimate = estimateCost(usage, price);
      usd += Number.isFinite(estimate.usd) ? estimate.usd : 0;
      const buckets = [
        [usage.inputTokens, price.inputUsd],
        [usage.cacheCreationInputTokens, price.cacheWriteUsd ?? price.inputUsd],
        [usage.cachedInputTokens, price.cachedInputUsd],
        [usage.outputTokens, price.outputUsd]
      ];
      for (const [tokens, rate] of buckets) {
        if (rate != null && Number.isFinite(Number(rate))) pricedTokens += count(tokens);
        else unpricedTokens += count(tokens);
      }
      unpricedTokens += Math.max(0, total - normalizedTotal);
    }
    if (!models.length) unpricedTokens = count(row?.usage?.totalTokens);
    else unpricedTokens += Math.max(0, count(row?.usage?.totalTokens) - pricedTokens - unpricedTokens);
    return { eur: pricedTokens ? usd / USD_PER_EUR : null, pricedTokens, unpricedTokens };
  }

  function costMarkup(cost) {
    const amount = cost.eur == null ? t("pricing.unknown") : formatEuro(cost.eur);
    return `<strong>${html(amount)}</strong>${cost.unpricedTokens ? `<small class="chat-usage-missing">${html(cost.eur == null ? t("pricing.notPriced") : t("pricing.usedModels.totalPartial"))}</small>` : ""}`;
  }

  function abortRequests() {
    view.abort?.abort();
    view.abort = null;
    for (const controller of view.detailRequests.values()) controller.abort();
    view.detailRequests.clear();
    view.revision += 1;
    view.loading = false;
  }

  function clearPrivateRows() {
    abortRequests();
    view.rows = [];
    view.coverage = null;
    view.details.clear();
    view.expanded.clear();
    view.search = "";
    view.provider = "all";
    view.model = "all";
    view.page = 0;
    view.fetchedAt = 0;
    view.error = false;
    panel.replaceChildren();
    view.language = null;
  }

  function lock() {
    clearPrivateRows();
    view.device = null;
    view.locked = true;
    panel.hidden = true;
  }

  function renderShell() {
    if (view.locked) return;
    panel.hidden = false;
    if (view.language === currentLocale() && panel.querySelector(".chat-usage-results")) return;
    view.language = currentLocale();
    panel.innerHTML = `
      <div class="panel-heading chat-usage-heading">
        <div><p class="eyebrow">${html(t("chart.eyebrow"))}</p><h2 id="chatUsageHeading">${html(text("heading"))}</h2></div>
        <div class="chat-usage-view" role="group" aria-label="${html(text("heading"))}">
          <button type="button" class="text-button ghost" data-chat-view="top">${html(text("top10"))}</button>
          <button type="button" class="text-button ghost" data-chat-view="all">${html(text("showAll"))}</button>
        </div>
      </div>
      <p class="chat-usage-description">${html(text("description"))}</p>
      <div class="chat-usage-controls">
        <label class="field chat-usage-search"><span>${html(text("search"))}</span><input type="search" data-chat-filter="search" autocomplete="off" aria-controls="chatUsageResults" value="${html(view.search)}"></label>
        <label class="field"><span>${html(text("sort"))}</span><select data-chat-filter="sort"><option value="tokens">${html(text("sortTokens"))}</option><option value="cost">${html(text("sortCost"))}</option></select></label>
        <label class="field"><span>${html(t("chart.filterBarAria"))}</span><select data-chat-filter="period">${["all", "month", "week", "today", "h24"].map((period) => `<option value="${period}">${html(t(`chart.filters.${period}`))}</option>`).join("")}</select></label>
        <label class="field"><span>${html(t("pricing.columns.source"))}</span><select data-chat-filter="kind"><option value="all">${html(text("allSources"))}</option>${["codex", "claudeCode", "multica", "other"].map((kind) => `<option value="${kind}">${html(kindLabel(kind))}</option>`).join("")}</select></label>
        <label class="field"><span>${html(t("chart.breakdown.provider"))}</span><select data-chat-filter="provider"></select></label>
        <label class="field"><span>${html(t("pricing.columns.model"))}</span><select data-chat-filter="model"></select></label>
      </div>
      <div class="chat-usage-status" role="status" aria-live="polite"></div>
      <div class="chat-usage-results" id="chatUsageResults"></div>
      <div class="chat-usage-pagination"></div>
      <div class="chat-usage-coverage"></div>
      <p class="chat-usage-note">${html(text("apiNote", { pricingDate: PRICING_DATE, fxDate: FX_DATE }))}</p>`;
    for (const name of ["sort", "period", "kind"]) panel.querySelector(`[data-chat-filter="${name}"]`).value = view[name];
  }

  function renderFilterOptions() {
    const providers = [...new Set(view.rows.flatMap((row) => row.providers || []))].sort();
    const models = [...new Set(view.rows.flatMap((row) => modelRows(row).map((model) => model.model)).filter(Boolean))].sort((a, b) => a.localeCompare(b, currentLocale()));
    const providerSelect = panel.querySelector('[data-chat-filter="provider"]');
    const modelSelect = panel.querySelector('[data-chat-filter="model"]');
    if (!providers.includes(view.provider)) view.provider = "all";
    if (!models.includes(view.model)) view.model = "all";
    providerSelect.innerHTML = `<option value="all">${html(text("allSources"))}</option>${providers.map((provider) => `<option value="${html(provider)}">${html(sourceLabel(provider))}</option>`).join("")}`;
    modelSelect.innerHTML = `<option value="all">${html(t("limits.allModels"))}</option>${models.map((model) => `<option value="${html(model)}">${html(model)}</option>`).join("")}`;
    providerSelect.value = view.provider;
    modelSelect.value = view.model;
  }

  function selectedRows() {
    const search = view.search.trim().toLocaleLowerCase(currentLocale());
    return view.rows.filter((row) => {
      if (view.kind !== "all" && row.kind !== view.kind) return false;
      if (view.provider !== "all" && !(row.providers || []).includes(view.provider)) return false;
      if (view.model !== "all" && !modelRows(row).some((model) => model.model === view.model)) return false;
      return !search || [row.title, row.identifier, row.id, ...modelRows(row).map((model) => model.model)].join(" ").toLocaleLowerCase(currentLocale()).includes(search);
    }).sort((a, b) => {
      if (view.sort === "cost") {
        const left = a.cost.eur;
        const right = b.cost.eur;
        if (left == null && right != null) return 1;
        if (right == null && left != null) return -1;
        if (left !== right) return (right || 0) - (left || 0);
      }
      return count(b.usage?.totalTokens) - count(a.usage?.totalTokens) || rowTitle(a).localeCompare(rowTitle(b), currentLocale()) || String(a.id).localeCompare(String(b.id));
    });
  }

  function dateLabel(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(currentLocale(), { dateStyle: "medium", timeStyle: "short" }).format(date) : "—";
  }

  function renderRow(row, rank) {
    const models = [...new Set(modelRows(row).map((model) => model.model))].join(" · ");
    const range = `${dateLabel(row.firstAt)} – ${dateLabel(row.lastAt)}`;
    return `<details class="chat-usage-row" data-chat-id="${html(row.id)}"${view.expanded.has(row.id) ? " open" : ""}>
      <summary class="chat-usage-row-summary">
        <span class="chat-usage-rank">${formatNumber(rank)}</span>
        <span class="chat-usage-identity"><strong dir="auto">${html(rowTitle(row))}</strong><span><span class="chat-usage-kind">${html(kindLabel(row.kind))}</span>${row.identifier && row.identifier !== row.title ? ` <bdi>${html(row.identifier)}</bdi>` : ""} <span class="chat-usage-models" dir="auto">${html(models)}</span></span></span>
        <span class="chat-usage-tokens"><strong>${html(formatNumber(row.usage?.totalTokens))}</strong><small>${html(t("chart.mode.tokens"))}</small></span>
        <span class="chat-usage-cost">${costMarkup(row.cost)}<small>${html(t("pricing.views.api"))}</small></span>
        <span class="chat-usage-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div class="chat-usage-details"><p class="chat-usage-range">${html(range)} · ${html(text("sessions", { count: formatNumber(row.sessionCount) }))} · ${html(text("events", { count: formatNumber(row.eventCount) }))}</p><div class="chat-usage-detail-body"></div></div>
    </details>`;
  }

  function renderCoverage() {
    const coverage = view.coverage;
    const target = panel.querySelector(".chat-usage-coverage");
    if (!coverage) { target.replaceChildren(); return; }
    const notes = [text("coverage", { assigned: formatNumber(coverage.assignedTokens), total: formatNumber(coverage.totalTokens) })];
    if (count(coverage.unassignedTokens)) notes.push(text("unassigned", { tokens: formatNumber(coverage.unassignedTokens) }));
    if (count(coverage.metadataUnavailableTokens)) notes.push(text("metadataMissing", { tokens: formatNumber(coverage.metadataUnavailableTokens) }));
    if (count(coverage.duplicatesSkipped)) notes.push(text("duplicates", { count: formatNumber(coverage.duplicatesSkipped) }));
    if (coverage.multicaStatus === "unavailable" || (coverage.multicaStatus === "partial" && (count(coverage.unassignedTokens) || count(coverage.metadataUnavailableTokens)))) notes.push(text("multicaIncomplete"));
    target.innerHTML = notes.map((note) => `<span>${html(note)}</span>`).join("");
  }

  function renderResults({ options = false } = {}) {
    if (view.locked) return;
    const needsShell = view.language !== currentLocale() || !panel.querySelector(".chat-usage-results");
    renderShell();
    if (options || needsShell) renderFilterOptions();
    panel.querySelectorAll("[data-chat-view]").forEach((button) => {
      const active = (button.dataset.chatView === "all") === view.all;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const filtered = selectedRows();
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    view.page = Math.min(view.page, pages - 1);
    const offset = view.all ? view.page * PAGE_SIZE : 0;
    const visible = filtered.slice(offset, offset + (view.all ? PAGE_SIZE : 10));
    const tokens = filtered.reduce((sum, row) => sum + count(row.usage?.totalTokens), 0);
    panel.querySelector(".chat-usage-status").innerHTML = view.error
      ? `<span class="chat-usage-error">${html(text("loadError"))}</span> <button type="button" class="text-button ghost" data-chat-retry>${html(text("retry"))}</button>`
      : html(view.loading && !view.rows.length ? text("loading") : text("summary", { count: formatNumber(filtered.length), tokens: formatNumber(tokens) }));
    panel.setAttribute("aria-busy", String(view.loading));
    panel.querySelector(".chat-usage-results").innerHTML = visible.length
      ? visible.map((row, index) => renderRow(row, offset + index + 1)).join("")
      : `<p class="chat-usage-empty">${html(view.loading ? text("loading") : text("empty"))}</p>`;
    panel.querySelector(".chat-usage-pagination").innerHTML = filtered.length
      ? `<span>${html(text("page", { from: formatNumber(offset + 1), to: formatNumber(offset + visible.length), total: formatNumber(filtered.length) }))}</span>${view.all && pages > 1 ? `<div><button type="button" class="text-button ghost" data-chat-page="-1"${view.page === 0 ? " disabled" : ""}>${html(text("previous"))}</button><button type="button" class="text-button ghost" data-chat-page="1"${view.page === pages - 1 ? " disabled" : ""}>${html(text("next"))}</button></div>` : ""}` : "";
    renderCoverage();
    for (const row of visible) if (view.expanded.has(row.id)) renderDetails(row.id);
  }

  function urlFor(id) {
    const query = new URLSearchParams({ device: view.device || "local", period: view.period, timeZone: timezone() });
    if (id != null) query.set("id", id);
    return `/api/chat-usage?${query}`;
  }

  async function refresh({ force = false } = {}) {
    if (view.locked || (view.loading && !force) || (!force && view.fetchedAt && Date.now() - view.fetchedAt < REFRESH_MS)) return;
    if (force) abortRequests();
    const revision = view.revision;
    const controller = new AbortController();
    view.abort = controller;
    view.loading = true;
    view.error = false;
    renderResults();
    try {
      const data = await fetchJson(urlFor(), { signal: controller.signal });
      if (controller.signal.aborted || revision !== view.revision || view.locked) return;
      view.rows = (Array.isArray(data.rows) ? data.rows : []).map((row) => ({ ...row, cost: estimateRowCost(row) }));
      view.coverage = data.coverage || null;
      view.fetchedAt = Date.now();
      view.details.clear();
      for (const controller of view.detailRequests.values()) controller.abort();
      view.detailRequests.clear();
      view.expanded = new Set([...view.expanded].filter((id) => view.rows.some((row) => row.id === id)));
    } catch (error) {
      if (controller.signal.aborted || revision !== view.revision) return;
      if (error.status === 401) { lock(); await loadAuth(); renderLocked(); return; }
      view.error = true;
      // Bound automatic retries even if the main usage endpoint polls rapidly.
      view.fetchedAt = Date.now();
    } finally {
      if (revision === view.revision && !view.locked) {
        view.loading = false;
        if (view.abort === controller) view.abort = null;
        renderResults({ options: true });
      }
    }
  }

  function normalizedUsage(row) {
    const totals = { inputTokens: 0, cacheCreationInputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    for (const model of modelRows(row)) {
      const usage = normalizeBillingTotals(model.sourceId, model);
      for (const key of Object.keys(totals)) totals[key] += count(usage[key]);
    }
    return totals;
  }

  function tokenBreakdown(row) {
    const totals = normalizedUsage(row);
    const fields = [[text("input"), totals.inputTokens], [t("tokens.cacheCreation"), totals.cacheCreationInputTokens], [t("tokens.cachedInput"), totals.cachedInputTokens], [t("tokens.output"), totals.outputTokens]];
    return `<dl class="chat-usage-buckets">${fields.map(([label, value]) => `<div><dt>${html(label)}</dt><dd>${html(formatNumber(value))}</dd></div>`).join("")}</dl>`;
  }

  function modelTable(row) {
    return `<div class="chat-usage-table-scroll"><table class="chat-usage-model-table"><thead><tr><th>${html(t("pricing.columns.model"))}</th><th>${html(t("chart.mode.tokens"))}</th><th>${html(t("pricing.views.api"))}</th></tr></thead><tbody>${modelRows(row).map((model) => {
      const cost = estimateRowCost({ models: [model], usage: model });
      return `<tr><th scope="row"><bdi>${html(model.model || t("chart.models.unknown"))}</bdi><small>${html(sourceLabel(model.sourceId || ""))}</small></th><td>${html(formatNumber(model.totalTokens))}</td><td>${costMarkup(cost)}${cost.unpricedTokens ? `<small>${html(text("unpriced", { tokens: formatNumber(cost.unpricedTokens) }))}</small>` : ""}</td></tr>`;
    }).join("")}</tbody></table></div>`;
  }

  async function renderDetails(id) {
    const element = [...panel.querySelectorAll(".chat-usage-row")].find((row) => row.dataset.chatId === id);
    if (!element?.open || view.locked) return;
    const target = element.querySelector(".chat-usage-detail-body");
    const cached = view.details.get(id);
    if (cached?.error) {
      target.innerHTML = `<p class="chat-usage-error">${html(text("detailError"))} <button type="button" class="text-button ghost" data-chat-detail-retry="${html(id)}">${html(text("retry"))}</button></p>`;
      return;
    }
    if (cached) {
      const cost = estimateRowCost(cached);
      const runs = cached.runs || [];
      target.innerHTML = `${tokenBreakdown(cached)}<p class="chat-usage-note">${html(text("reasoningNote"))}</p>${cost.unpricedTokens ? `<p class="chat-usage-missing">${html(text("unpriced", { tokens: formatNumber(cost.unpricedTokens) }))}</p>` : ""}${modelTable(cached)}<p class="chat-usage-range">${html(text("runs", { count: formatNumber(runs.length) }))}</p><div class="chat-usage-runs">${runs.map((run) => `<details class="chat-usage-run"><summary><span dir="auto">${html(run.title || run.id || text("untitled"))}</span><span>${html(sourceLabel(run.providerId || ""))} · ${html(formatNumber(run.usage?.totalTokens))} ${html(t("chart.mode.tokens"))}</span></summary><p class="chat-usage-range">${html(dateLabel(run.firstAt))} – ${html(dateLabel(run.lastAt))} · ${html(text("events", { count: formatNumber(run.eventCount) }))}</p>${tokenBreakdown(run)}${modelTable(run)}</details>`).join("")}</div>`;
      return;
    }
    target.innerHTML = `<p class="chat-usage-note">${html(text("loading"))}</p>`;
    if (view.detailRequests.has(id)) return;
    const controller = new AbortController();
    const revision = view.revision;
    view.detailRequests.set(id, controller);
    try {
      const data = await fetchJson(urlFor(id), { signal: controller.signal });
      if (controller.signal.aborted || revision !== view.revision || view.locked) return;
      if (!data.row) throw new Error("Missing chat detail");
      view.details.set(id, data.row);
    } catch (error) {
      if (controller.signal.aborted || revision !== view.revision) return;
      if (error.status === 401) { lock(); await loadAuth(); renderLocked(); return; }
      view.details.set(id, { error: true });
    } finally {
      if (view.detailRequests.get(id) === controller) view.detailRequests.delete(id);
      if (revision === view.revision && !view.locked) void renderDetails(id);
    }
  }

  function sync({ device, authenticated = true, force = false } = {}) {
    if (!authenticated) { lock(); return; }
    if (view.device !== device) {
      clearPrivateRows();
      view.device = device;
    }
    view.locked = false;
    const languageChanged = view.language !== currentLocale();
    if (languageChanged) renderResults({ options: true });
    void refresh({ force });
  }

  panel.addEventListener("input", (event) => {
    if (event.target.dataset.chatFilter !== "search") return;
    view.search = event.target.value;
    view.page = 0;
    renderResults();
  });
  panel.addEventListener("change", (event) => {
    const filter = event.target.dataset.chatFilter;
    if (!["sort", "period", "kind", "provider", "model"].includes(filter)) return;
    view[filter] = event.target.value;
    view.page = 0;
    if (filter === "period") {
      abortRequests();
      view.rows = [];
      view.coverage = null;
      view.details.clear();
      view.expanded.clear();
      view.fetchedAt = 0;
      void refresh({ force: true });
    } else renderResults();
  });
  panel.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.chatView) {
      view.all = button.dataset.chatView === "all";
      view.page = 0;
      renderResults();
    } else if (button.hasAttribute("data-chat-page")) {
      view.page += Number(button.dataset.chatPage);
      renderResults();
      panel.querySelector(".chat-usage-results")?.scrollIntoView({ block: "nearest" });
    } else if (button.hasAttribute("data-chat-retry")) void refresh({ force: true });
    else if (button.dataset.chatDetailRetry) {
      view.details.delete(button.dataset.chatDetailRetry);
      void renderDetails(button.dataset.chatDetailRetry);
    }
  });
  panel.addEventListener("toggle", (event) => {
    if (!event.target.matches(".chat-usage-row")) return;
    const id = event.target.dataset.chatId;
    if (event.target.open) { view.expanded.add(id); void renderDetails(id); }
    else view.expanded.delete(id);
  }, true);

  window.ChatUsagePanel = { sync, lock, estimateRowCost };
})();
