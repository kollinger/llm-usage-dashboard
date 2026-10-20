"use strict";

const PROVIDER_CATALOG = [
  { id: "gpt", label: "ChatGPT / Codex", helpUrl: "https://developers.openai.com/codex/cli/", browser: true },
  { id: "claude", label: "Claude / Claude Code", helpUrl: "https://code.claude.com/docs/en/setup", browser: true },
  { id: "kimi", label: "Kimi Code", helpUrl: "https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html", browser: true, key: true },
  { id: "glm", label: "GLM / Z.AI Coding Plan", helpUrl: "https://docs.z.ai/devpack/quick-start", key: true },
  { id: "openai", label: "OpenAI API", helpUrl: "https://platform.openai.com/settings/organization/admin-keys", key: true },
  { id: "anthropic", label: "Anthropic API", helpUrl: "https://platform.claude.com/docs/en/manage-claude/admin-api", key: true },
  { id: "moonshot", label: "Moonshot / Kimi API", helpUrl: "https://platform.kimi.ai/console/api-keys", key: true }
];

function installConnectionsApi(app, { middleware, keyStore, logins, available, listBrowserAccounts, removeBrowserAccount, invalidate }) {
  const availability = async (provider) => {
    const result = await available(provider);
    return result && typeof result === "object" ? result : { available: Boolean(result), unavailableReason: result ? null : "cli_missing" };
  };
  const catalog = () => Promise.all(PROVIDER_CATALOG.map(async ({ browser, key, helpUrl, ...provider }) => {
    const state = browser ? await availability(provider.id) : null;
    return { ...provider, methods: [
      ...(browser ? [{ id: "browser", type: "browser", available: Boolean(state.available), helpUrl,
        unavailableReason: state.available ? null : state.unavailableReason || "connection_unavailable" }] : []),
      ...(key ? [{ id: "key", type: "key", available: true, helpUrl }] : [])
    ] };
  }));
  const loginState = (provider, state) => ({ ...state, id: provider, provider,
    status: ["idle", "waiting", "complete", "failed"].includes(state?.status) ? state.status : "waiting" });
  const list = async (force = false) => {
    const [providers, browser, keys] = await Promise.all([catalog(), listBrowserAccounts({ force }), keyStore.refresh({ force })]);
    return { providers, accounts: [...browser.filter((account) => account.managed || !account.accountId || !keys.some((key) => key.accountId === account.accountId)), ...keys] };
  };
  const fail = (res, error) => {
    const allowed = new Set(["invalid_account", "invalid_key", "permission_denied", "unsupported_key", "account_limit", "cli_missing", "connection_unavailable", "account_storage_unavailable", "profile_remove_failed"]);
    res.status(400).json({ error: allowed.has(error?.message) ? error.message : "connection_unavailable" });
  };
  app.get("/api/connections", ...middleware, async (_req, res) => {
    try { res.json(await list()); } catch (error) { fail(res, error); }
  });
  app.post("/api/connections/refresh", ...middleware, async (_req, res) => {
    try { const result = await list(true); invalidate(); res.json(result); } catch (error) { fail(res, error); }
  });
  app.post("/api/connections", ...middleware, async (req, res) => {
    try {
      const provider = PROVIDER_CATALOG.find((item) => item.id === req.body.provider);
      if (!provider) throw new Error("invalid_account");
      if (req.body.method === "browser" && provider.browser) {
        const state = await availability(provider.id);
        if (!state.available) throw new Error(state.unavailableReason || "connection_unavailable");
        const result = await logins[provider.id].start({ label: req.body.label });
        return res.json({ login: loginState(provider.id, result) });
      }
      if (req.body.method !== "key" || !provider.key) throw new Error("invalid_account");
      const account = await keyStore.add({ ...req.body, label: req.body.label || provider.label });
      invalidate(); res.json({ account });
    } catch (error) { fail(res, error); }
  });
  app.get("/api/connections/login/:id", ...middleware, (req, res) => {
    const login = Object.hasOwn(logins, req.params.id) && logins[req.params.id];
    if (!login) return res.status(404).json({ error: "invalid_account" });
    res.json(loginState(req.params.id, login.status()));
  });
  app.delete("/api/connections/login/:id", ...middleware, async (req, res) => {
    const login = Object.hasOwn(logins, req.params.id) && logins[req.params.id];
    if (!login) return res.status(404).json({ error: "invalid_account" });
    try { res.json(loginState(req.params.id, await login.cancel())); } catch (error) { fail(res, error); }
  });
  app.delete("/api/connections/:id", ...middleware, async (req, res) => {
    try {
      if (req.params.id.startsWith("key-")) await keyStore.remove(req.params.id);
      else await removeBrowserAccount(req.params.id);
      invalidate(); res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });
}

module.exports = { installConnectionsApi, PROVIDER_CATALOG };
