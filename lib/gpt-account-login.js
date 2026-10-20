"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

// Each login owns a new Codex home. Never replace the user's active CLI login.
function createGptAccountLogin({ profilesDir, clientFactory, onComplete = async () => {} }) {
  let pending = null;
  let starting = null;
  const publicState = () => pending ? {
    id: pending.id, status: pending.status, authUrl: pending.authUrl,
    expiresAt: pending.expiresAt, error: pending.error
  } : { status: "idle" };
  const finish = async (entry, success) => {
    if (pending !== entry || entry.status !== "waiting") return;
    clearTimeout(entry.timer);
    entry.status = success ? "complete" : "failed";
    entry.error = success ? null : "login_failed";
    entry.authUrl = null;
    entry.client.close();
    if (success) {
      await fsp.chmod(path.join(entry.home, "auth.json"), 0o600).catch((error) => { if (error.code !== "ENOENT") throw error; });
      await onComplete();
    }
    else await fsp.rm(entry.home, { recursive: true, force: true });
  };
  const start = async ({ label } = {}) => {
      const id = crypto.randomUUID();
      const home = path.join(profilesDir, id);
      await fsp.mkdir(home, { recursive: true, mode: 0o700 });
      await fsp.chmod(home, 0o700);
      const displayLabel = String(label || "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 80);
      if (displayLabel) await fsp.writeFile(path.join(home, "dashboard-account.json"), JSON.stringify({ label: displayLabel }), { mode: 0o600 });
      // Codex's shared keyring entry would otherwise let profiles overwrite
      // one another. The isolated auth.json stays owner-only and never syncs.
      await fsp.writeFile(path.join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
      const entry = { id, home, status: "starting", authUrl: null, error: null };
      pending = entry;
      try {
        entry.client = await clientFactory({
          codexHome: home,
          onNotification(message) {
            if (message.method === "account/login/completed") {
              entry.completion = Boolean(message.params?.success);
              return finish(entry, entry.completion).catch(() => { entry.error = "refresh_failed"; });
            }
          },
          onExit() { finish(entry, false).catch(() => {}); }
        });
        const result = await entry.client.request("account/login/start", { type: "chatgpt" });
        const url = new URL(result?.authUrl);
        if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com", "auth0.openai.com"].includes(url.hostname)) {
          throw new Error("unsupported_auth_url");
        }
        entry.authUrl = url.href;
        entry.loginId = result.loginId;
        entry.status = "waiting";
        entry.expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        entry.timer = setTimeout(() => finish(entry, false).catch(() => {}), 10 * 60_000);
        entry.timer.unref?.();
        if (entry.completion !== undefined) await finish(entry, entry.completion);
        return publicState();
      } catch {
        entry.client?.close();
        entry.status = "failed";
        entry.authUrl = null;
        entry.error = "codex_login_unavailable";
        await fsp.rm(home, { recursive: true, force: true });
        return publicState();
      }
  };
  return {
    status: publicState,
    async start(options) {
      if (starting) return starting;
      if (pending?.status === "waiting") return publicState();
      starting = start(options);
      try { return await starting; }
      finally { starting = null; }
    },
    async cancel() {
      if (starting) await starting;
      const entry = pending;
      if (entry?.status === "waiting") {
        await entry.client.request("account/login/cancel", { loginId: entry.loginId }).catch(() => {});
        await finish(entry, false);
      }
      pending = null;
      return publicState();
    },
    close() { clearTimeout(pending?.timer); pending?.client?.close(); }
  };
}

module.exports = { createGptAccountLogin };
