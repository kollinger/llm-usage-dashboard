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
- Do implementation, Docker, and broad QA on the Manjaro runner. Build release
  artifacts with the existing GitHub Actions desktop-build workflow on its
  platform runners, including macOS builds and required native macOS checks.
- Gerhard's M1 is an update recipient, not a build or release-verification
  runner. It receives the completed release through the normal app updater.
  Its availability, SSH access, local DMG creation, installation, or manual
  review must not block ordinary ticket completion, release, or announcement.
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

For macOS release verification, use the fresh artifact from the existing macOS
CI job for the exact release commit/tag. Verify required checks, expected assets,
checksums, and updater metadata; an older local artifact or `npm run electron`
does not establish release delivery. Required native/IPC or packaging checks
belong on an appropriate macOS CI runner, not on Gerhard's M1 by default.

Do not add a fresh M1 DMG build/install/launch gate to app-visible handoffs.
An optional check of the installed M1 app happens after release and is recorded
separately from CI/release verification. Do not claim that the M1 installed an
update unless its actual installed version was observed. Restore review-facing
UI state after any optional local check.

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
- The review bot runs as GPT-6.1 Sol with maximum reasoning. It accepts ordinary
  messages from the two allowed group members without a mention by default;
  `@Sol` and the compatibility alias `@Opus` remain usable. The existing Support
  Console trigger can switch between all messages and mentions. Every WhatsApp
  reply uses the truthful identity prefix `🤖 [Sol 6.1]`.
- The review route must use the shared project-bound Sol admin runner, start in
  `/srv/multica/projects/llm-usage-dashboard`, and have shell/file access to
  that repository. Its live model, workdir, display name, mention, and response
  prefix must pass gateway validation together so a model switch cannot leave
  stale identity or repository permissions behind.
- The route should accept messages from Gerhard Kollinger and Reinhard
  Schneidewind only, and should support voice notes through the reviewed
  WhatsApp Agent Gateway audio transcription path.
- Never ask Gerhard or Reinhard to operate internal fixtures, replay reactions,
  validate routing, or perform gateway E2E/QA steps. Run those checks
  synthetically or through an internal operator path. A question in the review
  group is allowed only for a real product decision and must explain the
  visible outcome and the effect of approval in plain language; parked test
  tickets, lifecycle-watch mechanics, and other test scaffolding are not user
  tasks.
- The bot may have project-admin authority for the LLM Usage Dashboard on the
  Manjaro runner: inspect and change this repository, create branches, commit,
  push, run checks, run Linux builds, inspect GitHub Actions and releases, and
  coordinate Multica implementation tickets and lifecycle watches. This does
  not grant unrelated machine administration, unrelated project access,
  destructive system changes, secret disclosure, or external sends beyond the
  reviewed route contract.
- Gerhard and Reinhard may both directly request ordinary product changes.
  A clear request authorizes ticket creation and delivery without an additional
  Gerhard approval. Clarify ambiguous product requirements with the requester.
  Implementation runs through Multica on Manjaro with the configured owner and
  independent reviewer and a durable lifecycle watch through integration,
  preview release and group announcement. Do not assign routine product work
  to Gerhard just to obtain a release or implementation approval. Destructive,
  account, payment, secret and unrelated-project boundaries remain in force;
  changing bot permissions retains its separate self-change contract.
- For approved WhatsApp Review Gateway tickets, release is fully delegated:
  after the ticket reaches truthful `done`, the gateway/heartbeat should
  automatically bump the preview version, update the changelog, commit, tag,
  push, wait for the GitHub desktop-build release, verify release assets and
  updater metadata, then send the WhatsApp update message with version,
  download/update status, GitHub release link, and short changelog. Gerhard is
  not an additional release/send gate for this reviewed route.
- Every published GitHub release for this product must be announced in `LLM
  Usage Dashboard Review`, regardless of whether its work originated in
  WhatsApp, Codex, Multica, GitHub, or another approved workflow. The Manjaro
  Gateway heartbeat owns this source-independent check, deduplicates by release
  tag, and routes the announcement through the same asset/updater verification
  and audited send path. This announcement rule does not itself authorize a
  release that otherwise still requires a release gate.
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
- Routine integration and release preparation stay on the responsible runner;
  the existing CI builds the desktop artifacts. Do not start local test builds
  on Gerhard's M1 or wait for its availability as part of ordinary delivery.
- Still stop for Gerhard before destructive actions, account/signing/permission
  changes, public tunnels, live database writes, or unresolved product
  decisions. For approved WhatsApp Review Gateway tickets in this product,
  main integration, preview release tags, GitHub release publication, and the
  matching WhatsApp release announcement are delegated to the automated
  gateway/heartbeat workflow above.
- Confirm that `git status --ignored` shows `data/`, `dist/`, `node_modules/`, and `.env` files as ignored.
- Keep commits focused: code, documentation, packaging, and generated release artifacts should not be mixed unless explicitly requested.
