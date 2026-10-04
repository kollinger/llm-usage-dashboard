"use strict";

const connectionState = { selectedDevice: "all", loginTimer: null, sync: null, busy: false };
const connectionElement = (id) => document.getElementById(id);

function connectionMessage(key) {
  const element = connectionElement("deviceSyncMessage");
  element.dataset.i18n = getPath(state.translations, key) || getPath(state.fallbackTranslations, key) ? key : "deviceSync.errors.default";
  element.textContent = t(element.dataset.i18n);
}

function setupConnections() {
  connectionElement("gptAccountAddBtn").addEventListener("click", async () => {
    const button = connectionElement("gptAccountAddBtn");
    button.disabled = true;
    try { renderAccountLogin(await fetchJson("/api/gpt-accounts/login", { method: "POST" })); }
    catch { renderAccountLogin({ status: "failed" }); }
    finally { button.disabled = !connectionElement("gptAccountLoginLink").hidden; }
  });
  connectionElement("gptAccountLoginCancel").addEventListener("click", async () => {
    await fetchJson("/api/gpt-accounts/login", { method: "DELETE" }).catch(() => {});
    clearTimeout(connectionState.loginTimer);
    connectionElement("gptAccountLogin").hidden = true;
  });
  connectionElement("deviceSyncEnabled").addEventListener("change", saveDeviceSyncSettings);
  connectionElement("deviceSyncName").addEventListener("change", saveDeviceSyncSettings);
  connectionElement("deviceSyncInviteBtn").addEventListener("click", () => connectionAction("invite", {}, (result) => {
    connectionElement("deviceSyncCode").value = result.code;
    connectionMessage("deviceSync.inviteReady");
  }));
  connectionElement("deviceSyncCopyBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(connectionElement("deviceSyncCode").value);
      connectionMessage("deviceSync.copied");
    } catch { connectionElement("deviceSyncCode").select(); }
  });
  connectionElement("deviceSyncJoinBtn").addEventListener("click", () => connectionAction("join", { code: connectionElement("deviceSyncCode").value.trim() }, async (result) => {
    connectionElement("deviceSyncCode").value = "";
    connectionState.selectedDevice = "all";
    renderDeviceSync(result);
    await loadUsage({ force: true });
  }));
  connectionElement("deviceSyncRefreshBtn").addEventListener("click", () => connectionAction("refresh", {}, async (result) => { renderDeviceSync(result); await loadUsage(); }));
  connectionElement("deviceSyncPeers").addEventListener("click", (event) => {
    const button = event.target.closest("[data-forget-device]");
    if (button) connectionAction("forget", { id: button.dataset.forgetDevice }, async (result) => { renderDeviceSync(result); await loadUsage(); });
  });
  connectionElement("gptAccountProfiles").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove-profile]");
    if (!button) return;
    button.disabled = true;
    try {
      await fetchJson(`/api/gpt-accounts/profiles/${encodeURIComponent(button.dataset.removeProfile)}`, { method: "DELETE" });
      await loadConnectionSettings(); await loadUsage({ force: true });
    } catch { renderAccountLogin({ status: "failed" }); }
    finally { button.disabled = false; }
  });
  connectionElement("deviceViewSelect").addEventListener("change", async (event) => {
    connectionState.selectedDevice = event.target.value;
    await loadUsage();
  });
}

async function loadConnectionSettings() {
  const results = await Promise.allSettled([
    fetchJson("/api/device-sync"), fetchJson("/api/gpt-accounts/login"), fetchJson("/api/gpt-accounts/profiles")
  ]);
  if (results[0].status === "fulfilled") renderDeviceSync(results[0].value);
  if (results[1].status === "fulfilled") renderAccountLogin(results[1].value);
  if (results[2].status === "fulfilled") {
    connectionElement("gptAccountProfiles").innerHTML = results[2].value.profiles.map((profile) => `
      <div class="connection-row"><span>${escapeHtml(profile.label)}</span>
        <button class="text-button ghost" type="button" data-remove-profile="${escapeHtml(profile.id)}">${escapeHtml(t("gptAccounts.removeLogin"))}</button></div>`).join("");
  }
}

function renderAccountLogin(login) {
  clearTimeout(connectionState.loginTimer);
  const container = connectionElement("gptAccountLogin");
  container.hidden = login.status === "idle";
  const key = login.status === "complete" ? "complete" : login.status === "failed" ? "failed" : "waiting";
  connectionElement("gptAccountLoginMessage").dataset.i18n = `gptAccounts.login.${key}`;
  connectionElement("gptAccountLoginMessage").textContent = t(`gptAccounts.login.${key}`);
  const link = connectionElement("gptAccountLoginLink");
  link.hidden = !login.authUrl;
  if (login.authUrl) link.href = login.authUrl; else link.removeAttribute("href");
  connectionElement("gptAccountAddBtn").disabled = login.status === "waiting";
  if (login.status === "waiting") {
    connectionState.loginTimer = setTimeout(async () => {
      try {
        const next = await fetchJson("/api/gpt-accounts/login");
        renderAccountLogin(next);
        if (next.status === "complete") { await loadConnectionSettings(); await loadUsage({ force: true }); }
      } catch { renderAccountLogin({ status: "failed" }); }
    }, 2000);
  }
}

async function saveDeviceSyncSettings() {
  await connectionAction("settings", { enabled: connectionElement("deviceSyncEnabled").checked,
    name: connectionElement("deviceSyncName").value }, async (result) => {
    if (!result.enabled) connectionState.selectedDevice = "all";
    renderDeviceSync(result); await loadUsage({ force: true });
  });
}

async function connectionAction(action, body, onSuccess) {
  if (connectionState.busy) return;
  connectionState.busy = true;
  connectionMessage("deviceSync.working");
  const controls = [...connectionElement("deviceSyncSection").querySelectorAll("button, input, textarea")];
  controls.forEach((control) => { control.disabled = true; });
  try {
    const result = await fetchJson(`/api/device-sync/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    connectionMessage("deviceSync.ready");
    await onSuccess?.(result);
  } catch (error) {
    connectionMessage(`deviceSync.errors.${error.message}`);
    await fetchJson("/api/device-sync").then(renderDeviceSync).catch(() => {});
  } finally {
    connectionState.busy = false; controls.forEach((control) => { control.disabled = false; });
    renderDeviceSync(connectionState.sync);
  }
}

function renderConnections(usage) {
  if (usage?.deviceSync) renderDeviceSync(usage.deviceSync);
  const coverage = usage?.syncCoverage;
  connectionElement("deviceSyncCoverage").textContent = coverage?.unavailable
    ? `${t("deviceSync.local")} · ${t("deviceSync.errors.default")}`
    : usage?.deviceSync?.error
      ? t("deviceSync.errors.default")
      : coverage
    ? t("deviceSync.coverage", { count: formatTokens(coverage.eventCount), excluded: formatTokens(coverage.excludedEvents), duplicates: formatTokens(coverage.duplicatesSkipped) })
    : t("deviceSync.local");
}

function renderDeviceSync(sync) {
  if (!sync) return;
  connectionState.sync = sync;
  connectionElement("deviceSyncEnabled").checked = sync.enabled;
  if (document.activeElement !== connectionElement("deviceSyncName")) connectionElement("deviceSyncName").value = sync.name;
  for (const id of ["deviceSyncInviteBtn", "deviceSyncJoinBtn", "deviceSyncRefreshBtn"]) connectionElement(id).disabled = !sync.enabled || connectionState.busy;
  connectionElement("deviceViewControls").hidden = !sync.enabled;
  const devices = sync.devices || [];
  const values = ["all", "local", ...devices.map((device) => device.id)];
  if (!values.includes(connectionState.selectedDevice)) connectionState.selectedDevice = "local";
  connectionElement("deviceViewSelect").innerHTML = [
    `<option value="local">${escapeHtml(t("deviceSync.local"))}</option>`,
    `<option value="all">${escapeHtml(t("deviceSync.all"))}</option>`,
    ...devices.filter((device) => device.id !== sync.deviceId).map((device) => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.name)}</option>`)
  ].join("");
  connectionElement("deviceViewSelect").value = connectionState.selectedDevice;
  connectionElement("deviceSyncPeers").innerHTML = (sync.peers || []).map((peer) => `
    <div class="connection-row"><div><strong>${escapeHtml(peer.name)}</strong><p class="settings-desc">${escapeHtml(peer.error
      ? t("deviceSync.errors.peer_unreachable") : peer.lastSyncAt ? t("gptAccounts.lastSeen", { time: formatRelativeUpdatedAt(peer.lastSyncAt) }) : t("deviceSync.working"))}</p></div>
      <button class="text-button ghost" type="button" data-forget-device="${escapeHtml(peer.id)}">${escapeHtml(t("deviceSync.forget"))}</button></div>`).join("");
  if (sync.error && !connectionState.busy) connectionMessage(`deviceSync.errors.${sync.error}`);
}
