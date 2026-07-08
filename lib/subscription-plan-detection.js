"use strict";

const CURRENT_PLAN_ANCHORS = [
  "current plan",
  "your current plan",
  "active plan",
  "selected plan",
  "current subscription",
  "dein aktueller plan",
  "aktueller plan",
  "aktives abo",
  "aktueller tarif"
];

function normalizePlanKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x2f;|&#47;/gi, "/")
    .replace(/&amp;/gi, "&")
    .replace(/[ä]/g, "ae")
    .replace(/[ö]/g, "oe")
    .replace(/[ü]/g, "ue")
    .replace(/[ß]/g, "ss")
    .replace(/[_-]+/g, " ")
    .replace(/\b([0-9]+)\s*x\b/g, "$1x")
    .replace(/[^a-z0-9/€$]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function stripHistoricalPlanHints(value) {
  return String(value || "")
    .replace(/\bprevious[_-]?tier\s*[=:]\s*["']?[^&\s"'<>]+/gi, " ")
    .replace(/\bprevious[_-]?plan\s*[=:]\s*["']?[^&\s"'<>]+/gi, " ")
    .replace(/\blast[_-]?plan\s*[=:]\s*["']?[^&\s"'<>]+/gi, " ");
}

function tierSignals(text, provider) {
  const key = normalizePlanKey(stripHistoricalPlanHints(text));
  if (!key) return { key, five: false, twenty: false, generic: false };
  if (provider === "claude") {
    return {
      key,
      five: /\b(?:claude )?max 5x\b/.test(key) || /\bdefault claude max 5x\b/.test(key) || /\b5x pro capacity\b/.test(key),
      twenty: /\b(?:claude )?max 20x\b/.test(key) || /\bdefault claude max 20x\b/.test(key) || /\b20x pro capacity\b/.test(key),
      generic: /\b(?:claude )?max\b/.test(key)
    };
  }
  return {
    key,
    five: /\b(?:chatgpt |codex )?pro 5x\b/.test(key) || /\b5x (?:higher|hoheres|hoeheres) /.test(key),
    twenty:
      /\b(?:chatgpt |codex )?pro 20x\b/.test(key) ||
      /\b(?:pro max|max pro)\b/.test(key) ||
      /\b20x (?:higher|hoheres|hoeheres) /.test(key),
    generic: /\b(?:chatgpt |codex )?pro\b/.test(key)
  };
}

function scoreTierWindow(windowText, provider) {
  const key = normalizePlanKey(stripHistoricalPlanHints(windowText));
  const scores = { five: 0, twenty: 0 };
  const add = (tier, pattern, points) => {
    const matches = key.match(pattern);
    if (matches) scores[tier] += points * matches.length;
  };

  if (provider === "claude") {
    add("five", /\b(?:claude )?max 5x\b/g, 4);
    add("twenty", /\b(?:claude )?max 20x\b/g, 4);
    add("five", /\b5x pro capacity\b/g, 8);
    add("twenty", /\b20x pro capacity\b/g, 8);
    add("five", /\$100\b|€90\b|90€\b/g, 10);
    add("twenty", /\$200\b|€180\b|180€\b/g, 10);
  } else {
    add("five", /\b(?:chatgpt |codex )?pro 5x\b/g, 4);
    add("twenty", /\b(?:chatgpt |codex )?pro 20x\b|\b(?:pro max|max pro)\b/g, 4);
    add("five", /\b5x (?:higher|hoheres|hoeheres) /g, 8);
    add("twenty", /\b20x (?:higher|hoheres|hoeheres) /g, 8);
    add("five", /\$100\b|€115\b|115€\b/g, 10);
    add("twenty", /\$200\b|€229\b|229€\b/g, 10);
  }

  return scores;
}

function currentPlanWindows(value) {
  const text = stripHistoricalPlanHints(value);
  const key = normalizePlanKey(text);
  if (!key) return [];
  const windows = [];
  for (const anchor of CURRENT_PLAN_ANCHORS) {
    let index = key.indexOf(anchor);
    while (index !== -1) {
      const start = Math.max(0, index - 1200);
      const end = Math.min(key.length, index + 1200);
      windows.push(key.slice(start, end));
      index = key.indexOf(anchor, index + anchor.length);
    }
  }
  return windows;
}

function detectTierNearCurrentPlan(value, provider) {
  for (const windowText of currentPlanWindows(value)) {
    const scores = scoreTierWindow(windowText, provider);
    if (scores.twenty > scores.five && scores.twenty >= 3) return provider === "claude" ? "Claude Max 20x" : "Pro 20x";
    if (scores.five > scores.twenty && scores.five >= 3) return provider === "claude" ? "Claude Max 5x" : "Pro 5x";
  }
  return null;
}

function detectOpenAiPlanType(value, options = {}) {
  const currentTier = detectTierNearCurrentPlan(value, "openai");
  if (currentTier) return currentTier;
  const signals = tierSignals(value, "openai");
  if (!signals.key) return null;
  const explicit = Boolean(options.explicit);
  const allowGeneric = options.allowGeneric !== false;

  if (signals.five && signals.twenty) return allowGeneric && signals.generic ? "Pro" : null;
  if (explicit && signals.twenty) return "Pro 20x";
  if (explicit && signals.five) return "Pro 5x";
  if (explicit && /\b20x\b/.test(signals.key) && !signals.five) return "Pro 20x";
  if (explicit && /\b5x\b/.test(signals.key) && !signals.twenty) return "Pro 5x";
  if (explicit && /\bteam\b|\bbusiness\b/.test(signals.key)) return "Team";
  if (explicit && /\bplus\b/.test(signals.key)) return "Plus";
  if (allowGeneric && signals.generic) return "Pro";
  return null;
}

function detectClaudePlanType(value, options = {}) {
  const currentTier = detectTierNearCurrentPlan(value, "claude");
  if (currentTier) return currentTier;
  const signals = tierSignals(value, "claude");
  if (!signals.key) return null;
  const explicit = Boolean(options.explicit);
  const allowGeneric = options.allowGeneric !== false;

  if (signals.five && signals.twenty) return allowGeneric && signals.generic ? "Claude Max" : null;
  if (explicit && signals.twenty) return "Claude Max 20x";
  if (explicit && signals.five) return "Claude Max 5x";
  if (explicit && /\b20x\b/.test(signals.key) && !signals.five) return "Claude Max 20x";
  if (explicit && /\b5x\b/.test(signals.key) && !signals.twenty) return "Claude Max 5x";
  if (explicit && /\bteam\b|\bbusiness\b/.test(signals.key)) return /\bclaude team\b/.test(signals.key) ? "Claude Team" : "Team";
  if (explicit && /\bpro\b/.test(signals.key)) return /\bclaude pro\b/.test(signals.key) ? "Claude Pro" : "Pro";
  if (allowGeneric && signals.generic) return /\bclaude max\b/.test(signals.key) ? "Claude Max" : "Max";
  return null;
}

module.exports = {
  normalizePlanKey,
  detectOpenAiPlanType,
  detectClaudePlanType
};
