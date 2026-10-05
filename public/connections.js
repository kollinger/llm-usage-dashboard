"use strict";

const connectionState = { selectedDevice: "all", loginTimer: null, login: null, sync: null, busy: false,
  accounts: null, provider: null, method: null, accountBusy: false, pairMode: null };
const connectionElement = (id) => document.getElementById(id);
const connectionText = (key, values) => t(`connections.${key}`, values);
const connectionJson = (body) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function selectSettingsTab(name) {
  const tabs = [...document.querySelectorAll("[data-settings-tab]")];
  if (!tabs.some((tab) => tab.dataset.settingsTab === name)) name = "accounts";
  for (const tab of tabs) {
    const active = tab.dataset.settingsTab === name;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== name; });
  const content = document.querySelector(".settings-tab-content");
  if (content) content.scrollTop = 0;
}

function connectionMessage(key) {
  const element = connectionElement("deviceSyncMessage");
  element.dataset.i18n = getPath(state.translations, key) || getPath(state.fallbackTranslations, key) ? key : "deviceSync.errors.default";
  element.textContent = t(element.dataset.i18n);
}

function accountMessage(key) {
  const element = connectionElement("accountsMessage");
  element.dataset.i18n = key;
  element.textContent = key ? t(key) : "";
}

function connectionErrorKey(code) {
  if (code === "cli_missing") return "connections.needsSetup";
  const known = ["invalid_account", "invalid_key", "permission_denied", "unsupported_key", "account_limit", "connection_unavailable", "account_storage_unavailable", "profile_remove_failed", "unsupported_platform"];
  return known.includes(code) ? `connections.errors.${code}` : "connections.failed";
}

function setupConnections() {
  connectionElement("accountsManagerBtn").addEventListener("click", () => openSettings("accounts"));
  connectionElement("installationsManagerBtn").addEventListener("click", () => openSettings("installations"));
  document.querySelector(".settings-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-settings-tab]");
    if (tab) selectSettingsTab(tab.dataset.settingsTab);
  });
  document.querySelector(".settings-tabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...document.querySelectorAll("[data-settings-tab]")];
    let index = tabs.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const direction = document.documentElement.dir === "rtl" ? -1 : 1;
    index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? direction : -direction) + tabs.length) % tabs.length;
    selectSettingsTab(tabs[index].dataset.settingsTab); tabs[index].focus();
  });
  connectionElement("settingsDialog").addEventListener("close", () => { connectionElement("accountApiKey").value = ""; });
  connectionElement("accountAddBtn").addEventListener("click", () => {
    connectionElement("accountWizard").hidden = false;
    if (!connectionState.login || !isConnectionLoginPending(connectionState.login)) showProviderChooser();
  });
  connectionElement("accountWizardClose").addEventListener("click", () => {
    connectionElement("accountWizard").hidden = true;
    connectionElement("accountApiKey").value = "";
  });
  connectionElement("accountProviderBack").addEventListener("click", showProviderChooser);
  connectionElement("accountsRefreshBtn").addEventListener("click", async () => {
    if (connectionState.accountBusy) return;
    setAccountBusy(true); accountMessage("connections.checking");
    try { connectionState.accounts = await fetchJson("/api/connections/refresh", { method: "POST" }); renderConnectionAccounts(); accountMessage(""); await loadUsage({ force: true }); }
    catch (error) { accountMessage(connectionErrorKey(error.message)); }
    finally { setAccountBusy(false); }
  });
  connectionElement("accountProviderChooser").addEventListener("click", (event) => {
    const button = event.target.closest("[data-connect-provider]");
    if (button) chooseConnectionProvider(button.dataset.connectProvider);
  });
  connectionElement("accountMethods").addEventListener("click", (event) => {
    const button = event.target.closest("[data-account-method]");
    if (button) { connectionState.method = button.dataset.accountMethod; renderConnectionMethod(); }
  });
  connectionElement("accountConnectForm").addEventListener("submit", submitConnectionAccount);
  connectionElement("accountLoginCancel").addEventListener("click", async () => {
    const login = connectionState.login;
    clearTimeout(connectionState.loginTimer);
    if (login?.id && isConnectionLoginPending(login)) await fetchJson(`/api/connections/login/${encodeURIComponent(login.id)}`, { method: "DELETE" }).catch(() => {});
    connectionState.login = null; showProviderChooser();
  });
  connectionElement("managedAccountList").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove-account]");
    if (!button || connectionState.accountBusy) return;
    setAccountBusy(true);
    try { await fetchJson(`/api/connections/${encodeURIComponent(button.dataset.removeAccount)}`, { method: "DELETE" }); await loadConnectionSettings(); await loadUsage({ force: true }); }
    catch (error) { accountMessage(connectionErrorKey(error.message)); }
    finally { setAccountBusy(false); }
  });
  connectionElement("deviceSyncEnabled").addEventListener("change", saveDeviceSyncSettings);
  connectionElement("deviceSyncName").addEventListener("change", saveDeviceSyncSettings);
  connectionElement("deviceSyncConnectBtn").addEventListener("click", () => {
    connectionElement("devicePairWizard").hidden = false;
    setPairMode(null);
  });
  connectionElement("devicePairClose").addEventListener("click", () => {
    connectionElement("devicePairWizard").hidden = true;
    connectionElement("deviceSyncCode").value = "";
  });
  connectionElement("devicePairPasteBtn").addEventListener("click", () => { setPairMode("paste"); connectionElement("deviceSyncCode").focus(); });
  connectionElement("deviceSyncInviteBtn").addEventListener("click", () => connectionAction("invite", {}, (result) => {
    setPairMode("invite"); connectionElement("deviceSyncCode").value = result.code;
    connectionMessage("deviceSync.inviteReady");
  }, { enable: true }));
  connectionElement("deviceSyncCopyBtn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(connectionElement("deviceSyncCode").value); connectionMessage("deviceSync.copied"); }
    catch { connectionElement("deviceSyncCode").select(); }
  });
  connectionElement("deviceSyncJoinBtn").addEventListener("click", () => {
    const code = connectionElement("deviceSyncCode").value.trim();
    if (!code) { connectionElement("deviceSyncCode").focus(); return; }
    connectionAction("join", { code }, async (result) => {
      connectionElement("deviceSyncCode").value = "";
      connectionElement("devicePairWizard").hidden = true;
      connectionState.selectedDevice = "all"; renderDeviceSync(result); await loadUsage({ force: true });
    }, { enable: true });
  });
  connectionElement("deviceSyncRefreshBtn").addEventListener("click", () => connectionAction("refresh", {}, async (result) => { renderDeviceSync(result); await loadUsage(); }));
  connectionElement("deviceSyncPeers").addEventListener("click", (event) => {
    const button = event.target.closest("[data-forget-device]");
    if (button) connectionAction("forget", { id: button.dataset.forgetDevice }, async (result) => { renderDeviceSync(result); await loadUsage(); });
  });
  connectionElement("deviceViewSelect").addEventListener("change", async (event) => { connectionState.selectedDevice = event.target.value; await loadUsage(); });
}

async function loadConnectionSettings() {
  const results = await Promise.allSettled([fetchJson("/api/device-sync"), fetchJson("/api/connections")]);
  if (results[0].status === "fulfilled") renderDeviceSync(results[0].value);
  if (results[1].status === "fulfilled") { connectionState.accounts = results[1].value; accountMessage(""); }
  else accountMessage(connectionErrorKey(results[1].reason?.message));
  renderConnectionAccounts();
}

function connectionProviderLabel(provider) {
  return t(`connections.providers.${provider.id}`, {}, provider.label || provider.id);
}

function renderConnectionAccounts() {
  const data = connectionState.accounts;
  if (!data) return;
  const accounts = data.accounts || [];
  connectionElement("managedAccountList").innerHTML = accounts.length ? accounts.map((account) => renderConnectedAccount(account, { controls: true })).join("") : `<p class="connection-empty">${escapeHtml(connectionText("empty"))}</p>`;
  connectionElement("accountProviderChooser").innerHTML = (data.providers || []).map((provider) => `<button class="account-provider-option" type="button" data-connect-provider="${escapeHtml(provider.id)}"><strong>${escapeHtml(connectionProviderLabel(provider))}</strong><span>${escapeHtml(connectionText(["openai", "anthropic", "moonshot"].includes(provider.id) ? "apiAccount" : "subscription"))}</span></button>`).join("");
  if (connectionState.provider) renderConnectionMethod();
  if (connectionState.login) renderConnectionLogin(connectionState.login, { poll: false });
}

function renderConnectedAccount(account, { controls = false } = {}) {
  const provider = (connectionState.accounts?.providers || []).find((item) => item.id === account.provider) || { id: account.provider };
  const status = account.status === "saved" ? "historical" : ["connected", "detected", "historical", "auth_required", "error", "unavailable", "unknown"].includes(account.status) ? account.status : "unknown";
  const metrics = (account.limits?.rows || []).map((row) => {
    const remaining = Number.isFinite(row.remainingPercent) ? row.remainingPercent : Number.isFinite(row.usedPercent) ? 100 - row.usedPercent : null;
    const label = row.label || (row.key === "fiveHour" ? t("labels.fiveHourLeft") : row.key === "weekly" ? t("labels.weekLeft") : t("gptAccounts.limit"));
    return `<span>${escapeHtml(label)}: ${escapeHtml(remaining === null ? connectionText("status.unavailable") : formatLimitRemainingPercent({ remainingPercent: remaining }))}</span>`;
  });
  if (Number.isFinite(account.tokenTotal)) metrics.push(`<span>${escapeHtml(t(account.periodDays === 7 ? "labels.tokens7d" : "summary.tokensTotal"))}: ${escapeHtml(formatTokens(account.tokenTotal))}</span>`);
  if (Number.isFinite(account.costTotal)) metrics.push(`<span>${escapeHtml(t(account.periodDays === 7 ? "labels.cost7d" : "labels.cost"))}: ${escapeHtml(formatMoney(account.costTotal, account.currency))}</span>`);
  if (Number.isFinite(account.balance)) metrics.push(`<span>${escapeHtml(connectionText("balance"))}: ${escapeHtml(formatMoney(account.balance, account.currency))}</span>`);
  if (!metrics.length) metrics.push(`<span>${escapeHtml(connectionText("status.unavailable"))}</span>`);
  return `<article class="connection-row account-manager-row"><div class="connection-row-content"><strong>${escapeHtml(account.label || connectionProviderLabel(provider))}</strong>
    <p class="settings-desc">${escapeHtml(connectionProviderLabel(provider))} · ${escapeHtml(connectionText(`status.${status}`))}${account.updatedAt ? ` · ${escapeHtml(formatRelativeUpdatedAt(account.updatedAt))}` : ""}</p>
    ${account.detailCode && connectionErrorKey(account.detailCode) !== "connections.failed" ? `<p class="settings-desc connection-account-error">${escapeHtml(t(connectionErrorKey(account.detailCode)))}</p>` : ""}
    <div class="account-inline-limits">${metrics.join("")}</div></div>
    ${controls && account.managed ? `<button class="text-button ghost" type="button" data-remove-account="${escapeHtml(account.id)}">${escapeHtml(connectionText("remove"))}</button>` : !account.managed ? `<span class="connection-badge">${escapeHtml(connectionText("automatic"))}</span>` : ""}</article>`;
}

function showProviderChooser() {
  connectionState.login = null;
  connectionState.provider = null; connectionState.method = null;
  connectionElement("accountApiKey").value = ""; connectionElement("accountConnectionLabel").value = "";
  connectionElement("accountProviderChooser").hidden = false;
  connectionElement("accountConnectForm").hidden = true; connectionElement("accountLogin").hidden = true;
  accountMessage("");
}

function chooseConnectionProvider(id) {
  const provider = (connectionState.accounts?.providers || []).find((item) => item.id === id);
  if (!provider) return;
  connectionState.provider = id;
  connectionState.method = (provider.methods || []).find((method) => method.available)?.id || provider.methods?.[0]?.id;
  connectionElement("accountProviderChooser").hidden = true;
  connectionElement("accountConnectForm").hidden = false;
  connectionElement("accountLogin").hidden = true;
  connectionElement("accountApiKey").value = "";
  renderConnectionMethod();
}

function safeConnectionUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

function renderConnectionMethod() {
  const provider = (connectionState.accounts?.providers || []).find((item) => item.id === connectionState.provider);
  if (!provider) return;
  const methods = provider.methods || [];
  const method = methods.find((item) => item.id === connectionState.method);
  const isKey = method?.type === "key";
  connectionElement("accountProviderName").textContent = connectionProviderLabel(provider);
  connectionElement("accountProviderDescription").textContent = connectionText(["openai", "anthropic"].includes(provider.id) ? "adminKeyHelp" : provider.id === "glm" ? "glmHelp" : provider.id === "claude" ? "claudeHelp" : provider.id === "kimi" ? "kimiHelp" : provider.id === "moonshot" ? "moonshotHelp" : "browserHelp");
  connectionElement("accountMethods").innerHTML = methods.length > 1 ? methods.map((item) => `<button type="button" class="text-button${item.id === method?.id ? "" : " ghost"}" aria-pressed="${item.id === method?.id}" data-account-method="${escapeHtml(item.id)}">${escapeHtml(connectionText(item.type === "key" ? "apiKey" : item.type === "local" ? "automatic" : "browser"))}</button>`).join("") : "";
  connectionElement("accountKeyFields").hidden = !isKey;
  connectionElement("accountApiKey").required = isKey;
  connectionElement("accountKeyLabel").dataset.i18n = `connections.${["openai", "anthropic"].includes(provider.id) ? "adminKey" : "apiKey"}`;
  connectionElement("accountKeyLabel").textContent = t(connectionElement("accountKeyLabel").dataset.i18n);
  connectionElement("accountRegionField").hidden = !isKey || provider.id !== "glm";
  connectionElement("accountMethodHelp").textContent = method?.available ? connectionText(isKey ? "keyPrivacy" : provider.id === "claude" ? "claudeHelp" : provider.id === "kimi" ? "kimiHelperHelp" : "browserHelp") : t(connectionErrorKey(method?.unavailableReason));
  const link = connectionElement("accountMethodHelpLink");
  const helpUrl = safeConnectionUrl(method?.helpUrl);
  link.hidden = !helpUrl; if (helpUrl) link.href = helpUrl; else link.removeAttribute("href");
  const button = connectionElement("accountConnectBtn");
  button.disabled = !method?.available || connectionState.accountBusy;
  button.textContent = connectionText(isKey ? "connect" : provider.id === "claude" ? "claudeSignIn" : "openSignIn");
}

function setAccountBusy(busy) {
  connectionState.accountBusy = busy;
  connectionElement("accountConnectForm").querySelectorAll("button, input, select").forEach((control) => { control.disabled = busy; });
  for (const id of ["accountAddBtn", "accountsRefreshBtn"]) connectionElement(id).disabled = busy;
  if (!busy) renderConnectionMethod();
}

async function submitConnectionAccount(event) {
  event.preventDefault();
  if (connectionState.accountBusy) return;
  const provider = (connectionState.accounts?.providers || []).find((item) => item.id === connectionState.provider);
  const method = provider?.methods?.find((item) => item.id === connectionState.method);
  if (!method?.available) return;
  const body = { provider: provider.id, method: method.id, label: connectionElement("accountConnectionLabel").value.trim() };
  if (method.type === "key") { body.apiKey = connectionElement("accountApiKey").value.trim(); body.region = connectionElement("accountRegion").value; }
  setAccountBusy(true); accountMessage("connections.checking");
  try {
    const result = await fetchJson("/api/connections", { method: "POST", ...connectionJson(body) });
    accountMessage("");
    if (result.login) renderConnectionLogin(result.login);
    else { connectionElement("accountWizard").hidden = true; await loadConnectionSettings(); await loadUsage({ force: true }); }
  } catch (error) { accountMessage(connectionErrorKey(error.message)); }
  finally { connectionElement("accountApiKey").value = ""; setAccountBusy(false); }
}

function isConnectionLoginPending(login) { return ["waiting", "pending", "starting", "running"].includes(login?.status); }

function renderConnectionLogin(login, { poll = true } = {}) {
  connectionState.login = login;
  if (poll) clearTimeout(connectionState.loginTimer);
  const pending = isConnectionLoginPending(login);
  connectionElement("accountConnectForm").hidden = true;
  connectionElement("accountProviderChooser").hidden = true;
  connectionElement("accountLogin").hidden = false;
  connectionElement("accountLoginMessage").textContent = pending ? connectionText(login.authUrl || login.userCode ? "loginWaiting" : "checking") : login.status === "complete" ? connectionText("loginComplete") : t(connectionErrorKey(login.error));
  const authUrl = safeConnectionUrl(login.authUrl);
  const link = connectionElement("accountLoginLink"); link.hidden = !pending || !authUrl;
  if (authUrl && pending) link.href = authUrl; else link.removeAttribute("href");
  const code = connectionElement("accountLoginCode"); code.hidden = !pending || !login.userCode; code.textContent = login.userCode || "";
  if (pending && poll) connectionState.loginTimer = setTimeout(async () => {
    try {
      const next = await fetchJson(`/api/connections/login/${encodeURIComponent(login.id)}`);
      renderConnectionLogin(next);
      if (next.status === "complete") { await loadConnectionSettings(); await loadUsage({ force: true }); }
    } catch (error) { renderConnectionLogin({ ...login, status: "failed", error: error.message }); }
  }, 2000);
}

function setPairMode(mode) {
  connectionState.pairMode = mode;
  connectionElement("devicePairCodeFields").hidden = !mode;
  connectionElement("deviceSyncCode").value = "";
  connectionElement("deviceSyncCode").readOnly = mode === "invite";
  connectionElement("deviceSyncCopyBtn").hidden = mode !== "invite";
  connectionElement("deviceSyncJoinBtn").hidden = mode !== "paste";
}

async function saveDeviceSyncSettings() {
  await connectionAction("settings", { enabled: connectionElement("deviceSyncEnabled").checked,
    name: connectionElement("deviceSyncName").value }, async (result) => {
    if (!result.enabled) connectionState.selectedDevice = "all";
    renderDeviceSync(result); await loadUsage({ force: true });
  });
}

async function connectionAction(action, body, onSuccess, { enable = false } = {}) {
  if (connectionState.busy) return;
  connectionState.busy = true; connectionMessage("deviceSync.working");
  const controls = [...connectionElement("deviceSyncSection").querySelectorAll("button, input, textarea")];
  controls.forEach((control) => { control.disabled = true; });
  try {
    if (enable && !connectionState.sync?.enabled) {
      renderDeviceSync(await fetchJson("/api/device-sync/settings", { method: "POST", ...connectionJson({ enabled: true, name: connectionElement("deviceSyncName").value }) }));
    }
    const result = await fetchJson(`/api/device-sync/${action}`, { method: "POST", ...connectionJson(body) });
    connectionMessage("deviceSync.ready"); await onSuccess?.(result);
  } catch (error) {
    connectionMessage(`deviceSync.errors.${error.message}`);
    await fetchJson("/api/device-sync").then(renderDeviceSync).catch(() => {});
  } finally {
    connectionState.busy = false; controls.forEach((control) => { control.disabled = false; }); renderDeviceSync(connectionState.sync);
  }
}

function renderConnections(usage) {
  const additionalAccounts = (usage?.connectedAccounts || []).filter((account) => account.provider !== "gpt");
  const overview = connectionElement("accountOverviewList");
  overview.querySelectorAll(".account-manager-row").forEach((row) => row.remove());
  if (additionalAccounts.length) {
    connectionElement("accountOverviewPanel").hidden = false;
    overview.insertAdjacentHTML("beforeend", additionalAccounts.map((account) => renderConnectedAccount(account)).join(""));
  }
  if (usage?.deviceSync) renderDeviceSync(usage.deviceSync);
  const coverage = usage?.syncCoverage;
  connectionElement("deviceSyncCoverage").textContent = coverage?.unavailable
    ? `${t("deviceSync.local")} · ${t("deviceSync.errors.default")}`
    : usage?.deviceSync?.error ? t("deviceSync.errors.default")
    : coverage ? t("deviceSync.coverage", { count: formatTokens(coverage.eventCount), excluded: formatTokens(coverage.excludedEvents), duplicates: formatTokens(coverage.duplicatesSkipped) })
    : t("deviceSync.local");
}

function renderDeviceSync(sync) {
  if (!sync) return;
  connectionState.sync = sync;
  connectionElement("deviceSyncEnabled").checked = sync.enabled;
  if (document.activeElement !== connectionElement("deviceSyncName")) connectionElement("deviceSyncName").value = sync.name || "";
  connectionElement("deviceSyncRefreshBtn").disabled = !sync.enabled || connectionState.busy;
  connectionElement("deviceViewControls").hidden = !sync.enabled;
  const devices = sync.devices || [];
  const peers = sync.peers || [];
  const values = ["all", "local", ...devices.map((device) => device.id)];
  if (!values.includes(connectionState.selectedDevice)) connectionState.selectedDevice = "local";
  connectionElement("deviceViewSelect").innerHTML = [
    `<option value="local">${escapeHtml(t("deviceSync.local"))}</option>`,
    `<option value="all">${escapeHtml(t("deviceSync.all"))}</option>`,
    ...devices.filter((device) => device.id !== sync.deviceId).map((device) => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.name)}</option>`)
  ].join("");
  connectionElement("deviceViewSelect").value = connectionState.selectedDevice;
  const known = new Map(devices.filter((device) => device.id !== sync.deviceId).map((device) => [device.id, device]));
  for (const peer of peers) known.set(peer.id, { ...known.get(peer.id), ...peer, paired: true });
  const local = `<article class="connection-row local-installation"><div class="connection-row-content"><strong>${escapeHtml(sync.name || t("deviceSync.local"))}</strong><p class="settings-desc">${escapeHtml(connectionText("thisInstallation"))} · ${escapeHtml(connectionText(sync.enabled ? "syncOn" : "syncOff"))}</p></div><span class="connection-badge">${escapeHtml(connectionText("local"))}</span></article>`;
  connectionElement("deviceSyncPeers").innerHTML = local + [...known.values()].map((peer) => {
    const timestamp = peer.lastSyncAt || peer.updatedAt || peer.capturedAt;
    const freshness = peer.error ? t("deviceSync.errors.peer_unreachable") : timestamp ? connectionText("lastSeen", { time: formatRelativeUpdatedAt(timestamp) }) : connectionText("waitingSync");
    return `<article class="connection-row"><div class="connection-row-content"><strong>${escapeHtml(peer.name || connectionText("installation"))}</strong><p class="settings-desc">${escapeHtml(freshness)}</p></div>
      ${peer.paired ? `<button class="text-button ghost" type="button" data-forget-device="${escapeHtml(peer.id)}">${escapeHtml(t("deviceSync.forget"))}</button>` : `<span class="connection-badge">${escapeHtml(connectionText("viaPeer"))}</span>`}</article>`;
  }).join("");
  if (sync.error && !connectionState.busy) connectionMessage(`deviceSync.errors.${sync.error}`);
}
