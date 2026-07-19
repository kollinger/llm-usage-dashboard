# Changelog

## 1.1.0-preview.9 - 2026-07-19

### Fixed

- Hide GLM/Z.AI from the normal active-provider view when a generic OpenCode
  database exists but contains no GLM usage. GLM remains available through
  `Show all` and becomes active when GLM events or provider-specific quota
  configuration are detected.

## 1.1.0-preview.8 - 2026-07-19

### Improved

- Replaced the overlapping subscription actions with one contextual action:
  open the provider page when login is required, or read the plan again when a
  reusable browser session is available.

### Fixed

- Restored live Codex quota and plan reads after Codex moved into the ChatGPT
  macOS app, while retaining support for the legacy standalone Codex app,
  common CLI installations, and explicit binary overrides.
- Accept the authenticated plan reported by the ChatGPT/Codex app as the
  current plan, show the official price range when the exact variant is not
  available, and stop asking users to reconnect an already working account.
- Recognize the current ChatGPT billing layout that labels the active section
  as `Your plan`, including the displayed Pro tier price needed to distinguish
  the 5x and 20x variants.
- Keep browser fallbacks on the exact account domain and ignore partitioned
  Chromium cookies that would otherwise invalidate a reusable login session.

## 1.1.0-preview.7 - 2026-07-18

### Fixed

- Correctly classify Codex quota windows by their actual duration so weekly
  `primary` windows render as weekly limits instead of phantom 5h limits,
  including GPT-5.3-Codex-Spark and desktop notifications.

## 1.1.0-preview.6 - 2026-07-14

### Added

- Added read-only official GLM/Z.AI Coding Plan quota probing through the
  documented Z.AI Usage API, including the 5-hour token window and any other
  official windows returned by the provider.

### Improved

- Kept local OpenCode GLM token history separate from provider quota limits,
  with redacted unavailable diagnostics when auth, plan state, or endpoint
  access is missing.

### Fixed

- Hardened GLM quota auth discovery so generic OpenCode config files and
  malformed loose config text do not activate the GLM quota card or pair
  unrelated tokens with a Z.AI/BigModel base URL.

## 1.1.0-preview.5 - 2026-07-13

### Added

- Added read-only Claude Code OAuth quota probing for Linux/Manjaro so current
  Claude 5h and weekly usage windows can load without manually opening Claude
  Code, when the local session and provider endpoint allow it.

### Improved

- Clarified GLM/Z.AI over OpenCode cards: measured token usage remains visible,
  but official provider quota is shown as unavailable instead of estimating a
  quota gauge from tokens.

### Fixed

- Stopped showing stale Claude statusline quota windows as live limits and
  replaced Claude OAuth/API failures with safe, specific unavailable reasons.

## 1.1.0-preview.4 - 2026-07-11

### Added

- Added a redacted Settings support report for Multica/WhatsApp diagnostics,
  including provider source status, freshness, failure categories, and a compact
  copyable summary.

### Improved

- Kept support-report UI text translated across all supported languages.

## 1.1.0-preview.3 - 2026-07-11

### Improved

- Clarified that logged-token summary cards show locally logged usage, not
  provider quota limits.
- Added provider breakdown notes to logged token summary cards.

### Fixed

- Kept total/provider/model token views consistent across Today, Last 24 Hours,
  Week, Month, and All Time for multi-provider local usage.

## 1.1.0-preview.2 - 2026-07-10

### Improved

- Delegate WhatsApp review releases

### Fixed

- Capture GLM usage from OpenCode

## 1.1.0-preview.1 - 2026-07-10

### Added

- Added automatic desktop update checks and release metadata support for new
  preview builds.
- Added GLM/Z.AI provider support. This should work, but still needs a real
  GLM setup verification.
- Added editable dashboard layouts, drag handles, and a record-day summary
  card.
- Added richer usage-history timeline controls, provider/model breakdowns, and
  token/cost views.
- Added live system/AI load gauges, source diagnostics, and notification setup
  helpers.

### Improved

- Reduced idle CPU, disk I/O, polling, and background refresh load across the
  server, Electron shell, and browser UI.
- Improved subscription, quota, pricing, and account-plan detection for Codex,
  Claude, Gemini, Copilot, and related providers.
- Improved usage cards, reset labels, scroll behavior, chart labels, provider
  colors, and app-wide scrollbars.

### Fixed

- Fixed stale provider cards and quota placeholders when local data is missing
  or outdated.
- Fixed token-history scroll position and current-time timeline handling.
- Fixed Windows CI coverage for injected process-metric fixtures.
