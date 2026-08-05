# Changelog

## 1.1.0-preview.15 - 2026-08-06

### Fixed

- Correctly recognize Claude Max 5x and 20x plans from the German billing
  summary even when unrelated Team wording appears elsewhere on the page.

### Improved

- Move the local GPT account registry and its manual account re-scan from the
  main dashboard into Settings.

## 1.1.0-preview.14 - 2026-08-02

### Fixed

- Show every distinct ChatGPT account managed through common OpenCode
  multi-account stores and read each account's 5-hour and weekly quota
  independently.
- Retain the last successful per-account quota snapshot when a live refresh is
  temporarily unavailable or OpenCode switches to another account.

### Improved

- Watch built-in OpenCode auth plus `oc-codex-multi-auth` and
  `opencode-multi-auth-codex` account stores for changes while the desktop
  backend is running.
- Keep multi-account probing read-only: the dashboard never sends refresh
  tokens and persists only masked identities and normalized quota snapshots.

## 1.1.0-preview.13 - 2026-08-01

### Added

- Read the current 5-hour and weekly ChatGPT quota separately for every
  configured Codex home and reachable OpenCode OpenAI OAuth profile.
- Show quota coverage across active GPT accounts and mark an account's limit as
  unavailable when its current quota cannot be read.

### Improved

- Keep per-account quota probing read-only and privacy-safe: credentials and raw
  provider responses are never written to the local account registry.

## 1.1.0-preview.12 - 2026-07-31

### Fixed

- Keep the private GPT account-registry permission test strict on macOS and
  Linux while allowing Windows builds, where POSIX `0600` mode bits are not
  available.

## 1.1.0-preview.11 - 2026-07-31

### Added

- Track privacy-safe GPT account identities observed through Codex and OpenCode,
  keep previously seen accounts across sign-ins, and provide a manual account
  re-scan in the dashboard. OpenCode GPT token totals remain correctly labeled
  as OpenCode-wide when its database cannot attribute messages to an account.
- Show separate machine-readable Claude Fable limits from the browser/API or
  statusline telemetry. Multiple scoped Fable buckets remain separate from the
  general weekly limit, quota history, and notifications.

### Fixed

- Keep both all-time timelines at their latest data after delayed Electron
  layout measurement, refreshes, and real dashboard panel moves while still
  preserving intentional manual history scrolling.
- Hide empty setup-only providers such as an unused OpenCode GPT database from
  the normal provider view; they remain available through `Show all`.

## 1.1.0-preview.10 - 2026-07-31

### Fixed

- Keep both usage-history timelines pinned to the latest data after initial
  rendering and view changes, including when their scrollable layout settles
  after the first render frame. Intentional manual scrolling is still preserved
  during ordinary background refreshes.
- Restore dark, high-contrast styling for the Refresh and Settings buttons in
  the dashboard header, including the Refresh loading state.

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
