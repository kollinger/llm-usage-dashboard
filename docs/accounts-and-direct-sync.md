# Accounts and direct device sync

## Connect accounts

Open **Accounts → Add account** in the dashboard header, or **Settings →
Accounts**. Choose a provider and its offered connection method. A label helps
identify personal/work connections. Settings are split into four tabs; provider
choices and connection forms appear only when needed.

| Provider | Connection | Measurements currently exposed |
| --- | --- | --- |
| ChatGPT / Codex | Official Codex browser login; Codex CLI required | Detected local usage and account quota windows |
| Claude / Claude Code | Official installed Claude CLI browser login in an isolated profile | Authentication/plan; official statusline quotas after session activity |
| Kimi Code | Official Kimi browser login or Kimi Code key | Provider quota windows; token history is unavailable |
| GLM / Z.AI Coding Plan | Coding Plan key; Global or China endpoint | Coding Plan quota windows |
| OpenAI API | Organization admin key | Last seven days of completions token usage and available organization costs |
| Anthropic API | Organization admin key | Last seven days of Messages usage and available organization costs |
| Moonshot / Kimi API | Moonshot API key | Available account balance; token usage is unavailable |

API keys and subscriptions are different products. A normal inference key does
not grant organization-report permission. Admin reports may cover more than the
local CLI logs, and cost coverage differs from token coverage. Reports and
balances remain on individual account cards and are never added to local token
totals. Multiple quota windows/accounts are not summed into one percentage.

Browser login creates a separate app-owned profile; it does not replace the
active CLI login. Select the intended account in the provider's browser page.
Claude uses the unmodified official CLI for authentication/status/logout, not a
third-party OAuth client or copied token. A sanitized statusline hook is installed
only in the new profile; logging in alone does not produce Claude quota values.
The dashboard never sends a paid model request to obtain or test those values.

Kimi browser sign-in prepares the pinned official MIT-licensed Kimi Code 2.1.1
helper under local `data/tools/kimi/`. It downloads roughly 150–190 MB directly
from Kimi, verifies a checked-in SHA-256 digest before execution, disables helper
telemetry/automatic updates, and leaves existing CLI installations unchanged.
The helper serves only an authenticated loopback interface and stops after the
login or refresh. The Code key method does not require this download.

Managed credentials stay in app-owned local profiles or the encrypted local
provider-key vault. They never enter device sync, exports, or Git. Removing an
app-owned connection affects that profile only; automatically detected CLI
accounts are managed in their original application. Provider-side session
revocation and previously shared snapshots are separate from local removal.

Existing CLI/OpenCode sources remain automatically detected. Older usage records
can lack a reliable account identity; provider totals and per-account quotas
therefore remain distinct. The dashboard never invents per-account attribution.
Different keys for one organization appear as separate connections because the
reports do not always expose a trustworthy canonical organization identity.

## Pair your own devices

1. Open **Installations** in the dashboard header. This installation is always
   shown, even while sync is disabled.
2. Choose **Connect installation → Create code** on one device. This explicitly
   enables direct sync and creates a short-lived pairing code.
3. On the other device choose **I have a code**, paste it, and connect within
   five minutes. Give each installation a recognizable name.
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

## Read installation and account charts

The chart breakdown selector includes **Installation** and **Account** alongside
the existing total, provider and model views. The device selector filters the
data included in the dashboard; the chart breakdown changes how those selected
records are grouped. Tooltips and group totals show the relationship between
installations and recorded accounts.

An installation is the observer of a usage record, not proof that the original
request executed on that computer. When the same stable event is present on
several installations, the combined view counts it once and marks the device
attribution as shared/ambiguous. Missing historical account evidence is shown
as **Unknown account**. Signing into an account today never relabels old usage.
Provider quota or billing aggregates do not manufacture per-event attribution.

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
- Opaque identities and saved numeric quota/report/balance measurements for
  connected Claude, Kimi, GLM and API connections; labels/keys never travel.
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
go to GitHub; the optional Kimi helper download goes directly to Kimi. There is no developer usage-upload endpoint or new telemetry.

## Security and local storage

Each device generates X25519 and Ed25519 keys locally. Pairing pins the public
identity from the supplied code. Messages use X25519/HKDF-SHA256-derived keys,
AES-256-GCM authenticated encryption, and Ed25519 signatures. Nonces, response
binding, and bounded timestamps reject packet replay. Snapshots retain their
origin signature when another paired device forwards them. Downloads are paged; unchanged blocks are reused after comparing hashes and
verifying the complete signed revision. Downloads are size-limited, and committed only after the complete signed revision verifies.
An active download leases its signed revision for a bounded interval, allowing
new local captures to proceed without changing pages already being transferred.

Provider keys are AES-256-GCM encrypted at rest in `data/provider-accounts/`;
the encryption key stays beside the vault in an owner-only file. Private
keys/settings use owner-only permissions on POSIX systems. Received
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

All paired installations should run 1.6.0-preview.1 or newer for installation
and historical account attribution. Old signed snapshots remain readable;
older apps do not understand new extended snapshots containing event account
evidence.
