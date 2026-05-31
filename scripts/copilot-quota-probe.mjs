import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const timeoutMs = Number(process.env.COPILOT_QUOTA_PROBE_TIMEOUT_MS || 10_000);

function json(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function which(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function resolveCopilotCliPath() {
  const candidates = [
    process.env.COPILOT_CLI_PATH,
    process.env.COPILOT_BIN,
    which("copilot")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveCopilotSdkPath(cliPath) {
  const candidates = [process.env.COPILOT_SDK_PATH];

  if (cliPath) {
    try {
      const realCliPath = fs.realpathSync(cliPath);
      const cliText = fs.readFileSync(realCliPath, "utf8");
      const packageMatch = cliText.match(/([^\s"']+@github\/copilot)\/npm-loader\.js/);
      if (packageMatch) {
        candidates.push(path.join(packageMatch[1], "copilot-sdk", "index.js"));
      }
    } catch {
      // Some installations may provide a native launcher instead of a text shim.
    }
  }

  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
  if (npmRoot.status === 0 && npmRoot.stdout.trim()) {
    candidates.push(path.join(npmRoot.stdout.trim(), "@github", "copilot", "copilot-sdk", "index.js"));
  }

  for (const candidate of candidates.filter(Boolean)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function withTimeout(promise, label) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

function sanitizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    isUnlimitedEntitlement: Boolean(snapshot.isUnlimitedEntitlement),
    entitlementRequests: Number(snapshot.entitlementRequests),
    usedRequests: Number(snapshot.usedRequests),
    usageAllowedWithExhaustedQuota: Boolean(snapshot.usageAllowedWithExhaustedQuota),
    remainingPercentage: Number(snapshot.remainingPercentage),
    overage: Number(snapshot.overage),
    overageAllowedWithExhaustedQuota: Boolean(snapshot.overageAllowedWithExhaustedQuota),
    resetDate: typeof snapshot.resetDate === "string" ? snapshot.resetDate : null
  };
}

function sanitizeQuotaResponse(response) {
  const snapshots = response?.quotaSnapshots;
  if (!snapshots || typeof snapshots !== "object") return {};
  return Object.fromEntries(
    Object.entries(snapshots)
      .map(([key, snapshot]) => [key, sanitizeSnapshot(snapshot)])
      .filter(([, snapshot]) => snapshot)
  );
}

function errorStatus(error) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const status =
    lower.includes("not authenticated") || lower.includes("authenticate first") || lower.includes("login")
      ? "not_authenticated"
      : "error";
  return { status, message };
}

async function main() {
  const cliPath = resolveCopilotCliPath();
  if (!cliPath) {
    json({
      status: "not_configured",
      message: "Copilot CLI not found.",
      updatedAt: new Date().toISOString()
    });
    return;
  }

  const sdkPath = resolveCopilotSdkPath(cliPath);
  if (!sdkPath) {
    json({
      status: "not_configured",
      message: "Copilot SDK not found.",
      updatedAt: new Date().toISOString()
    });
    return;
  }

  const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(sdkPath).href);
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: cliPath }),
    logLevel: "none",
    useLoggedInUser: true,
    workingDirectory: process.cwd(),
    sessionIdleTimeoutSeconds: 5
  });

  try {
    await withTimeout(client.start(), "Copilot runtime start");
    const quota = await withTimeout(client.rpc.account.getQuota({}), "Copilot quota request");
    const quotaSnapshots = sanitizeQuotaResponse(quota);
    json({
      status: Object.keys(quotaSnapshots).length ? "live" : "empty",
      quotaSnapshots,
      source: "copilot_sdk_account.getQuota",
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    json({
      ...errorStatus(error),
      source: "copilot_sdk_account.getQuota",
      updatedAt: new Date().toISOString()
    });
  } finally {
    try {
      await withTimeout(client.stop(), "Copilot runtime stop");
    } catch {
      try {
        await client.forceStop();
      } catch {
        // The parent process enforces a hard timeout; ignore cleanup failures here.
      }
    }
  }
}

main().catch((error) => {
  json({
    ...errorStatus(error),
    source: "copilot_sdk_account.getQuota",
    updatedAt: new Date().toISOString()
  });
});
