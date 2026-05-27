# LLM Usage Dashboard

Local-first dashboard for LLM usage, rate limits, token logs, and API cost estimates across Codex, Claude Code, Gemini, Ollama, OpenAI, and Anthropic.

The app is intentionally simple: a Node.js/Express backend serves a vanilla HTML/CSS/JavaScript frontend. Electron packages the same local dashboard as a desktop app, and Docker is available for server-style installs.

## Features

- Codex local token usage from `~/.codex/sessions` and `~/.codex/archived_sessions`.
- Codex Spark / research quota detection from Codex `token_count` events when available.
- Claude Code local transcript token usage from `~/.claude/projects`.
- Claude Code plan limit capture from a statusline JSON file when Claude exposes those values.
- Gemini local usage metadata from known local Gemini telemetry/chat paths when present.
- Ollama local token capture through the optional built-in proxy logger.
- Manual quota and credit tracking for Claude, Gemini, and GPT/OpenAI where providers do not expose stable local APIs.
- Optional OpenAI and Anthropic admin API usage/cost aggregation when admin keys are provided.
- Token history chart with per-provider color stacking, source totals, and API price comparison estimates.
- Optional password login and OIDC/SSO.
- Electron builds for macOS and Linux AppImage.

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
- Linux uses the x86_64 AppImage.
- Windows uses an x64 NSIS installer and a portable EXE.
- These artifacts contain OS-specific binaries. Renaming extensions is not enough to move between operating systems.

Windows builds can be produced on Windows directly. Cross-building from macOS or Linux may require Wine/Mono; the GitHub Actions workflow uses a native Windows runner for the most reliable Windows artifacts.

Desktop artifacts are generated release outputs and should normally not be committed to Git. Publish them through GitHub Releases or workflow artifacts.

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
~/.claude
~/.gemini
```

Inside the container those folders are mounted as:

```text
/host/codex
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
CLAUDE_HOME=~/.claude
GEMINI_HOME=~/.gemini
OLLAMA_HOST=http://localhost:11434
OLLAMA_PROXY_PORT=11435
OPENAI_ADMIN_KEY=
ANTHROPIC_ADMIN_KEY=
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

## Data Sources

### Codex

Codex usage is read from local JSONL session logs:

```text
$CODEX_HOME/sessions
$CODEX_HOME/archived_sessions
```

The dashboard reads `token_count` events and aggregates input, cached input, output, reasoning, 5-hour usage, 24-hour usage, all-time totals, daily history, and Codex Spark buckets when present.

### Claude Code

Claude Code transcript usage is read from:

```text
$CLAUDE_HOME/projects
```

Live plan limits are not part of normal transcript logs. Claude Code can expose rate-limit fields to statusline scripts, so this dashboard also reads:

```text
~/.claude/usage-dashboard-statusline.json
```

The helper script at `scripts/claude-statusline-capture.js` can be used as a Claude Code statusline command. It captures the JSON payload, writes it to that file, and prints a compact status line.

Fields parsed when present:

- plan type
- current session / 5-hour usage
- weekly all-models usage
- Claude Design usage
- reset timestamps or reset labels
- usage credit fields if Claude includes them in the payload

Some Claude account UI fields, such as routines or usage credits, may not be available through a stable documented local API. Those can be tracked manually in the dashboard settings.

The `Guthaben anzeigen` setting controls whether a credit block is shown even when every amount is still zero. Any entered credit amount or monthly limit also makes the block visible automatically.

### Gemini

Gemini usage is read from local metadata fields such as `usageMetadata` or `usage_metadata` in known Gemini paths:

```text
~/.gemini/telemetry.log
~/.gemini/tmp/**
~/.gemini/chats/**
~/.gemini/telemetry/**
```

If Gemini telemetry or local chat logs are unavailable, the Gemini card stays empty unless manual limits are entered.

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

Consumer subscription usage, such as ChatGPT or Claude plan UI data, is not generally available through the same API keys. Use manual quota/credit fields unless a local provider-specific telemetry source exposes it.

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
