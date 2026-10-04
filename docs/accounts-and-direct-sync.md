# Accounts and direct device sync

## Connect accounts

Open **Settings → GPT accounts → Add GPT account**. The app creates a separate
local Codex profile and returns OpenAI's official browser sign-in link. Sign in
with the intended ChatGPT account; use a separate browser profile or change the
account in that browser when necessary. Repeat for another account. This requires
an installed Codex CLI. The dashboard detects common desktop/CLI installations.
No dashboard service account, developer login, or hosted dashboard is needed.

The app does not replace the active Codex CLI login. Managed credentials live in
owner-only `data/codex-profiles/<random-id>/auth.json`; they never enter device
sync, exports, or Git. **Remove local login** deletes only the profile created by
this dashboard. It does not revoke an OpenAI session on other devices. Existing
CLI/OpenCode profiles remain automatically detected. Account cards appear on the
main dashboard when multiple accounts are known or sync is enabled.

Other providers continue to use their existing local source connections and
provider-specific integrations. This feature does not add an independent OAuth
login flow for every provider. OpenCode and older local usage logs may lack an
account identifier: provider totals and account quota cards are separate, and
usage is never invented for an individual account.

## Pair your own devices

1. Enable **Settings → Direct device sync** on both devices and give each a name.
2. On one device, create a pairing code and copy it to the other device.
3. Paste it into the other app and choose **Connect device** within five minutes.
4. The apps now exchange updates automatically while running and reachable.
   The dashboard initially shows all connected devices. Select **This device**
   or one remote device to inspect its consumption separately.

A code authorizes access to usage snapshots. Treat it as a short-lived secret;
it is one-use and never sent to a discovery service. Pair additional devices
with an already paired device. Signed snapshots can travel through the user's
paired devices, so the originating device does not have to be online for its
previously collected data to remain visible. Devices still need a reachable path
and overlapping uptime for new information to travel. Closing a desktop window
leaves the installed app's normal background collector running; quitting the app
or sleeping the computer stops collection and sync until it resumes.

## Network boundary

The app operates without developer infrastructure, external discovery, STUN,
TURN, or a relay. It neither changes the router nor creates a VPN. On a LAN,
signed multicast announcements rediscover paired devices automatically. Outside
a LAN, an existing reachable private IPv4 route can work, including a directly
connected private VPN. The saved listening port survives restarts. A VPN that
uses its own relay is outside this app's control; it is not a promise of a
relay-free underlying network.

The initial direct sync listener uses TCP 41778. LAN discovery uses UDP 41779
and multicast 239.255.41.77 with TTL 1. Only private numeric IPv4 destinations
are accepted; IPv6 and public-IP peer connections are currently unsupported.
Firewall restrictions, client isolation, different private networks, or VPN
address changes can require network configuration or a new pairing code. There
is no fallback to an external server. Universal automatic connectivity across
arbitrary routers cannot be guaranteed under these constraints.

Desktop account and pairing controls accept only requests from the local
browser/desktop app, with loopback Host and same-origin checks. The desktop
HTTP dashboard and Ollama proxy bind to loopback. The standalone web/Docker
runtime retains its existing binding. Ordinary Docker bridge publishing does
not expose direct-sync multicast or authorize local account/pairing controls;
use the desktop app for this workflow. Linux operators can use host networking
with a loopback dashboard binding in a custom deployment, but that requires
explicit configuration and is not the default Compose setup.

## What is exchanged

The sync boundary is a positive allowlist:

- Hashed event identity, provider, timestamp, model, reasoning effort, and numeric
  token counters from local normalized usage events.
- Opaque GPT account identity, plan, numeric lifetime-token summary, numeric quota
  windows, and measurement timestamps. Account names/emails do not travel.
- Paired device name and public cryptographic identity.

Credentials, OAuth tokens, API keys, cookies, prompts, responses, transcripts,
raw provider payloads, local paths, and process lists are excluded. Events without
a stable source identifier remain local and are counted as excluded in the
combined view. Provider billing/admin API aggregates are not added to local
logs, because that could double count consumption. Account lifetime summaries
are displayed but are not added to the event totals. Repeated event identities
count once; for a revised record the latest collected snapshot wins. This is a
source-backed aggregation, not proof of complete provider billing coverage.
Remote quota cards show saved measurements with their age, rather than claiming
they are a current live query.

Only your explicitly paired devices receive these snapshots. The app's existing
provider queries go directly to those providers; optional update checks/downloads
go to GitHub. There is no developer usage-upload endpoint or new telemetry.

## Security and local storage

Each device generates X25519 and Ed25519 keys locally. Pairing pins the public
identity from the supplied code. Messages use X25519/HKDF-SHA256-derived keys,
AES-256-GCM authenticated encryption, and Ed25519 signatures. Nonces, response
binding, and bounded timestamps reject packet replay. Snapshots retain their
origin signature when another paired device forwards them. Downloads are paged; unchanged blocks are reused after comparing hashes and
verifying the complete signed revision. Downloads are size-limited, and committed only after the complete signed revision verifies.

Private keys/settings use owner-only permissions on POSIX systems. Received
snapshots are encrypted at rest in `data/device-sync/snapshots.json`, with a key
stored locally in the private identity file. This protects against accidentally
reading or sharing the snapshot file alone, not an attacker controlling the
user's account or computer. Windows relies on the user-profile directory's OS
access controls. The protocol is new and has automated adversarial tests; it has
not undergone an independent cryptographic security audit.

Turning sync off stops its network listener and discovery, retaining local
copies. **Disconnect** rejects that peer on this device and removes its cached
origin snapshot here. It cannot erase copies previously received on other
devices. Re-pairing a revoked identity is intentionally blocked; removing a lost
device from every remaining device is necessary. This preview does not yet offer
recovery or a group-wide revocation/re-enrollment flow.

The current bounds are 20 directly paired peers, 40 snapshot origins, and
1,000,000 stable events per origin. An exceeded bound produces an incomplete/
unreachable indication rather than publishing a partial snapshot.
