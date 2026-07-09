"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const SETTINGS_VERSION = 1;
const SETTINGS_FILE = "connected-sources.json";
const KNOWN_PROVIDER_IDS = new Set(["codex", "claudeCode", "copilot", "gemini", "glm", "ollama"]);
const KNOWN_ACCESS_STATUSES = new Set(["readable", "denied", "missing", "mixed", "process_only", "service_only"]);
const FORBIDDEN_PATH_PARTS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".config",
  "cookies",
  "keychain",
  "credentials",
  "credential",
  "secrets",
  "secret",
  "tokens",
  "token"
]);

function sourceSettingsPath(dataDir) {
  return path.join(dataDir, SETTINGS_FILE);
}

async function readSourceSettings(dataDir) {
  try {
    const parsed = JSON.parse(await fsp.readFile(sourceSettingsPath(dataDir), "utf8"));
    return normalizeSourceSettings(parsed);
  } catch {
    return emptySourceSettings();
  }
}

async function writeSourceSettings(dataDir, settings) {
  const normalized = normalizeSourceSettings(settings);
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(sourceSettingsPath(dataDir), `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

async function connectSource(dataDir, source) {
  const settings = await readSourceSettings(dataDir);
  const connectedSource = normalizeConnectedSource(source, {
    enabled: true,
    connectedAt: new Date().toISOString()
  });
  const nextSources = settings.sources.filter((item) => item.id !== connectedSource.id);
  nextSources.push(connectedSource);
  return writeSourceSettings(dataDir, {
    ...settings,
    sources: nextSources
  });
}

async function disableSource(dataDir, sourceId) {
  const settings = await readSourceSettings(dataDir);
  let changed = false;
  const nextSources = settings.sources.map((source) => {
    if (source.id !== sourceId) return source;
    changed = true;
    return {
      ...source,
      enabled: false,
      disabledAt: new Date().toISOString()
    };
  });
  if (!changed) {
    const error = new Error("Connected source was not found.");
    error.statusCode = 404;
    error.code = "source_not_found";
    throw error;
  }
  return writeSourceSettings(dataDir, {
    ...settings,
    sources: nextSources
  });
}

function emptySourceSettings() {
  return {
    version: SETTINGS_VERSION,
    sources: []
  };
}

function normalizeSourceSettings(raw) {
  const settings = raw && typeof raw === "object" ? raw : {};
  const sources = Array.isArray(settings.sources)
    ? settings.sources.map((source) => safeNormalizeConnectedSource(source)).filter(Boolean)
    : [];
  return {
    version: SETTINGS_VERSION,
    sources
  };
}

function safeNormalizeConnectedSource(source) {
  try {
    return normalizeConnectedSource(source);
  } catch {
    return null;
  }
}

function normalizeConnectedSource(source, overrides = {}) {
  if (!source || typeof source !== "object") {
    throw validationError("invalid_source", "Source must be an object.");
  }
  const providerId = String(source.providerId || "").trim();
  if (!KNOWN_PROVIDER_IDS.has(providerId)) {
    throw validationError("invalid_provider", "Source provider is not supported.");
  }
  const id = String(source.id || "").trim();
  if (!id || id.length > 180) {
    throw validationError("invalid_source_id", "Source id is invalid.");
  }
  const paths = normalizeSourcePaths(source.paths);
  if (!paths.length && !["process_only", "service_only"].includes(source.accessStatus)) {
    throw validationError("invalid_source_paths", "Source must contain at least one usage path.");
  }

  const accessStatus = normalizeAccessStatus(source.accessStatus);
  const normalized = {
    id,
    providerId,
    kind: normalizeShortString(source.kind, "usage_dir"),
    label: normalizeShortString(source.label, providerId),
    enabled: typeof source.enabled === "boolean" ? source.enabled : true,
    owner: normalizeOwner(source.owner),
    paths,
    accessStatus,
    discovery: normalizeDiscovery(source.discovery),
    privacy: normalizePrivacy(source.privacy),
    suggestedAction: normalizeSuggestedAction(source.suggestedAction),
    connectedAt: normalizeIso(source.connectedAt) || normalizeIso(source.createdAt) || new Date().toISOString(),
    disabledAt: source.disabledAt ? normalizeIso(source.disabledAt) : null,
    lastVerifiedAt: normalizeIso(source.lastVerifiedAt) || normalizeIso(source.discovery?.checkedAt) || null
  };
  return {
    ...normalized,
    ...overrides,
    owner: normalizeOwner(overrides.owner || normalized.owner),
    paths: overrides.paths ? normalizeSourcePaths(overrides.paths) : normalized.paths
  };
}

function normalizeSourcePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths
    .map((entry) => normalizeSourcePath(entry))
    .filter(Boolean);
}

function normalizeSourcePath(entry) {
  if (!entry || typeof entry !== "object") return null;
  const rawPath = String(entry.path || "").trim();
  if (!rawPath || !path.isAbsolute(rawPath) || hasForbiddenPathPart(rawPath)) return null;
  return {
    role: normalizeShortString(entry.role, "usage"),
    path: path.resolve(rawPath),
    kind: normalizeShortString(entry.kind, "directory"),
    exists: Boolean(entry.exists),
    readable: Boolean(entry.readable),
    permission: normalizeShortString(entry.permission, entry.readable ? "readable" : "unknown"),
    type: normalizeShortString(entry.type, entry.kind || "unknown"),
    mtime: normalizeIso(entry.mtime) || null
  };
}

function hasForbiddenPathPart(filePath) {
  const parts = path
    .resolve(filePath)
    .split(path.sep)
    .map((part) => part.toLowerCase());
  return parts.some((part) => FORBIDDEN_PATH_PARTS.has(part));
}

function normalizeOwner(owner) {
  const value = owner && typeof owner === "object" ? owner : {};
  return {
    uid: normalizeNumber(value.uid),
    gid: normalizeNumber(value.gid),
    name: normalizeShortString(value.name, "unknown"),
    home: value.home && path.isAbsolute(String(value.home)) ? path.resolve(String(value.home)) : null,
    current: Boolean(value.current)
  };
}

function normalizeDiscovery(discovery) {
  const value = discovery && typeof discovery === "object" ? discovery : {};
  return {
    method: normalizeShortString(value.method, "manual"),
    confidence: normalizeShortString(value.confidence, "medium"),
    checkedAt: normalizeIso(value.checkedAt) || new Date().toISOString(),
    evidence: Array.isArray(value.evidence)
      ? value.evidence.map((item) => normalizeShortString(item, "")).filter(Boolean).slice(0, 12)
      : []
  };
}

function normalizePrivacy(privacy) {
  const value = privacy && typeof privacy === "object" ? privacy : {};
  const forbidden = Array.isArray(value.forbidden)
    ? value.forbidden.map((item) => normalizeShortString(item, "")).filter(Boolean)
    : ["credentials", "raw_transcripts", "provider_payloads"];
  return {
    scope: normalizeShortString(value.scope, "metadata_only"),
    forbidden
  };
}

function normalizeSuggestedAction(action) {
  if (!action || typeof action !== "object") return null;
  return {
    type: normalizeShortString(action.type, "manual"),
    requiresAdmin: Boolean(action.requiresAdmin),
    commands: Array.isArray(action.commands) ? action.commands.map(normalizeCommand).filter(Boolean) : [],
    revokeCommands: Array.isArray(action.revokeCommands) ? action.revokeCommands.map(normalizeCommand).filter(Boolean) : []
  };
}

function normalizeCommand(command) {
  const value = String(command || "").trim();
  if (!value || value.length > 1000) return null;
  return value;
}

function normalizeAccessStatus(value) {
  const normalized = String(value || "").trim();
  return KNOWN_ACCESS_STATUSES.has(normalized) ? normalized : "missing";
}

function normalizeShortString(value, fallback) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 160) : fallback;
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function isSettingsFileIgnoredByDefault(dataDir) {
  return fs.existsSync(dataDir);
}

module.exports = {
  SETTINGS_VERSION,
  SETTINGS_FILE,
  connectSource,
  disableSource,
  emptySourceSettings,
  isSettingsFileIgnoredByDefault,
  normalizeConnectedSource,
  normalizeSourceSettings,
  readSourceSettings,
  sourceSettingsPath,
  writeSourceSettings
};
