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
- Use existing vanilla JS/CSS patterns unless there is a clear reason to add tooling.
- Keep frontend changes responsive and verify visually when practical.
- Keep user-facing frontend text in `public/i18n/*.json`; do not add new hard-coded UI copy unless it is data/provider content that should not be translated.
- When changing localized UI text, update every supported language file in `public/i18n/` and keep interpolation placeholders identical across languages.
- For localization changes, run `npm run check`, verify translation key/placeholder consistency, and visually spot-check long translations and Arabic RTL when practical.

## Verification

Before proposing a commit, run:

```sh
npm run check
```

For packaging changes, also verify the relevant build:

```sh
npm run dist:mac
npm run dist:linux
npm run dist:win
docker build -t llm-usage-dashboard:local .
```

Desktop artifacts are written to `dist/` and should normally be published as release artifacts, not committed.

## Commit Hygiene

- Do not commit automatically.
- Before committing, show the planned files and a proposed commit message.
- Confirm that `git status --ignored` shows `data/`, `dist/`, `node_modules/`, and `.env` files as ignored.
- Keep commits focused: code, documentation, packaging, and generated release artifacts should not be mixed unless explicitly requested.
