# Cloud Sync MVP

Status: draft for KOL-409.

## Goal

Let multiple installed LLM Usage Dashboard apps contribute normalized usage to
one private sync space, then let the dashboard show totals for all devices, this
device, or one selected device.

Sync must stay optional. A local-only install must keep working exactly as it
does today.

## Recommended MVP Decision

Use an explicit pairing-code model for the first version.

- The first dashboard creates or joins a sync space after the user enables sync.
- Additional devices join that sync space with a short-lived pairing code or
  link shown by an already trusted device.
- Provider account hints may be shown later, but must never auto-merge devices.

This is lower risk than account-fingerprint auto-discovery and simpler than a
full multi-tenant SaaS login system for the first private MVP.

## Non-Negotiable Privacy Boundary

Upload only normalized, aggregate usage data.

Do not upload:

- prompts, transcripts, raw provider payloads, or local log lines
- cookies, API keys, OAuth tokens, account IDs, or email addresses
- local absolute file paths, process lists, command lines, or usernames

Device names are user-visible labels. The app should propose a safe default
such as `MacBook Pro` or `Manjaro Home`, but the user can rename it before
enabling sync.

## Data Model

```text
sync_space
  id
  display_name
  created_at

device
  id
  sync_space_id
  display_name
  platform
  app_version
  created_at
  last_seen_at

usage_snapshot
  sync_space_id
  device_id
  provider_id
  window_key
  snapshot_started_at
  snapshot_ended_at
  captured_at
  input_tokens
  cache_creation_input_tokens
  cached_input_tokens
  output_tokens
  reasoning_output_tokens
  total_tokens
  event_count
  source_quality
  dedup_key

daily_usage
  sync_space_id
  device_id
  provider_id
  date
  input_tokens
  cache_creation_input_tokens
  cached_input_tokens
  output_tokens
  reasoning_output_tokens
  total_tokens
  source_quality
  dedup_key
```

`dedup_key` should be deterministic from `device_id`, `provider_id`, the
window/date, and a stable local source revision. Re-uploading the same snapshot
must replace or upsert, not add.

## API Shape

Minimum private API:

- `POST /api/sync/spaces` creates a sync space.
- `POST /api/sync/pairing-codes` creates a short-lived pairing code for a
  space.
- `POST /api/sync/devices` joins a device by pairing code and returns a device
  token.
- `POST /api/sync/usage` uploads normalized snapshots/daily rows for one
  device token.
- `GET /api/sync/usage` returns aggregate usage with optional `device_id` and
  provider filters.
- `GET /api/sync/devices` lists devices in the current sync space.

Device tokens are secrets. They belong in local app data and must never be
printed in UI, logs, tickets, or diagnostics.

## Desktop Settings

Settings should include:

- sync enabled/off toggle, default off
- server URL
- sync space status
- device name
- last upload time and last error
- disconnect device
- clear local sync credentials

The enable flow must show a short privacy summary before the first upload.

## Dashboard UI

Add a device filter near the current provider/time filters:

- All devices
- This device
- One row per paired device

When sync is disabled or unreachable, the current local dashboard remains the
default view.

## Verification

MVP checks must cover:

- pair a second device deliberately
- upload the same payload twice without double counting
- aggregate totals across two devices
- filter by one device
- local-only mode remains unchanged
- no raw prompts, raw log lines, local paths, or credentials are present in the
  sync payload

## Product Gate

Before implementing server persistence or deployment, Gerhard must choose:

1. Pairing-code MVP on a private server, recommended.
2. Login/OIDC MVP using the existing auth path.
3. Local-network/manual export first, no server yet.

Production domain, DNS, server deployment, public exposure, and release
artifacts remain separate explicit gates.
