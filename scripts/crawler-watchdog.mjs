#!/usr/bin/env node

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  EXIT_CODES,
  PROVIDER_CONTRACTS,
  buildTriggerPayload,
  canonicalProviderName,
  nextActionForStatus,
  statusForExitCode
} from "./crawler-contracts.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    return exitWith(
      EXIT_CODES.invalidArgs,
      {
        status: statusForExitCode(EXIT_CODES.invalidArgs),
        exitCode: EXIT_CODES.invalidArgs,
        error: args.error,
        usage: "node scripts/crawler-watchdog.mjs --fixture <dir> [--providers codex,claude] [--print-trigger] | --live"
      },
      args.printTrigger
    );
  }

  const detectedAt = new Date().toISOString();
  const mode = args.fixtureDir ? "fixture" : "live";
  const fixtureDir = args.fixtureDir ? path.resolve(args.fixtureDir) : null;
  const providerIds = args.providers.length ? args.providers : ["codex", "claudeCode"];

  try {
    const env = buildRunEnv({ fixtureDir, mode });
    const rawSources = await loadRawSources({ env, fixtureDir, providerIds });
    const normalized = await loadNormalizedProviders({ env, providerIds });
    const providerReports = providerIds.map((providerId) =>
      analyzeProvider({
        providerId,
        fixtureDir,
        detectedAt,
        rawSource: rawSources[providerId],
        normalized: normalized[providerId]
      })
    );

    const exitCode = providerReports.reduce((max, report) => Math.max(max, report.exitCode), EXIT_CODES.ok);
    const status = statusForExitCode(exitCode);
    const trigger = buildTriggerPayload(providerReports, detectedAt);
    const report = {
      mode,
      fixtureDir,
      detectedAt,
      status,
      exitCode,
      providers: providerReports,
      trigger
    };
    return exitWith(exitCode, report, args.printTrigger);
  } catch (error) {
    return exitWith(
      EXIT_CODES.toolError,
      {
        mode,
        fixtureDir,
        detectedAt,
        status: "toolError",
        exitCode: EXIT_CODES.toolError,
        error: error?.message || String(error)
      },
      args.printTrigger
    );
  }
}

function parseArgs(argv) {
  const parsed = {
    fixtureDir: null,
    live: false,
    printTrigger: false,
    providers: [],
    error: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fixture") {
      parsed.fixtureDir = argv[index + 1] ? String(argv[index + 1]) : "";
      index += 1;
      continue;
    }
    if (arg === "--live") {
      parsed.live = true;
      continue;
    }
    if (arg === "--print-trigger") {
      parsed.printTrigger = true;
      continue;
    }
    if (arg === "--providers") {
      parsed.providers = String(argv[index + 1] || "")
        .split(",")
        .map((value) => canonicalProviderName(value))
        .filter(Boolean);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.error = null;
      return parsed;
    }
    parsed.error = `Unknown argument: ${arg}`;
    return parsed;
  }

  if (!parsed.fixtureDir && !parsed.live) {
    parsed.error = "Either --fixture <dir> or --live is required.";
    return parsed;
  }
  if (parsed.fixtureDir && parsed.live) {
    parsed.error = "Use either --fixture <dir> or --live, not both in the same run.";
    return parsed;
  }
  if (parsed.fixtureDir && !parsed.fixtureDir.trim()) {
    parsed.error = "The --fixture flag requires a directory path.";
    return parsed;
  }
  if (!parsed.providers.length) {
    parsed.providers = ["codex", "claudeCode"];
  }
  for (const providerId of parsed.providers) {
    if (!PROVIDER_CONTRACTS[providerId]) {
      parsed.error = `Unsupported provider: ${providerId}`;
      return parsed;
    }
  }
  return parsed;
}

function buildRunEnv({ fixtureDir, mode }) {
  const env = { ...process.env };
  if (mode === "fixture") {
    env.HOME = fixtureDir;
    env.CODEX_HOME = path.join(fixtureDir, "codex-home");
    env.CLAUDE_HOME = path.join(fixtureDir, "claude-home");
    env.LLM_USAGE_DATA_DIR = path.join(fixtureDir, "data");
    env.DATA_DIR = env.LLM_USAGE_DATA_DIR;
    env.CODEX_LIVE_RATE_LIMITS = "false";
    env.COPILOT_LIVE_QUOTA_ENABLED = "false";
    env.OPENAI_ADMIN_KEY = "";
    env.ANTHROPIC_ADMIN_KEY = "";
    env.ANTHROPIC_WORKSPACE_ID = "";
    const claudeBin = path.join(fixtureDir, "bin", "claude");
    env.CLAUDE_BIN = claudeBin;
  } else {
    const home = env.HOME || os.homedir();
    env.CODEX_HOME = env.CODEX_HOME || path.join(home, ".codex");
    env.CLAUDE_HOME = env.CLAUDE_HOME || path.join(home, ".claude");
    env.CODEX_LIVE_RATE_LIMITS = env.CODEX_LIVE_RATE_LIMITS ?? "true";
  }
  return env;
}

async function loadNormalizedProviders({ env, providerIds }) {
  const previousEnv = { ...process.env };
  Object.assign(process.env, env);
  const serverPath = path.join(ROOT, "server.js");
  delete require.cache[serverPath];
  const serverModule = require(serverPath);
  try {
    const result = {};
    for (const providerId of providerIds) {
      const contract = PROVIDER_CONTRACTS[providerId];
      const providerResult = await serverModule[contract.component]();
      result[providerId] = providerResult;
    }
    return result;
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

async function loadRawSources({ env, fixtureDir, providerIds }) {
  const result = {};
  for (const providerId of providerIds) {
    if (providerId === "codex") {
      result[providerId] = await inspectCodexSources(env.CODEX_HOME);
      continue;
    }
    if (providerId === "claudeCode") {
      result[providerId] = await inspectClaudeSources(env.CLAUDE_HOME, env.CLAUDE_BIN, fixtureDir);
    }
  }
  return result;
}

async function inspectCodexSources(codexHome) {
  const roots = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  const files = [];
  for (const root of roots) {
    files.push(...(await listJsonlFiles(root)));
  }
  let latestEvent = null;
  for (const file of files) {
    await readJsonlEach(file, (event) => {
      if (event?.type !== "event_msg" || event?.payload?.type !== "token_count") return;
      const timestamp = Date.parse(event.timestamp || "");
      if (!Number.isFinite(timestamp)) return;
      if (!latestEvent || timestamp > Date.parse(latestEvent.timestamp || "")) {
        latestEvent = event;
      }
    });
  }
  return {
    files,
    scopes: {
      session_event: latestEvent
    }
  };
}

async function inspectClaudeSources(claudeHome, claudeBin) {
  const projectRoot = path.join(claudeHome, "projects");
  const files = await listJsonlFiles(projectRoot);
  let latestAssistant = null;
  for (const file of files) {
    await readJsonlEach(file, (event) => {
      if (event?.type !== "assistant" || !event?.message?.usage) return;
      const timestamp = Date.parse(event.timestamp || "");
      if (!Number.isFinite(timestamp)) return;
      if (!latestAssistant || timestamp > Date.parse(latestAssistant.timestamp || "")) {
        latestAssistant = event;
      }
    });
  }

  const statuslinePath = path.join(claudeHome, "usage-dashboard-statusline.json");
  const statusline = await readJsonFile(statuslinePath);
  const authProbe = await runClaudeAuthProbe(claudeBin);

  return {
    files,
    scopes: {
      assistant_usage: latestAssistant,
      statusline
    },
    authProbe
  };
}

async function runClaudeAuthProbe(claudeBin) {
  if (!claudeBin) return { available: false, status: "missing", loggedIn: null };
  try {
    await fs.access(claudeBin);
  } catch {
    return { available: false, status: "missing", loggedIn: null };
  }

  const { spawnSync } = await import("node:child_process");
  const command = await claudeAuthProbeCommand(claudeBin);
  const result = spawnSync(command.executable, command.args, {
    encoding: "utf8",
    timeout: 5000
  });
  if (result.error) {
    return {
      available: true,
      status: result.error.code === "ETIMEDOUT" ? "timeout" : "error",
      loggedIn: null
    };
  }
  if (result.status !== 0) {
    return { available: true, status: "unavailable", loggedIn: null };
  }
  try {
    const payload = JSON.parse(result.stdout || "{}");
    return {
      available: true,
      status: "ok",
      loggedIn: Boolean(payload.loggedIn ?? payload.logged_in),
      planType: payload.planType || payload.plan_type || null
    };
  } catch {
    return { available: true, status: "invalid_json", loggedIn: null };
  }
}

async function claudeAuthProbeCommand(claudeBin) {
  const authArgs = ["auth", "status", "--json"];
  if (process.platform !== "win32" || path.extname(claudeBin)) {
    return { executable: claudeBin, args: authArgs };
  }
  try {
    const header = await fs.readFile(claudeBin, { encoding: "utf8" });
    if (/^#!.*\bnode\b/u.test(header.slice(0, 120))) {
      return { executable: process.execPath, args: [claudeBin, ...authArgs] };
    }
  } catch {
    // Fall back to the configured executable and let spawn report the error.
  }
  return { executable: claudeBin, args: authArgs };
}

function analyzeProvider({ providerId, fixtureDir, detectedAt, rawSource, normalized }) {
  const contract = PROVIDER_CONTRACTS[providerId];
  const drifts = [];
  let derivedStatus = evaluateProviderHealth(providerId, rawSource, normalized);

  if (!normalized || normalized.status === "error") {
    derivedStatus = "toolError";
    drifts.push(
      driftRecord({
        providerId,
        component: contract.component,
        detectedAt,
        driftType: "toolError",
        sourceScope: "normalized",
        expected: "A successful provider snapshot",
        observed: normalized?.error || "Provider snapshot failed",
        fixtureSource: fixtureDir
      })
    );
  } else if (derivedStatus === "authMissing" || derivedStatus === "notTestable") {
    // Missing local auth or absent fixture data should not look like schema drift.
  } else {
    for (const entry of contract.sourceContracts) {
      const observed = rawSource?.scopes?.[entry.scope];
      const canonical = inspectPath(observed, entry.path);
      const renamed = entry.renameCandidates
        .map((candidate) => inspectPath(observed, candidate))
        .filter((candidate) => candidate.exists);

      if (!observed) {
        derivedStatus = maxStatus(derivedStatus, "notTestable");
        drifts.push(
          driftRecord({
            providerId,
            component: contract.component,
            detectedAt,
            driftType: "missing",
            sourceScope: entry.scope,
            expected: entry.path,
            observed: "source scope missing",
            fixtureSource: fixtureDir
          })
        );
        continue;
      }

      if (!canonical.exists) {
        const driftType = renamed.length ? "renamed" : "missing";
        derivedStatus = maxStatus(derivedStatus, "needsCrawlerUpdate");
        drifts.push(
          driftRecord({
            providerId,
            component: contract.component,
            detectedAt,
            driftType,
            sourceScope: entry.scope,
            expected: entry.path,
            observed: renamed.length ? renamed.map((item) => item.path) : "path missing",
            fixtureSource: fixtureDir
          })
        );
        continue;
      }

      const actualType = valueType(canonical.value);
      if (actualType !== entry.expectedType) {
        derivedStatus = maxStatus(derivedStatus, "needsCrawlerUpdate");
        drifts.push(
          driftRecord({
            providerId,
            component: contract.component,
            detectedAt,
            driftType: "type",
            sourceScope: entry.scope,
            expected: `${entry.path} (${entry.expectedType})`,
            observed: `${entry.path} (${actualType})`,
            fixtureSource: fixtureDir
          })
        );
      }
    }

    for (const entry of contract.normalizedContracts) {
      const observed = inspectPath(normalized, entry.path);
      if (!observed.exists) {
        derivedStatus = maxStatus(derivedStatus, "needsCrawlerUpdate");
        drifts.push(
          driftRecord({
            providerId,
            component: contract.component,
            detectedAt,
            driftType: "missing",
            sourceScope: "normalized",
            expected: entry.path,
            observed: "path missing",
            fixtureSource: fixtureDir
          })
        );
        continue;
      }
      const actualType = valueType(observed.value);
      if (actualType !== entry.expectedType) {
        derivedStatus = maxStatus(derivedStatus, "needsCrawlerUpdate");
        drifts.push(
          driftRecord({
            providerId,
            component: contract.component,
            detectedAt,
            driftType: "type",
            sourceScope: "normalized",
            expected: `${entry.path} (${entry.expectedType})`,
            observed: `${entry.path} (${actualType})`,
            fixtureSource: fixtureDir
          })
        );
      }
    }

    for (const entry of contract.unexpectedContainers) {
      const observed = rawSource?.scopes?.[entry.scope];
      const container = inspectPath(observed, entry.path);
      if (!container.exists || valueType(container.value) !== "object") continue;
      const extraKeys = Object.keys(container.value).filter((key) => !entry.allowedKeys.includes(key)).sort();
      if (extraKeys.length) {
        derivedStatus = maxStatus(derivedStatus, "needsCrawlerUpdate");
        drifts.push(
          driftRecord({
            providerId,
            component: contract.component,
            detectedAt,
            driftType: "unexpected",
            sourceScope: entry.scope,
            expected: entry.allowedKeys,
            observed: extraKeys,
            fixtureSource: fixtureDir
          })
        );
      }
    }
  }

  const exitCode = EXIT_CODES[derivedStatus];
  return {
    provider: providerId,
    component: contract.component,
    fixtureSource: fixtureDir ? path.join(fixtureDir, contract.fixtureSubdir) : null,
    status: derivedStatus,
    exitCode,
    nextAction: nextActionForStatus(derivedStatus),
    drifts
  };
}

function evaluateProviderHealth(providerId, rawSource, normalized) {
  if (providerId === "claudeCode") {
    const authProbe = rawSource?.authProbe;
    if (authProbe?.available && authProbe.loggedIn === false && !normalized.latest && !normalized.limits) {
      return "authMissing";
    }
    if (!rawSource?.scopes?.assistant_usage && !rawSource?.scopes?.statusline && !authProbe?.available) {
      return "notTestable";
    }
    return "ok";
  }

  if (!rawSource?.scopes?.session_event && Number(normalized?.source?.filesScanned || 0) === 0) {
    return "notTestable";
  }
  return "ok";
}

function driftRecord({ providerId, component, detectedAt, driftType, sourceScope, expected, observed, fixtureSource }) {
  return {
    provider: providerId,
    component,
    driftType,
    sourceScope,
    expected,
    observed,
    fixtureSource,
    detectedAt
  };
}

function maxStatus(left, right) {
  return EXIT_CODES[left] >= EXIT_CODES[right] ? left : right;
}

function inspectPath(source, dottedPath) {
  const parts = dottedPath.split(".");
  let current = source;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return { exists: false, path: dottedPath, value: undefined };
    }
    current = current[part];
  }
  return { exists: true, path: dottedPath, value: current };
}

function valueType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

async function listJsonlFiles(root) {
  const result = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push(fullPath);
      }
    }
  }
  await walk(root);
  return result.sort();
}

async function readJsonlEach(file, onEvent) {
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        await onEvent(JSON.parse(line));
      } catch {
        // Active local JSONL files may contain partial lines while a provider writes.
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function exitWith(exitCode, report, printTriggerOnly) {
  const output = printTriggerOnly ? { ...report.trigger, exitCode: report.exitCode, status: report.status } : report;
  await new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return exitCode;
}

process.exit(await main());
