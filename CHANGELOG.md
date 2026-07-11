# Changelog

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
