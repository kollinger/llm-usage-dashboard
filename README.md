# LLM Usage Dashboard

Local-first dashboard for LLM usage, rate limits, token logs, and API cost estimates across Codex, GitHub Copilot CLI, Claude Code, Gemini, Ollama, OpenAI, and Anthropic.

The app is intentionally simple: a Node.js/Express backend serves a vanilla HTML/CSS/JavaScript frontend. Electron packages the same local dashboard as a desktop app, and Docker is available for server-style installs.

LLM Usage Dashboard is an independent project by [Gerhard Kollinger](https://github.com/kollinger) and is not affiliated with, endorsed by, or sponsored by OpenAI, Anthropic, Google, Gemini, Ollama, or the maintainers of their tools and APIs.

## Features

- Codex local token usage from `~/.codex/sessions` and `~/.codex/archived_sessions`.
- Codex Spark / research quota detection from Codex `token_count` events when available.
- GitHub Copilot CLI session metrics from local shutdown events, without reading prompt/response content into dashboard output.
- Claude Code local transcript token usage from `~/.claude/projects`.
- Claude Code plan limit capture from a statusline JSON file when Claude exposes those values.
- Change-only quota history for provider limit windows, stored locally without raw provider payloads.
- Gemini local usage metadata from known local Gemini telemetry/chat paths when present.
- Ollama local token capture through the optional built-in proxy logger.
- Optional OpenAI and Anthropic admin API usage/cost aggregation when admin keys are provided.
- Token history chart with per-provider color stacking, source totals, and API price comparison estimates for local/non-API usage.
- Multilingual UI with system-language detection and a settings language selector.
- Optional password login and OIDC/SSO.
- Electron builds for macOS, Linux AppImage, and Windows.

## Quick Start

Requirements:

- Node.js 22.12 or newer
- npm

```sh
npm install
npm start
```

Open <http://localhost:4177>.

By default the dashboard is local-unlocked. Set `DASHBOARD_PASSWORD` if you expose the port beyond your own machine. If `SESSION_SECRET` is unset, the server generates a random one on startup; set a stable value if you want login sessions to survive restarts.

## Desktop App

Prebuilt desktop downloads are published on the [GitHub Releases page](https://github.com/kollinger/llm-usage-dashboard/releases/latest).
Current desktop release assets are marked as unsigned prereleases until macOS notarization and Windows code signing are configured.

The installed desktop app starts at login in the background on supported platforms and keeps the local backend running even when the dashboard window is closed. This lets live quota snapshots continue to sync while the machine is awake and online; development runs with `npm run electron` do not install a login item. macOS and Windows use native login-item APIs; Linux packaged builds write an XDG autostart `.desktop` file.

Run the Electron app in development:

```sh
npm run electron
```

Build desktop packages:

```sh
npm run dist:mac
npm run dist:linux
npm run dist:win
```

Artifacts are written to `dist/`.

- macOS uses the universal DMG/ZIP build.
- Linux uses an AppImage for the build architecture; GitHub-hosted release builds produce x86_64 artifacts.
- Windows uses an x64 NSIS installer and a portable EXE.
- These artifacts contain OS-specific binaries. Renaming extensions is not enough to move between operating systems.

Windows builds can be produced on Windows directly. Cross-building from macOS or Linux may require Wine/Mono; the GitHub Actions workflow uses a native Windows runner for the most reliable Windows artifacts.

Desktop artifacts are generated release outputs and should normally not be committed to Git. Publish them through GitHub Releases or workflow artifacts.

Release builds are created by GitHub Actions when a `v*` tag is pushed. For example:

```sh
git tag v1.0.0
git push origin v1.0.0
```

Version numbers follow Semantic Versioning:

- `PATCH` for bug fixes and small non-breaking corrections: `v1.0.0` -> `v1.0.1`
- `MINOR` for new backward-compatible features: `v1.0.0` -> `v1.1.0`
- `MAJOR` for breaking changes: `v1.0.0` -> `v2.0.0`
- Preview builds should use SemVer prerelease tags such as `v1.1.0-preview.1` or `v1.1.0-rc.1`

The workflow builds macOS, Linux, and Windows packages on native GitHub-hosted runners, uploads them as workflow artifacts, and attaches them to a GitHub Release. Release artifacts are currently unsigned prereleases; macOS Gatekeeper and Windows SmartScreen may warn until code signing/notarization certificates are configured as repository secrets.

## Docker

Docker mounts the host's local tool folders read-only and persists dashboard-generated data in `./data`:

```sh
cp .env.docker.example .env
docker compose up --build
```

Open <http://localhost:4177>.

The default Compose file expects:

```text
~/.codex
~/.copilot
~/.claude
~/.gemini
```

Inside the container those folders are mounted as:

```text
/host/codex
/host/copilot
/host/claude
/host/gemini
```

For Ollama on the Linux host, Compose maps `host.docker.internal` and uses:

```text
OLLAMA_HOST=http://host.docker.internal:11434
```

## Configuration

Copy one of the example files when you need local configuration:

```sh
cp .env.example .env
```

Important variables:

```text
PORT=4177
DASHBOARD_PASSWORD=
SESSION_SECRET=
CODEX_HOME=~/.codex
LLM_USAGE_CODEX_HOMES=
CODEX_LIVE_RATE_LIMITS=true
CODEX_LIVE_RATE_LIMITS_CACHE_SECONDS=15
COPILOT_HOME=~/.copilot
CLAUDE_HOME=~/.claude
GEMINI_HOME=~/.gemini
OLLAMA_HOST=http://localhost:11434
OLLAMA_PROXY_PORT=11435
OPENAI_ADMIN_KEY=
ANTHROPIC_ADMIN_KEY=
ANTHROPIC_WORKSPACE_ID=
ANTHROPIC_API_CACHE_SECONDS=60
```

OIDC/SSO is optional:

```text
OIDC_ISSUER_URL=
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_REDIRECT_URI=http://localhost:4177/auth/oidc/callback
OIDC_SCOPE=openid profile email
```

Never commit `.env` files with real secrets.

## Localization

The frontend is localized through JSON files in `public/i18n/`. The language selector is generated from `LANGUAGE_OPTIONS` in `public/app.js`, and every supported language file must keep the same translation keys.

Supported languages: Bulgarian (`bg`), Czech (`cs`), Danish (`da`), German (`de`), Greek (`el`), English (`en`), Spanish (`es`), Estonian (`et`), Finnish (`fi`), French (`fr`), Irish (`ga`), Croatian (`hr`), Hungarian (`hu`), Italian (`it`), Lithuanian (`lt`), Latvian (`lv`), Maltese (`mt`), Dutch (`nl`), Polish (`pl`), Portuguese (`pt`), Romanian (`ro`), Slovak (`sk`), Slovenian (`sl`), Swedish (`sv`), Arabic (`ar`), Russian (`ru`), and Simplified Chinese (`zh`).

When adding or changing user-facing UI text, update every file in `public/i18n/`, keep interpolation placeholders like `{count}` identical across languages, and visually spot-check long translations and Arabic RTL layout when practical.

## Data Sources

### Codex

Codex usage is read from local JSONL session logs:

```text
$CODEX_HOME/sessions
$CODEX_HOME/archived_sessions
```

The dashboard always considers the default `~/.codex` path, the active `CODEX_HOME`, and any additional roots listed in `LLM_USAGE_CODEX_HOMES` (separated by the OS path delimiter, `:` on macOS/Linux and `;` on Windows). It deduplicates matching sessions by real path and Codex rollout session id before aggregating.

The dashboard reads `token_count` events and aggregates input, cached input, output, reasoning, 5-hour usage, 24-hour usage, all-time totals, daily history, and Codex Spark buckets when present. The `/api/usage` response includes `codex.source.codexHomes`, `codex.source.rootsScanned`, and `codex.source.duplicatesSkipped` for diagnostics.

By default, Codex rate-limit rings also try to read a live snapshot from the local Codex app-server with `account/rateLimits/read`. This is cached for 15 seconds and falls back to session logs if Codex is missing, logged out, unavailable, or disabled with `CODEX_LIVE_RATE_LIMITS=false`.

### GitHub Copilot CLI

Copilot CLI stores resumable local session data under:

```text
$COPILOT_HOME/session-state/**/events.jsonl
```

The dashboard only uses `session.shutdown` events and extracts aggregate fields such as model token totals, API duration, and `totalPremiumRequests`. It intentionally ignores prompt, response, hook, and tool payload events because those can contain source code, prompts, command arguments, and other sensitive work context.

GitHub's official Copilot usage metrics APIs are enterprise/organization reporting surfaces, not a stable personal-account token/quota API for this local-first dashboard. The dashboard also runs an isolated local quota probe through the installed Copilot CLI SDK (`account.getQuota`) when available. That probe is treated as experimental: it reads only sanitized quota snapshot fields and never prompt, response, hook, tool, or raw session payload content. Copilot CLI tokens are shown as local usage but excluded from "what this would have cost through the API" estimates.

### Claude Code

Claude Code transcript usage is read from:

```text
$CLAUDE_HOME/projects
```

Live plan limits are not part of normal transcript logs. Claude Code can expose rate-limit fields to statusline scripts for Claude.ai Pro/Max accounts, usually after the first API response in a session. The dashboard reads the sanitized capture file:

```text
~/.claude/usage-dashboard-statusline.json
```

The helper script at `scripts/claude-statusline-capture.js` can be used as a Claude Code statusline command. It keeps only quota, reset, plan, and credit metadata, writes that sanitized subset to the file above, and prints a compact status line.

Example `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/llm-usage-dashboard/scripts/claude-statusline-capture.js"
  }
}
```

Fields parsed when present:

- official Claude Code statusline quota windows: `rate_limits.five_hour.used_percentage`, `rate_limits.five_hour.resets_at`, `rate_limits.seven_day.used_percentage`, and `rate_limits.seven_day.resets_at`
- plan type from the sanitized statusline data, or from the read-only `claude auth status --json` `subscriptionType` field
- best-effort fallback aliases for older local statusline helpers
- best-effort Claude Design usage when a local statusline helper exposes it
- reset timestamps or reset labels
- usage credit fields if Claude includes them in the payload

`resets_at` values may be Unix epoch seconds, Unix epoch milliseconds, or ISO timestamps. The dashboard normalizes all three forms before display.

When the desktop sync observes quota or credit changes, the dashboard appends a sanitized change event to:

```text
data/quota-events.jsonl
```

Events are written only when relevant values change, such as utilization percentage, reset time, sync status, or credit utilization. Each event stores provider, window key, timestamps, percentage, reset time, source label, and similar aggregate metadata. It does not store cookies, raw API responses, prompts, tool payloads, account IDs, or transcript content. Finished window summaries can be derived from these change events through `/api/quota-history`.

The dashboard does not read Claude prompt text, tool inputs, tool outputs, full statusline payloads, or internal Claude session/cache files for quota data. Transcript scanning is limited to assistant usage counters in `~/.claude/projects`; live quota values come only from the statusline capture file and the read-only auth status plan field. Some Claude account UI fields, such as routines or usage credits, may not be available through a stable documented local API; those fields stay empty until a stable provider-specific local source exposes them.

### Crawler Watchdog

Use the watchdog to verify that the existing Codex and Claude readers still match current local payloads or safe fixtures:

```sh
node scripts/crawler-watchdog.mjs --fixture test/fixtures/crawler-watchdog/baseline
node scripts/crawler-watchdog.mjs --live
node scripts/crawler-watchdog.mjs --fixture test/fixtures/crawler-watchdog/codex-missing-field --print-trigger
```

Exit codes:

- `0` = `ok`
- `1` = `needsCrawlerUpdate`
- `2` = `authMissing`
- `3` = `notTestable`
- `4` = `toolError`
- `5` = `invalidArgs`

The JSON report includes provider, component, drift type, expected vs observed fields, fixture/live source, detection time, exit code, next action, and an optional dedupe-friendly trigger block for later ticket automation.

### Gemini

Gemini usage is read from local metadata fields such as `usageMetadata`, `usage_metadata`, or Gemini CLI `tokens` stats in known Gemini paths:

```text
~/.gemini/telemetry.log
~/.gemini/tmp/**
~/.gemini/chats/**
~/.gemini/telemetry/**
```

If Gemini telemetry or local chat logs are unavailable, the Gemini card stays empty.

### Ollama

The dashboard can start an Ollama-compatible proxy on:

```text
http://localhost:11435
```

It forwards requests to `OLLAMA_HOST` and appends captured usage to:

```text
data/ollama-usage.jsonl
```

Example:

```sh
OLLAMA_HOST=http://localhost:11435 ollama run gemma3:27b
```

If no clients use the proxy, there is no historical Ollama token data to display.

### OpenAI and Anthropic APIs

Optional admin keys enable backend-only API usage/cost aggregation:

```sh
OPENAI_ADMIN_KEY="..." ANTHROPIC_ADMIN_KEY="..." npm start
```

Admin keys stay on the server. The browser receives only aggregated usage/cost data.

Anthropic admin keys also enable configured organization rate-limit display through `GET /v1/organizations/rate_limits`. Set `ANTHROPIC_WORKSPACE_ID` to additionally read workspace-level overrides. These rate limits are cached for 60 seconds because they are configured limits, not a per-second live usage counter.

Consumer subscription usage, such as ChatGPT or Claude plan UI data, is not generally available through the same API keys. The dashboard only shows those counters when a stable local provider-specific telemetry source exposes them.

The pricing section is mainly a comparison view for local or consumer-style usage: it applies public API price tables to locally observed token counts so non-API users can estimate what similar API usage might cost. Those estimates are not provider invoices and do not imply that consumer subscription usage is available through the admin APIs. Provider subscription counters, such as Copilot premium requests or AI credits, are kept out of the API-cost estimate.

Model quality scores in the pricing table are an internal heuristic for quick sorting and visual comparison. They are not an official benchmark, not a provider claim, and should be recalibrated or removed when a better documented scoring method is adopted.

Refresh the curated API price table and latest ECB USD/EUR reference rate with:

```sh
npm run pricing:update
```

The script rewrites the pricing metadata, model rows, and internal heuristic scores in `public/app.js` from `scripts/update-pricing-data.mjs`. Review current provider pricing and model-quality signals before changing the review dates in that script.

## Implementation Status

### Implemented

- Codex local usage and live quota display: the dashboard reads `token_count` history and tries the local Codex app-server for live rate-limit snapshots when available.
- Copilot CLI local usage: shutdown metrics are supported without reading prompt, response, hook, or tool payload content into dashboard output. Experimental live quota snapshots are read through the local Copilot SDK when the installed CLI exposes them.
- Claude Code local usage and live limits: transcript usage, statusline setup, sanitized quota capture, change-only quota history, 5-hour and 7-day reset display, stale-limit detection, and app-driven Claude Code launch are supported.
- Gemini local usage: known telemetry and chat metadata paths are scanned when present.
- Ollama local usage: the optional proxy logger can capture Ollama-compatible usage into `data/ollama-usage.jsonl`.
- OpenAI and Anthropic API reporting: minimal admin-key aggregation is available for usage, cost, and configured Anthropic organization/workspace rate limits.
- Pricing comparison and model scores: public API price rows can be compared against local usage, and model quality scores are displayed as an internal heuristic.

### Known Limits

- Codex live quota source: the Codex app-server interface is local and experimental, so session log parsing remains the durable history source.
- Copilot usage coverage: IDE completions, warning thresholds, and exact subscription quota window semantics are not exposed through a stable personal local/API source today. SDK quota snapshots are shown only when the installed CLI returns explicit fields.
- Consumer subscription counters: ChatGPT, Claude, Copilot, Gemini, and similar consumer-plan usage fields are only shown when local telemetry, statusline capture, or admin APIs expose them.
- Desktop signing: GitHub Actions publishes unsigned prerelease desktop artifacts until macOS notarization and Windows code signing are configured.

### Open To-Dos

- Copilot quota windows: map returned Copilot SDK quota snapshot keys or response headers to exact session/5-hour, 7-day/weekly, premium-request, chat, and completion semantics before labeling them as those windows in the UI.
- Model quality scores: review every model score against current model capabilities, public benchmark signals, real-world usefulness, context/window limits, multimodal/tool strengths, and price/performance tradeoffs; update or remove scores that do not make sense.
- Desktop signing: enroll in Apple Developer Program, add Developer ID signing and notarization for macOS, add Windows code signing, store the required certificates/credentials in GitHub Secrets, then remove the prerelease marker from signed release builds.
- API customer reporting: expand OpenAI and Anthropic admin reporting with longer history, pagination, per-project/API-key/workspace grouping, and broader endpoint categories while keeping the default local-first mode useful without provider API keys.
- Provider data gaps: keep new provider-specific local sources documented as they become stable enough to trust.

## Author and License

Created by [Gerhard Kollinger](https://github.com/kollinger) <gerhard@kollinger.at>.

Released under the [MIT License](LICENSE).

## Privacy and Git Safety

This project reads highly personal local usage metadata. Before committing or publishing, check that no local data or secrets are staged.

Do not commit:

- `data/`
- `dist/`
- `node_modules/`
- `.env`
- `.env.*` except the example files
- local logs
- API keys or admin keys
- OAuth client secrets
- raw Claude/Codex/Gemini transcripts
- local absolute paths from a personal machine

The repository `.gitignore` excludes these by default. Release builds should be uploaded as GitHub Release assets or workflow artifacts, not stored in Git.

Useful checks:

```sh
npm run check
git status --ignored
rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' --glob '!data/**' 'sk-|client_secret|refresh_token|access_token|/Users/|api[_-]?key|admin[_-]?key' .
```

## Repository Layout

```text
server.js                         Express API and usage parsers
public/index.html                 App shell
public/app.js                     Frontend state, charts, rendering
public/styles.css                 Dashboard styling
public/i18n/*.json                Localized frontend strings
electron/main.js                  Electron wrapper around the local server
scripts/claude-statusline-capture.js
Dockerfile
docker-compose.yml
.github/workflows/desktop-build.yml
build/                            App icon and DMG background assets
```

Ignored local/generated paths:

```text
data/
dist/
node_modules/
.env
```

## Verification

Run the syntax check:

```sh
npm run check
```

Build checks:

```sh
docker build -t llm-usage-dashboard:local .
npm run dist:mac
npm run dist:linux
npm run dist:win
```

The GitHub Actions workflow `Desktop builds` can build macOS, Linux, and Windows artifacts from tags or manual workflow dispatch.
