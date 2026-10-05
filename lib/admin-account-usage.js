"use strict";

// Read-only organization reports. These endpoints require provider-issued
// administrative credentials; no model request is used to test a key.
async function readAdminAccountUsage(provider, key, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!["openai", "anthropic"].includes(provider)) throw new Error("invalid_account");
  const start = now - 7 * 86400_000;
  const headers = provider === "openai" ? { Authorization: `Bearer ${key}` }
    : { "x-api-key": key, "anthropic-version": "2023-06-01" };
  const root = provider === "openai" ? "https://api.openai.com/v1/organization/" : "https://api.anthropic.com/v1/organizations/";
  const params = provider === "openai" ? {
    start_time: String(Math.floor(start / 1000)), end_time: String(Math.floor(now / 1000)), bucket_width: "1d", limit: "7"
  } : { starting_at: new Date(start).toISOString(), ending_at: new Date(now).toISOString(), bucket_width: "1d", limit: "7" };
  const getPages = async (endpoint) => {
    const url = new URL(endpoint, root); Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, value));
    const results = [], cursors = new Set();
    for (let page = 0; page < 64; page += 1) {
      const response = await fetchImpl(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(8000) });
      if (response.status === 401) throw new Error("invalid_key");
      if (response.status === 403) throw new Error("permission_denied");
      if (!response.ok) throw new Error("connection_unavailable");
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error("connection_unavailable");
      const payload = JSON.parse(text);
      if (!Array.isArray(payload.data)) throw new Error("connection_unavailable");
      for (const bucket of payload.data) {
        if (!Array.isArray(bucket.results)) throw new Error("connection_unavailable");
        results.push(...bucket.results);
      }
      if (!payload.has_more) return results;
      if (typeof payload.next_page !== "string" || !payload.next_page || cursors.has(payload.next_page)) throw new Error("connection_unavailable");
      cursors.add(payload.next_page); url.searchParams.set("page", payload.next_page);
    }
    throw new Error("connection_unavailable");
  };
  try {
    const usage = await getPages(provider === "openai" ? "usage/completions" : "usage_report/messages");
    const tokenCount = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const rowTokens = (row) => {
      const input = tokenCount(provider === "openai" ? row.input_tokens : row.uncached_input_tokens);
      const output = tokenCount(row.output_tokens);
      if (input === null || output === null) return null;
      if (provider === "openai") return input + output; // Cached input is already included.
      const cache = [row.cache_read_input_tokens, row.cache_creation?.ephemeral_5m_input_tokens, row.cache_creation?.ephemeral_1h_input_tokens]
        .map((value) => value === undefined ? 0 : tokenCount(value));
      return cache.includes(null) ? null : input + output + cache.reduce((total, value) => total + value, 0);
    };
    const counts = usage.map(rowTokens);
    let costs = null;
    try { costs = await getPages(provider === "openai" ? "costs" : "cost_report"); } catch { /* Usage permission does not imply cost permission. */ }
    const amounts = costs?.map((row) => {
      const raw = provider === "openai" ? row.amount?.value : row.amount;
      const currency = provider === "openai" ? row.amount?.currency : row.currency;
      if (!["string", "number"].includes(typeof raw) || String(raw).trim() === "" || (currency && String(currency).toLowerCase() !== "usd")) return null;
      const amount = Number(raw);
      // Anthropic reports decimal strings in cents; OpenAI reports USD units.
      return Number.isFinite(amount) ? amount / (provider === "anthropic" ? 100 : 1) : null;
    });
    return { authenticated: true, updatedAt: new Date(now).toISOString(), periodDays: 7,
      tokenTotal: counts.includes(null) ? null : counts.reduce((total, value) => total + value, 0),
      costTotal: amounts && !amounts.includes(null) ? amounts.reduce((total, value) => total + value, 0) : null,
      currency: "USD", detailCode: costs === null ? "cost_unavailable" : null };
  } catch (error) {
    return { authenticated: false, error: ["invalid_key", "permission_denied"].includes(error.message) ? error.message : "connection_unavailable" };
  }
}

module.exports = { readAdminAccountUsage };
