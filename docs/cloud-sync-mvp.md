# Private Cloud Sync MVP

Status: implemented locally for KOL-409/KOL-554. Production deployment and
public exposure remain separate release gates.

## Scope and defaults

Cloud sync is opt-in and disabled by default. When it is disabled, unpaired,
or temporarily unreachable, the existing local dashboard remains the source of
truth and continues to work without a sync server.

The MVP uses deliberate, short-lived pairing codes:

1. Enable the private collector on one trusted dashboard server.
2. Create a private sync space from the first device.
3. Generate a one-time pairing code from a connected device.
4. Enter that code on each additional device.
5. Choose **All devices**, **This device**, a named device, or **Unknown
   device** from the dashboard filter.

Pairing codes expire after ten minutes by default, are capped at one hour, and
cannot be reused. Device bearer tokens and pairing codes are stored only as
salted or one-way hashes on the collector. The local device token is kept in
the ignored dashboard data directory with owner-only permissions on POSIX
systems and is never returned by a browser-facing status endpoint.

## Architecture

Each installed dashboard contains a local sync client. It extracts only the
allow-listed fields below from normalized provider usage events, persists them
to a restart-safe outbox, and uploads bounded batches. Successful event keys
are persisted separately so a restart cannot upload and count them again.
Conflicts are removed from the retry queue and quarantined locally for
inspection. Network failures retain the outbox and use bounded exponential
backoff.

The private collector stores:

- `registry.json`: spaces, devices, hashed device tokens, and hashed pairing
  codes.
- `events.jsonl`: append-only normalized usage records with a SHA-256 commit
  chain.
- `conflicts.jsonl`: rejected same-key/different-payload audit records.
- `reconcile-backups/`: backups created before an explicit repair.

Collector files live under `data/cloud-sync/`; local settings, credentials,
outbox, acknowledged keys, and status live under `data/cloud-sync-client/`.
`LLM_USAGE_DATA_DIR` changes the common dashboard data root. Both directories
are local state and must not be committed.

## Event contract and global deduplication

The collector accepts `usage_event` and `usage_snapshot` records. An event is
identified globally within a sync space by:

```text
providerId + sourceEventSha256
```

`sourceEventSha256` is calculated from the original source event or snapshot
before device, file-path, ingestion-time, or pricing metadata is added. This
makes copied archives and the same source observed by two devices idempotent.
The first append wins. Re-uploading the same identity and payload is a benign
duplicate; reusing the identity with a different normalized payload is a
conflict and returns HTTP `409` without overwriting history.

Allow-listed fields are:

- provider, model, source timestamp, and token buckets
- token-field coverage and `priced`/`unpriced`/`unknown` price coverage
- normalized task/thread/turn/session/run/project/ticket lineage
- normalized AI runtime duration and start/end timestamps
- schema/collector/source revision metadata
- snapshot window boundaries

Lineage values are identifiers only. They do not contain titles or content.
The collector rejects unknown or privacy-sensitive fields recursively,
including prompts, transcripts, messages, raw payloads/logs, cookies, API or
OAuth credentials, account IDs, email addresses, usernames, absolute paths,
process commands, and command lines. The assigned device ID comes from the
authenticated bearer token rather than the upload body. Records that truly
lack device attribution remain queryable through the explicit **Unknown
device** filter and are never silently reassigned.

## Integrity, reconciliation, and coverage

Every appended record contains `previousCommitSha256` and `commitSha256`.
Verification recomputes payload hashes, event keys, and the complete chain;
it reports malformed rows, duplicates, conflicts, and a bounded sample of
errors. Uploads stop with HTTP `409` while verification is invalid.

Reconciliation is an explicit admin operation. It first creates a backup,
then deterministically sorts valid normalized records, keeps the first payload
for each global identity, audits conflicting payloads, and rebuilds the chain.
Malformed or digest-invalid rows remain in that backup and are recorded only
by content digest in the repair audit; they are not trusted as canonical
usage. Reconciliation never silently chooses a later conflicting value.

Query responses expose coverage rather than inventing precision:

- token-field coverage by bucket
- priced, unpriced, and unknown price counts
- confirmed/strong/weak/unassigned lineage counts
- uploader-attributed and unknown-device counts
- current ledger integrity and per-device totals

## Private collector API

Collector routes exist only when `LLM_USAGE_SYNC_COLLECTOR_ENABLED=true`.
Device routes use `Authorization: Bearer <device token>`. Admin routes use
`Authorization: Bearer <LLM_USAGE_SYNC_COLLECTOR_ADMIN_TOKEN>` when that token
is configured; otherwise they fall back to normal dashboard authentication,
which is suitable only for a trusted local/private installation.

- `POST /api/sync/spaces` — create a space and its first device (admin).
- `POST /api/sync/pairing-codes` — create a one-time code (device).
- `POST /api/sync/devices` — join using a pairing code.
- `GET /api/sync/devices` — list active devices in the caller's space.
- `DELETE /api/sync/devices/:id` — revoke a device (device).
- `POST /api/sync/usage` — append normalized events/snapshots (device).
- `GET /api/sync/usage` — aggregate by all/this/explicit/unknown device and
  optional provider (device).
- `GET /api/sync/integrity` — verify the ledger (device).
- `POST /api/sync/reconcile` — back up and rebuild the ledger (admin).

The browser talks only to authenticated local proxy endpoints under
`/api/sync/local/*`. These endpoints expose safe connection status, settings,
device lists, aggregate usage, pairing, manual sync, and disconnect actions;
they never expose the stored bearer token.

## Configuration

```text
LLM_USAGE_SYNC_COLLECTOR_ENABLED=false
LLM_USAGE_SYNC_COLLECTOR_ADMIN_TOKEN=
LLM_USAGE_SYNC_SERVER_URL=
LLM_USAGE_SYNC_INTERVAL_SECONDS=60
```

- `LLM_USAGE_SYNC_COLLECTOR_ENABLED` enables the private collector routes.
- `LLM_USAGE_SYNC_COLLECTOR_ADMIN_TOKEN` protects space creation and repair.
- `LLM_USAGE_SYNC_SERVER_URL` pre-fills the local client's server URL.
- `LLM_USAGE_SYNC_INTERVAL_SECONDS` sets capture/upload cadence; values are
  clamped to a safe minimum.

For a remotely reachable collector, use HTTPS, set both dashboard auth and a
long random collector admin token, restrict network access, back up the data
directory, and treat public DNS/deployment as a separate operational review.

## Verification

Focused automated coverage is available through:

```sh
npm run test:sync-smoke
node test/sync-ledger.test.mjs
node test/sync-client.test.mjs
node test/codex-archive-dedupe.test.mjs
node test/sync-ui.test.mjs
```

The tests exercise deliberate two-device pairing, expired/replayed codes,
restart-safe outboxes, offline retry, cross-device and copied-archive
deduplication, conflict rejection, filters including unknown attribution,
privacy rejection, coverage metadata, corruption detection, deterministic
reconciliation with backups, local-only behavior, and browser-safe APIs.
