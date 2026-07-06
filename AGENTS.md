# AGENTS.md

Instructions for agents working on this repository.

## Project Shape

- This is a local-first LLM usage dashboard.
- Backend: Node.js 22 + Express in `server.js`.
- Frontend: vanilla HTML/CSS/JavaScript in `public/`.
- Desktop builds: Electron + electron-builder in `electron/` and `package.json`.
- Docker runtime: `Dockerfile` and `docker-compose.yml`.

## Privacy Rules

- Never commit local usage data, logs, generated app artifacts, installed dependencies, or secrets.
- Keep these paths out of Git:
  - `data/`
  - `dist/`
  - `node_modules/`
  - `.env`
  - `.env.*` except checked-in example files
- Do not commit API keys, admin keys, OAuth client secrets, session secrets, account IDs, local absolute paths, transcript contents, or raw provider payloads.
- If you add new local state, logs, caches, or generated files, update `.gitignore` before creating a commit.
- Example files may show placeholder variable names, but must not contain real credentials.

## Development

- Use Node.js 22 or newer.
- Install dependencies with `npm install` or `npm ci`.
- Run the web dashboard with `npm start`.
- Run the desktop app in development with `npm run electron`.
- When a requested check only needs the dashboard HTTP server, first check
  whether the installed desktop app is already listening on a local app port
  and reuse that port when practical. The web dashboard default is
  `http://localhost:4177`; the installed desktop app normally uses a dynamic
  free port.
- Use existing vanilla JS/CSS patterns unless there is a clear reason to add tooling.
- Keep frontend changes responsive and verify visually when practical.
- Keep user-facing frontend text in `public/i18n/*.json`; do not add new hard-coded UI copy unless it is data/provider content that should not be translated.
- When changing localized UI text, update every supported language file in `public/i18n/` and keep interpolation placeholders identical across languages.
- For localization changes, run `npm run check`, verify translation key/placeholder consistency, and visually spot-check long translations and Arabic RTL when practical.

## Delivery Rhythm

- Keep the queue moving: after a ticket is implemented, verified, integrated,
  recorded, and cleaned up, continue directly with the next eligible ticket
  unless a real Gerhard review or decision gate is reached.
- Prefer small, reversible ticket branches and commits. Each step should be
  independently understandable, pushable, and easy to revert or adjust.
- Treat local integration into the current review/integration branch as normal
  delivery work, not as a separate Gerhard gate, as long as it does not cross a
  release, production, account, permission, data-loss, or product-decision gate.
- Use Gerhard's M1 for Mac-specific desktop builds, installation, launch,
  notification, and UI-state checks. Do heavier implementation, Docker, and
  broad QA on the Manjaro runner when available.
- Batch macOS app builds for meaningful review points instead of rebuilding for
  every tiny change. When installing a fresh Mac build, state the commit,
  included tickets, and the exact things Gerhard should look at.
- Do not let cleanup lose recoverability: clean worktrees, stale processes, and
  generated artifacts, but keep ticket branches until their integration and
  closure are recorded or until Gerhard explicitly approves deletion.

## System Metrics and Cross-Platform Features

- System or live-load features must be safe on macOS, Windows, and Linux.
- If a metric cannot be read reliably on a platform, return and render it as unavailable instead of inventing a value.
- Label metric quality visibly: measured, calculated from logs, estimated, or unavailable.
- Do not expose raw process lists, command lines, prompts, transcripts, raw log lines, provider payloads, or secrets through live-metric APIs or UI.
- Keep real zero values distinct from unavailable values, especially for token throughput and time-series charts.

## Verification

Before proposing a commit, run:

```sh
npm run check
```

Before proposing a commit or calling a change fully tested, include Docker
verification. At minimum, rebuild the container image:

```sh
docker build -t llm-usage-dashboard:local .
```

When the change touches runtime behavior, startup, networking, data paths, auth,
provider integrations, or packaging-adjacent behavior, also run the app through
Docker Compose and smoke-test the dashboard locally before stopping it again.

For packaging changes, also verify the relevant build:

```sh
npm run dist:mac
npm run dist:linux
npm run dist:win
docker build -t llm-usage-dashboard:local .
```

Desktop artifacts are written to `dist/` and should normally be published as release artifacts, not committed.

For final macOS desktop verification on Gerhard's machine, build a fresh DMG
with `npm run dist:mac`, install the app from that DMG into `/Applications`, and
launch the installed `/Applications/LLM Usage Dashboard.app` directly. Do not
treat a desktop build as final based only on `npm run electron`, `dist:dir`, or
an older `dist/` artifact.

## Versioning

- Use Semantic Versioning for releases and tags: `MAJOR.MINOR.PATCH` (for example `v1.4.2`).
- Increase `PATCH` for bug fixes, copy tweaks, small UI/layout fixes, dependency bumps without user-visible behavior changes, and packaging-only fixes.
- Increase `MINOR` for new backward-compatible features, new providers, new settings, new views, or new export/reporting capabilities.
- Increase `MAJOR` for breaking changes, including removed features, incompatible config changes, changed data formats, changed default behavior that can break existing usage, or required migration steps.
- For preview/testing releases, use SemVer prerelease tags instead of reusing the same main version: `v1.2.0-preview.1`, `v1.2.0-preview.2`, `v1.2.0-rc.1`, then `v1.2.0`.
- If the product is still considered not yet stable, prefer `0.x.y` releases and treat any substantial new feature or behavior change as at least a `MINOR` bump.
- Use Conventional Commits where practical so release intent is obvious: `fix:` maps to `PATCH`, `feat:` maps to `MINOR`, and `!` or `BREAKING CHANGE:` maps to `MAJOR`.
- Treat GitHub prerelease status as separate from the version number. `prerelease` means the asset is not final; it does not replace SemVer patch/minor/major increments.

## Commit Hygiene

- Routine ticket work is delegated: agents may commit and push focused changes
  on isolated ticket branches after the relevant checks pass, the diff is
  reviewed, ignored/private paths are excluded, and the commit SHA plus
  verification evidence are recorded in the ticket.
- Keep one coherent user-visible outcome per ticket commit whenever practical.
  If a workflow/policy change is needed, commit it separately from product code.
- Do not wait for Gerhard before routine ticket commits or ticket-branch pushes
  when the work is reversible in Git and does not cross a release, production,
  account, permission, secret, data-loss, or product-decision gate.
- Integration on Gerhard's Mac and local Mac-app test builds are allowed without
  a separate gate when they are useful review builds. Batch them for meaningful
  updates so the M1 is not kept busy for every tiny change.
- Still stop for Gerhard before production deploys, releases, tags, main merges,
  destructive actions, account/signing/permission changes, public tunnels, live
  database writes, or unresolved product decisions.
- Confirm that `git status --ignored` shows `data/`, `dist/`, `node_modules/`, and `.env` files as ignored.
- Keep commits focused: code, documentation, packaging, and generated release artifacts should not be mixed unless explicitly requested.
