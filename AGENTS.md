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
- Restore review-facing UI state after QA. If a check turns on persisted
  controls such as `Show all` providers, layout edit mode, alternate filters,
  or diagnostic-only views, switch back to the normal review state before
  handing the app to Gerhard, or explicitly call out the changed state.
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

For every review handoff that includes app-visible behavior, create this fresh
M1 macOS review build even when implementation, Docker, broad builds, or browser
QA ran on Manjaro. Record the source branch/commit and included tickets with the
handoff so review never comes from an older local Git state or stale artifact.

## Versioning

- Use Semantic Versioning for releases and tags: `MAJOR.MINOR.PATCH` (for example `v1.4.2`).
- Increase `PATCH` for bug fixes, copy tweaks, small UI/layout fixes, dependency bumps without user-visible behavior changes, and packaging-only fixes.
- Increase `MINOR` for new backward-compatible features, new providers, new settings, new views, or new export/reporting capabilities.
- Increase `MAJOR` for breaking changes, including removed features, incompatible config changes, changed data formats, changed default behavior that can break existing usage, or required migration steps.
- For preview/testing releases, use SemVer prerelease tags instead of reusing the same main version: `v1.2.0-preview.1`, `v1.2.0-preview.2`, `v1.2.0-rc.1`, then `v1.2.0`.
- If the product is still considered not yet stable, prefer `0.x.y` releases and treat any substantial new feature or behavior change as at least a `MINOR` bump.
- Use Conventional Commits where practical so release intent is obvious: `fix:` maps to `PATCH`, `feat:` maps to `MINOR`, and `!` or `BREAKING CHANGE:` maps to `MAJOR`.
- Treat GitHub prerelease status as separate from the version number. `prerelease` means the asset is not final; it does not replace SemVer patch/minor/major increments.
- Every GitHub release or review build that is announced outside the repo must
  have a clear version and a short changelog or release-notes summary. Do not
  announce "new build" without stating the version/tag or commit.
- Before creating a release tag, update the app version in `package.json` and
  `package-lock.json`, then prepare release notes or a changelog section for
  that exact version. Summarize noisy UI batches into user-facing groups such
  as "general UI improvements" instead of listing every tiny visual tweak.
- When a WhatsApp release/update message is needed, include a compact
  changelog summary plus a GitHub release link when available. If the changelog
  is long, mention only the most important user-visible changes and link the
  full release notes.
- Do not claim auto-update delivery unless the released GitHub assets include
  the updater metadata expected by Electron Updater, such as `latest*.yml`
  files, and the packaged app has been verified to detect the release. If that
  is not verified, send a normal download/update-available message instead.

## WhatsApp Review Gateway

- The intended WhatsApp review group name is `LLM Usage Dashboard Review`
  unless Gerhard explicitly chooses another name.
- The review bot is addressed with `@Opus`. Every WhatsApp reply from that bot
  must start with the visible identity prefix `🤖 [Opus]`.
- The route should accept messages from Gerhard Kollinger and Reinhard
  Schneidewind only, and should support voice notes through the reviewed
  WhatsApp Agent Gateway audio transcription path.
- The bot may have project-admin authority for the LLM Usage Dashboard on the
  Manjaro runner: inspect and change this repository, create branches, commit,
  push, run checks, run Linux builds, inspect GitHub Actions and releases, and
  coordinate Multica implementation tickets and lifecycle watches. This does
  not grant unrelated machine administration, unrelated project access,
  destructive system changes, secret disclosure, or external sends beyond the
  reviewed route contract.
- Reinhard may discuss changes with `@Opus`, but a Multica issue for this
  product may be created only after Gerhard explicitly approves the concrete
  ticket draft in the same WhatsApp group. After approval, implementation
  should run through Multica on Manjaro with the usual GPT+Opus owner/reviewer
  pattern and a durable heartbeat/lifecycle watch until the ticket is truthfully
  done, blocked, cancelled, pushed, released, and announced back to the
  WhatsApp group.
- For approved WhatsApp Review Gateway tickets, release is fully delegated:
  after the ticket reaches truthful `done`, the gateway/heartbeat should
  automatically bump the preview version, update the changelog, commit, tag,
  push, wait for the GitHub desktop-build release, verify release assets and
  updater metadata, then send the WhatsApp update message with version,
  download/update status, GitHub release link, and short changelog. Gerhard is
  not an additional release/send gate for this reviewed route.
- Prefer resolving Reinhard and the review group through the Manjaro WhatsApp
  bridge contacts/chats by name. A newly created group may need to sync into
  the bridge first, but agents should not require Reinhard to send a dummy
  message merely to identify him or the group.

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
- Still stop for Gerhard before destructive actions, account/signing/permission
  changes, public tunnels, live database writes, or unresolved product
  decisions. For approved WhatsApp Review Gateway tickets in this product,
  main integration, preview release tags, GitHub release publication, and the
  matching WhatsApp release announcement are delegated to the automated
  gateway/heartbeat workflow above.
- Confirm that `git status --ignored` shows `data/`, `dist/`, `node_modules/`, and `.env` files as ignored.
- Keep commits focused: code, documentation, packaging, and generated release artifacts should not be mixed unless explicitly requested.
