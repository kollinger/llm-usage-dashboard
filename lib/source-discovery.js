"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const INSTANCE_MARKER_DIR = path.join(os.tmpdir(), "llm-usage-dashboard");
const PROVIDER_PROBES = [
  {
    providerId: "codex",
    label: "Codex",
    kind: "usage_dir",
    confidence: "high",
    paths: [
      { role: "sessions", relativePath: ".codex/sessions", kind: "directory" },
      { role: "archived_sessions", relativePath: ".codex/archived_sessions", kind: "directory" }
    ],
    processPatterns: [/(\b|\/)codex(\b|$)/i],
    servicePatterns: [/codex/i]
  },
  {
    providerId: "claudeCode",
    label: "Claude Code",
    kind: "usage_dir",
    confidence: "high",
    paths: [{ role: "projects", relativePath: ".claude/projects", kind: "directory" }],
    processPatterns: [/(\b|\/)claude(\b|$)/i, /claude-code/i],
    servicePatterns: [/claude/i]
  },
  {
    providerId: "copilot",
    label: "GitHub Copilot",
    kind: "usage_dir",
    confidence: "medium",
    paths: [{ role: "session_state", relativePath: ".copilot/session-state", kind: "directory" }],
    processPatterns: [/(\b|\/)copilot(\b|$)/i],
    servicePatterns: [/copilot/i]
  },
  {
    providerId: "gemini",
    label: "Gemini",
    kind: "usage_dir",
    confidence: "medium",
    paths: [
      { role: "telemetry", relativePath: ".gemini/telemetry", kind: "directory" },
      { role: "chats", relativePath: ".gemini/chats", kind: "directory" },
      { role: "tmp", relativePath: ".gemini/tmp", kind: "directory" }
    ],
    processPatterns: [/(\b|\/)gemini(\b|$)/i],
    servicePatterns: [/gemini/i]
  },
  {
    providerId: "glm",
    label: "GLM/Z.AI",
    kind: "manual_import",
    confidence: "medium",
    paths: [
      { role: "usage_events_jsonl", relativePath: ".zai/usage-events.jsonl", kind: "file" },
      { role: "usage_events_csv", relativePath: ".zai/usage-events.csv", kind: "file" },
      { role: "usage_events_jsonl", relativePath: ".glm/usage-events.jsonl", kind: "file" },
      { role: "usage_events_csv", relativePath: ".glm/usage-events.csv", kind: "file" },
      { role: "opencode_database", relativePath: ".local/share/opencode/opencode.db", kind: "file" },
      { role: "opencode_data_dir", relativePath: ".local/share/opencode", kind: "directory" }
    ],
    processPatterns: [/(\b|\/)(glm|zai|z-ai|z\.ai|chatglm)(\b|$)/i],
    servicePatterns: [/\b(glm|zai|z-ai|z\.ai|chatglm)\b/i]
  }
];
const TOOL_PATTERNS = [
  { providerId: "codex", pattern: /(\b|\/)codex(\b|$)/i },
  { providerId: "claudeCode", pattern: /(\b|\/)claude(\b|$)|claude-code/i },
  { providerId: "copilot", pattern: /(\b|\/)copilot(\b|$)/i },
  { providerId: "gemini", pattern: /(\b|\/)gemini(\b|$)/i },
  { providerId: "glm", pattern: /(\b|\/)(glm|zai|z-ai|z\.ai|chatglm)(\b|$)/i },
  { providerId: "ollama", pattern: /(\b|\/)ollama(\b|$)/i },
  { providerId: "dashboard", pattern: /llm-usage-dashboard|electron|node/i }
];

async function discoverSources(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "linux") {
    return discoverUnsupported(platform, options);
  }
  return discoverLinuxSources(options);
}

async function discoverLinuxSources(options = {}) {
  const checkedAt = new Date().toISOString();
  const currentUser = getCurrentUser();
  const processEvidence = readLinuxProcessEvidence();
  const serviceEvidence = readLinuxServiceEvidence();
  const users = await discoverLinuxUsers(currentUser, processEvidence);
  const candidates = [];

  for (const user of users) {
    for (const probe of PROVIDER_PROBES) {
      const source = await probeUserSource(user, probe, currentUser, checkedAt, processEvidence, serviceEvidence);
      if (source) candidates.push(source);
    }
  }

  const ollamaSource = await probeOllamaSource(options, currentUser, checkedAt, processEvidence, serviceEvidence);
  if (ollamaSource) candidates.push(ollamaSource);

  candidates.push(...buildProcessOnlySources(processEvidence, users, currentUser, checkedAt));
  candidates.push(...buildServiceOnlySources(serviceEvidence, checkedAt));

  const dedupedCandidates = dedupeSources(candidates);
  const otherDashboardInstances = await readInstanceMarkers();
  const container = detectContainer();
  return {
    generatedAt: checkedAt,
    currentUser,
    os: {
      platform: "linux",
      supported: true,
      supportLevel: container ? "partial_container" : "full",
      container
    },
    candidates: dedupedCandidates,
    processEvidence,
    serviceEvidence,
    otherDashboardInstances,
    counts: buildCounts(dedupedCandidates, otherDashboardInstances)
  };
}

async function discoverUnsupported(platform, options = {}) {
  const checkedAt = new Date().toISOString();
  const candidates = await buildConfiguredCurrentUserSources(options, checkedAt);
  return {
    generatedAt: checkedAt,
    currentUser: getCurrentUser(),
    os: {
      platform,
      supported: false,
      supportLevel: platform === "darwin" || platform === "win32" ? "stub" : "unsupported",
      container: detectContainer()
    },
    candidates,
    processEvidence: [],
    serviceEvidence: [],
    otherDashboardInstances: [],
    counts: {
      ...buildCounts(candidates, []),
      connectedCandidates: 0
    },
    message: "Host user and process discovery is currently implemented for Linux only."
  };
}

function getCurrentUser() {
  const info = os.userInfo();
  return {
    uid: typeof process.getuid === "function" ? process.getuid() : info.uid ?? null,
    gid: typeof process.getgid === "function" ? process.getgid() : info.gid ?? null,
    name: info.username || process.env.USER || "unknown",
    home: info.homedir || os.homedir(),
    current: true
  };
}

async function discoverLinuxUsers(currentUser, processEvidence) {
  const users = new Map();
  addUser(users, currentUser);
  for (const user of parsePasswd(readPasswdText())) {
    if (await isPlausibleLocalUser(user, currentUser, processEvidence)) addUser(users, user);
  }
  for (const proc of processEvidence) {
    if (!users.has(String(proc.uid))) {
      addUser(users, {
        uid: proc.uid,
        gid: null,
        name: proc.user || `uid-${proc.uid}`,
        home: null,
        current: proc.uid === currentUser.uid,
        processOnly: true
      });
    }
  }
  return Array.from(users.values()).sort((a, b) => Number(a.uid || 0) - Number(b.uid || 0));
}

function readPasswdText() {
  const getent = spawnSync("getent", ["passwd"], { encoding: "utf8", timeout: 3000, maxBuffer: 1024 * 1024 });
  if (getent.status === 0 && getent.stdout.trim()) return getent.stdout;
  try {
    return fs.readFileSync("/etc/passwd", "utf8");
  } catch {
    return "";
  }
}

function parsePasswd(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, , uid, gid, , home, shell] = line.split(":");
      return {
        uid: Number(uid),
        gid: Number(gid),
        name,
        home,
        shell,
        current: false
      };
    })
    .filter((user) => Number.isFinite(user.uid) && user.name);
}

async function isPlausibleLocalUser(user, currentUser, processEvidence) {
  if (user.uid === currentUser.uid) return true;
  if (processEvidence.some((proc) => proc.uid === user.uid)) return true;
  if (!user.home || !path.isAbsolute(user.home)) return false;
  if (/nologin|false$/i.test(user.shell || "")) return false;
  if (user.uid < 500) return false;
  try {
    const stat = await fsp.stat(user.home);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function addUser(users, user) {
  if (user.uid === null || user.uid === undefined) return;
  const key = String(user.uid);
  if (!users.has(key)) {
    users.set(key, {
      uid: user.uid,
      gid: user.gid ?? null,
      name: user.name || `uid-${user.uid}`,
      home: user.home || null,
      current: Boolean(user.current)
    });
    return;
  }
  const existing = users.get(key);
  users.set(key, {
    ...existing,
    ...user,
    current: existing.current || Boolean(user.current),
    home: existing.home || user.home || null,
    gid: existing.gid ?? user.gid ?? null
  });
}

async function probeUserSource(user, probe, currentUser, checkedAt, processEvidence, serviceEvidence) {
  if (!user.home || !path.isAbsolute(user.home)) return null;
  const paths = [];
  for (const probePath of probe.paths) {
    paths.push(await inspectPath(path.join(user.home, probePath.relativePath), probePath));
  }
  const providerProcesses = filterProviderProcesses(processEvidence, probe.providerId, user.uid);
  const providerServices = filterProviderServices(serviceEvidence, probe.providerId);
  if (!hasSourceEvidence(paths, providerProcesses, providerServices, user.current)) return null;

  const source = {
    id: sourceId(probe.providerId, user.uid, paths.map((entry) => entry.path)),
    providerId: probe.providerId,
    kind: probe.kind,
    label: `${probe.label} - ${user.current ? "current user" : user.name}`,
    owner: {
      uid: user.uid,
      gid: user.gid,
      name: user.name,
      home: user.home,
      current: user.uid === currentUser.uid
    },
    paths,
    accessStatus: accessStatus(paths, providerProcesses, providerServices),
    discovery: {
      method: "linux-user-path-probe",
      confidence: confidenceFor(paths, providerProcesses, providerServices, probe.confidence),
      checkedAt,
      evidence: evidenceLabels(paths, providerProcesses, providerServices)
    },
    privacy: defaultPrivacy(),
    suggestedAction: null
  };
  source.suggestedAction = suggestedActionFor(source, currentUser);
  return source;
}

async function probeOllamaSource(options, currentUser, checkedAt, processEvidence, serviceEvidence) {
  const usageFile = options.ollamaUsageFile || (options.dataDir ? path.join(options.dataDir, "ollama-usage.jsonl") : null);
  const paths = usageFile
    ? [await inspectPath(usageFile, { role: "usage_file", kind: "file" })]
    : [];
  const providerProcesses = filterProviderProcesses(processEvidence, "ollama");
  const providerServices = filterProviderServices(serviceEvidence, "ollama");
  if (!hasSourceEvidence(paths, providerProcesses, providerServices, true)) return null;
  const source = {
    id: sourceId("ollama", currentUser.uid, paths.map((entry) => entry.path).concat("service")),
    providerId: "ollama",
    kind: paths.length ? "usage_file" : "service",
    label: "Ollama - local proxy",
    owner: currentUser,
    paths,
    accessStatus: accessStatus(paths, providerProcesses, providerServices),
    discovery: {
      method: "linux-ollama-probe",
      confidence: paths.some((entry) => entry.readable) ? "high" : "medium",
      checkedAt,
      evidence: evidenceLabels(paths, providerProcesses, providerServices)
    },
    privacy: defaultPrivacy(),
    suggestedAction: null
  };
  source.suggestedAction = suggestedActionFor(source, currentUser);
  return source;
}

async function inspectPath(filePath, probePath) {
  const resolved = path.resolve(filePath);
  const entry = {
    role: probePath.role,
    path: resolved,
    kind: probePath.kind,
    exists: false,
    readable: false,
    permission: "missing",
    type: "unknown",
    mtime: null
  };
  try {
    const stat = await fsp.stat(resolved);
    entry.exists = true;
    entry.type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    entry.mtime = stat.mtime.toISOString();
    const mode = stat.isDirectory() ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK;
    await fsp.access(resolved, mode);
    entry.readable = true;
    entry.permission = "readable";
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      entry.permission = "missing";
    } else if (["EACCES", "EPERM"].includes(error?.code)) {
      entry.exists = true;
      entry.permission = "denied";
    } else {
      entry.permission = "unknown";
    }
  }
  return entry;
}

function hasSourceEvidence(paths, processes, services, includeCurrentMissing) {
  if (paths.some((entry) => entry.exists || entry.readable || entry.permission === "denied")) return true;
  if (processes.length || services.length) return true;
  return Boolean(includeCurrentMissing);
}

function accessStatus(paths, processes, services) {
  if (paths.some((entry) => entry.readable)) {
    return paths.some((entry) => entry.permission === "denied") ? "mixed" : "readable";
  }
  if (paths.some((entry) => entry.permission === "denied")) return "denied";
  if (processes.length) return "process_only";
  if (services.length) return "service_only";
  return "missing";
}

function confidenceFor(paths, processes, services, fallback) {
  if (paths.some((entry) => entry.readable || entry.permission === "denied")) return "high";
  if (processes.length || services.length) return "medium";
  return fallback || "low";
}

function evidenceLabels(paths, processes, services) {
  const labels = [];
  for (const entry of paths) {
    if (entry.readable) labels.push(`${entry.role}:readable`);
    else if (entry.permission === "denied") labels.push(`${entry.role}:denied`);
    else if (entry.exists) labels.push(`${entry.role}:exists`);
  }
  if (processes.length) labels.push(`process:${processes.length}`);
  if (services.length) labels.push(`service:${services.length}`);
  return labels;
}

function readLinuxProcessEvidence() {
  const result = spawnSync("ps", ["-eo", "pid=,uid=,user=,comm=,args="], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 2 * 1024 * 1024
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  return result.stdout
    .split(/\r?\n/)
    .map(parsePsLine)
    .filter(Boolean)
    .flatMap((proc) => {
      const providerIds = matchingProviderIds(`${proc.comm} ${proc.args}`);
      return providerIds.map((providerId) => ({
        providerId,
        pid: proc.pid,
        uid: proc.uid,
        user: proc.user,
        command: path.basename(proc.comm || proc.args.split(/\s+/)[0] || ""),
        argsRedacted: true
      }));
    })
    .filter((item) => item.providerId !== "dashboard");
}

function parsePsLine(line) {
  const match = String(line || "").match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    uid: Number(match[2]),
    user: match[3],
    comm: match[4],
    args: match[5] || ""
  };
}

function matchingProviderIds(text) {
  const matches = [];
  for (const { providerId, pattern } of TOOL_PATTERNS) {
    if (pattern.test(text) && !matches.includes(providerId)) matches.push(providerId);
  }
  return matches;
}

function filterProviderProcesses(processes, providerId, uid = null) {
  return processes.filter((proc) => proc.providerId === providerId && (uid === null || proc.uid === uid));
}

function readLinuxServiceEvidence() {
  const services = [];
  const systemctl = spawnSync("systemctl", ["list-units", "--type=service", "--all", "--no-legend", "--no-pager"], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 1024 * 1024
  });
  if (systemctl.status === 0 && systemctl.stdout.trim()) {
    for (const line of systemctl.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const unit = trimmed.split(/\s+/)[0] || "";
      for (const { providerId, pattern } of TOOL_PATTERNS) {
        if (providerId === "dashboard") continue;
        if (pattern.test(unit)) {
          services.push({ providerId, unit, source: "systemctl" });
        }
      }
    }
  }

  const loginctl = spawnSync("loginctl", ["list-users", "--no-legend"], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 256 * 1024
  });
  if (loginctl.status === 0 && loginctl.stdout.trim()) {
    for (const line of loginctl.stdout.split(/\r?\n/)) {
      const [uid, user] = line.trim().split(/\s+/);
      if (uid && user) services.push({ providerId: "login", unit: `login:${user}`, uid: Number(uid), user, source: "loginctl" });
    }
  }
  return services;
}

function filterProviderServices(services, providerId) {
  return services.filter((service) => service.providerId === providerId);
}

function buildProcessOnlySources(processes, users, currentUser, checkedAt) {
  const result = [];
  const existingUsers = new Map(users.map((user) => [String(user.uid), user]));
  const groups = new Map();
  for (const proc of processes) {
    if (!["codex", "claudeCode", "copilot", "gemini", "glm", "ollama"].includes(proc.providerId)) continue;
    const key = `${proc.providerId}:${proc.uid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(proc);
  }
  for (const [key, group] of groups) {
    const [providerId, uidText] = key.split(":");
    const uid = Number(uidText);
    const user = existingUsers.get(String(uid)) || {
      uid,
      gid: null,
      name: group[0]?.user || `uid-${uid}`,
      home: null,
      current: uid === currentUser.uid
    };
    result.push({
      id: sourceId(providerId, uid, [`process:${providerId}`]),
      providerId,
      kind: "process",
      label: `${providerLabel(providerId)} process - ${user.current ? "current user" : user.name}`,
      owner: {
        uid: user.uid,
        gid: user.gid,
        name: user.name,
        home: user.home,
        current: user.uid === currentUser.uid
      },
      paths: [],
      accessStatus: "process_only",
      discovery: {
        method: "linux-process-scan",
        confidence: "medium",
        checkedAt,
        evidence: [`process:${group.length}`]
      },
      privacy: defaultPrivacy(),
      suggestedAction: null,
      processes: group.slice(0, 8)
    });
  }
  return result;
}

function buildServiceOnlySources(services, checkedAt) {
  return services
    .filter((service) => ["codex", "claudeCode", "copilot", "gemini", "glm", "ollama"].includes(service.providerId))
    .map((service) => ({
      id: sourceId(service.providerId, "service", [service.unit]),
      providerId: service.providerId,
      kind: "service",
      label: `${providerLabel(service.providerId)} service`,
      owner: { uid: null, gid: null, name: "system", home: null, current: false },
      paths: [],
      accessStatus: "service_only",
      discovery: {
        method: service.source || "linux-service-scan",
        confidence: "medium",
        checkedAt,
        evidence: [`service:${service.unit}`]
      },
      privacy: defaultPrivacy(),
      suggestedAction: null,
      service
    }));
}

function dedupeSources(sources) {
  const seen = new Set();
  const result = [];
  for (const source of sources) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    result.push(source);
  }
  return result.sort((a, b) => {
    const currentDelta = Number(b.owner?.current || false) - Number(a.owner?.current || false);
    if (currentDelta) return currentDelta;
    return `${a.providerId}:${a.label}`.localeCompare(`${b.providerId}:${b.label}`);
  });
}

async function buildConfiguredCurrentUserSources(options, checkedAt) {
  const currentUser = getCurrentUser();
  const configured = [];
  const homes = options.codexHomes || [];
  for (const home of homes) {
    configured.push(await configuredSource("codex", currentUser, checkedAt, [
      { role: "sessions", path: path.join(home, "sessions"), kind: "directory" },
      { role: "archived_sessions", path: path.join(home, "archived_sessions"), kind: "directory" }
    ]));
  }
  return configured;
}

async function configuredSource(providerId, owner, checkedAt, paths) {
  const inspectedPaths = [];
  for (const entry of paths) {
    inspectedPaths.push(await inspectPath(entry.path, entry));
  }
  return {
    id: sourceId(providerId, owner.uid, inspectedPaths.map((entry) => entry.path)),
    providerId,
    kind: "usage_dir",
    label: `${providerLabel(providerId)} - current user`,
    owner,
    paths: inspectedPaths,
    accessStatus: accessStatus(inspectedPaths, [], []),
    discovery: {
      method: "configured-current-user",
      confidence: confidenceFor(inspectedPaths, [], [], "medium"),
      checkedAt,
      evidence: evidenceLabels(inspectedPaths, [], [])
    },
    privacy: defaultPrivacy(),
    suggestedAction: null
  };
}

async function readInstanceMarkers() {
  let entries;
  try {
    entries = await fsp.readdir(INSTANCE_MARKER_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const markers = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(INSTANCE_MARKER_DIR, entry.name);
    try {
      const stat = await fsp.stat(file);
      const marker = sanitizeInstanceMarker(JSON.parse(await fsp.readFile(file, "utf8")), stat.mtime);
      if (marker) markers.push(marker);
    } catch {
      // Ignore stale or partially written markers.
    }
  }
  return markers.sort((a, b) => String(a.uid).localeCompare(String(b.uid)));
}

function sanitizeInstanceMarker(marker, mtime) {
  if (!marker || typeof marker !== "object") return null;
  const pid = Number(marker.pid);
  const port = Number(marker.port);
  const uid = Number(marker.uid);
  if (!Number.isFinite(pid) || !Number.isFinite(port) || !Number.isFinite(uid)) return null;
  return {
    uid,
    user: String(marker.user || `uid-${uid}`).slice(0, 80),
    pid,
    port,
    url: `http://localhost:${port}`,
    startedAt: normalizeIso(marker.startedAt) || mtime.toISOString(),
    version: String(marker.version || "").slice(0, 40) || null,
    dataDirHash: String(marker.dataDirHash || "").slice(0, 80) || null,
    markerMtime: mtime.toISOString()
  };
}

function suggestedActionFor(source, currentUser) {
  if (process.platform !== "linux") return null;
  if (source.owner?.current || !["denied", "mixed"].includes(source.accessStatus)) return null;
  const readableRoots = source.paths.filter((entry) => entry.permission === "denied" || entry.exists).map((entry) => entry.path);
  if (!readableRoots.length) return null;
  const appUser = aclPrincipal(currentUser);
  const execDirs = executableParentDirs(source.owner?.home, readableRoots);
  return {
    type: "linux_acl",
    requiresAdmin: true,
    commands: [
      ...execDirs.map((dir) => `sudo setfacl -m u:${appUser}:--x ${shellQuote(dir)}`),
      `sudo setfacl -R -m u:${appUser}:rX ${readableRoots.map(shellQuote).join(" ")}`,
      `sudo find ${readableRoots.map(shellQuote).join(" ")} -type d -exec setfacl -d -m u:${appUser}:rX {} +`
    ],
    revokeCommands: [
      ...execDirs.map((dir) => `sudo setfacl -x u:${appUser} ${shellQuote(dir)}`),
      `sudo setfacl -R -x u:${appUser} ${readableRoots.map(shellQuote).join(" ")}`,
      `sudo find ${readableRoots.map(shellQuote).join(" ")} -type d -exec setfacl -d -x u:${appUser} {} +`
    ]
  };
}

function executableParentDirs(home, roots) {
  if (!home || !path.isAbsolute(home)) return [];
  const result = new Set([path.resolve(home)]);
  for (const root of roots) {
    let dir = path.dirname(path.resolve(root));
    while (dir.startsWith(path.resolve(home)) && dir !== path.resolve(home)) {
      result.add(dir);
      dir = path.dirname(dir);
    }
  }
  return Array.from(result).sort((a, b) => a.length - b.length);
}

function buildCounts(candidates, instances) {
  return {
    total: candidates.length,
    readable: candidates.filter((source) => source.accessStatus === "readable" || source.accessStatus === "mixed").length,
    denied: candidates.filter((source) => source.accessStatus === "denied").length,
    missing: candidates.filter((source) => source.accessStatus === "missing").length,
    processOnly: candidates.filter((source) => source.accessStatus === "process_only").length,
    serviceOnly: candidates.filter((source) => source.accessStatus === "service_only").length,
    otherDashboardInstances: instances.length
  };
}

function detectContainer() {
  if (fs.existsSync("/.dockerenv")) return true;
  try {
    return /docker|containerd|kubepods|podman|lxc/i.test(fs.readFileSync("/proc/1/cgroup", "utf8"));
  } catch {
    return false;
  }
}

function sourceId(providerId, ownerId, parts) {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify([providerId, ownerId, parts.map((part) => path.normalize(String(part))).sort()]))
    .digest("hex")
    .slice(0, 16);
  return `${providerId}:${ownerId}:${hash}`;
}

function providerLabel(providerId) {
  return PROVIDER_PROBES.find((probe) => probe.providerId === providerId)?.label || (providerId === "ollama" ? "Ollama" : providerId);
}

function defaultPrivacy() {
  return {
    scope: "metadata_only",
    forbidden: ["credentials", "raw_transcripts", "provider_payloads"]
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function aclPrincipal(user) {
  const name = String(user?.name || "").trim();
  if (/^[a-z_][a-z0-9_-]*[$]?$/i.test(name)) return name;
  if (Number.isFinite(Number(user?.uid))) return String(user.uid);
  return "nobody";
}

function normalizeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

module.exports = {
  INSTANCE_MARKER_DIR,
  PROVIDER_PROBES,
  discoverSources,
  readInstanceMarkers,
  sourceId
};
