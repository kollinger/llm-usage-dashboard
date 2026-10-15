# Phone access — 1.7.0-preview.2

## Set up from the desktop app

Open **Settings → Phone → Show QR code and link** in the installed desktop app.
This activates phone access and opens the pairing window inside that app. Scan
the QR code or use **Copy link**, connect once on the phone in the same trusted
LAN, and save the resulting dashboard to its home screen. Each new installation
creates its own pairing group; no operator-owned host or preconfigured user path
is required. If local name resolution is unavailable, use the direct Wi-Fi QR
button. That direct address follows this computer's current LAN IP.

The desktop app owns the gateway and uses its current backend port. Enabled
access resumes on later app starts and retries when a private network returns
or its address changes. **Turn off phone access** persists across restarts.
Fresh installations leave LAN access off until the first explicit setup action.
Existing prototype group, node and consumed-link files are copied once into the
app's private mobile state on first activation, preserving phone cookies and
replay protection. Accounts, usage data and credentials are not copied.

The pairing window also retains the optional installation-group controls for
the shared local address. Existing encrypted usage sync remains separate. LAN
access still requires a running computer; Internet access and HTTPS push retain
their separate prerequisites below. Browser-only dashboard instances show that
phone setup requires the installed desktop app.

The native setup bridge accepts only the main dashboard window at its own
loopback origin. The pairing window is sandboxed, has no Node/preload bridge,
and cannot navigate to another origin. Phone data remains read-only and requires
pairing. A port conflict produces a visible status and can be retried without
leaving a partially started gateway behind.

## Desktop settings review — 2026-10-15

Product commits `1e403e0` and `2fde071` add the native setup and accept the
installed window's `localhost` spelling as well as its numeric loopback address.
Other windows, ports and origins remain rejected. Version `1.7.0-preview.2` is
installed locally for review; this work has not published an update for others.

- Full checks passed locally and on Linux. Docker rebuilt, and isolated Compose
  verified rendered settings, exact served assets and actual gateway pairing;
  its containers and network were removed afterwards.
- A fresh universal Mac ZIP and DMG were built. The automatic DMG helper stalled
  on macOS filesystem sync, so native `hdiutil` packaged the fresh application.
  The DMG was mounted, copied into Applications and launched directly. Installed
  runtime files match the product source and the packaged version is correct.
- Native Settings → Phone opened the sandboxed QR window. Copy link confirmed
  success; the UI explains the 24-hour, single-use pairing link and direct Wi-Fi
  fallback. The separate CLI gateway is no longer required.
- Existing group and consumed-link state survived migration. An already paired
  browser displayed both provider cards without connecting again. Turning access
  off stopped the actual LAN listener. Restarting the installed app used a new
  backend port, resumed the gateway automatically and retained that browser's
  access. The final review state has phone access enabled.
- German native UI and Arabic RTL settings were checked. All 27 supported
  languages contain the new keys. Linux AppImage and Windows portable builds
  succeeded. The full Windows NSIS build remains unverified because this Linux
  build environment has no Wine; no physical Windows or iPhone test was added.

## Standalone development prototype

The older separate prototype is retained for isolated development checks. The
desktop setup above does not require that application or a separately run CLI.

## Try the desktop prototype

Build `npm run dist:mobile-prototype:mac`, install the separate
**LLM Usage Dashboard LAN Prototype** application from its DMG and open it.
Scan the displayed QR code on a phone in the same trusted LAN, press Connect,
and save the resulting dashboard URL to the home screen. If the shared name
fails, create a direct Wi-Fi QR code instead. That fallback is bound to the
current computer and its IP; it does not provide takeover by another host.
The phone session lasts one year of inactivity. While the dashboard is used,
the signed cookie is renewed at most once a day for another year. Existing valid
30-day sessions upgrade on their next authenticated request without another QR
scan. Expired sessions still require a new scan; clearing browser storage also
removes the pairing. New phone QR codes and links are valid for 24 hours and can
be used once. iPhone home-screen storage and physical Android/iPhone
compatibility still need device verification. Pairing belongs to the browser
that connected; an embedded chat browser does not inherit Chrome's session.

Version `1.7.0-lan-prototype.12` keeps the estimated time to the limit
visible when rounded readings leave a before/after-reset comparison uncertain.
The shared desktop/phone card labels this as an estimate; stale readings,
missing samples and unchanged readings do not produce a fabricated time.

Version `1.7.0-lan-prototype.11` supplies the desktop app symbol when saving
the dashboard to the home screen. Icon GET/HEAD requests and the web manifest
do not require a browser cookie, while dashboard data still does. Both the
dashboard and pairing page declare the Apple touch icon and app title.

Version `1.7.0-lan-prototype.10` restores an existing session after opening a
dashboard link from another site. The Strict cookie can be absent on the
initial navigation. The pairing page now checks the authenticated status with
a same-origin request and returns an already paired browser to the dashboard.
This does not grant access to an unpaired browser or consume an enrollment code.

To connect another installation, expand Connect installations on the first
computer, create an installation code, and paste it into the same section on
the additional computer within five minutes. That application restarts and
joins the first computer's address and phone sessions. Treat the installation
code as a credential: it grants the group key, not just read access. It is a
prototype enrollment mechanism, without production revocation or key rotation.

This group connects the mobile gateways. Existing encrypted desktop data sync
remains separate; configure it if every serving computer should show the same
combined installation data. The prototype desktop app reads fresh local data
in its own user-data directory and never copies saved account credentials.

For a development backend already running locally:

```sh
npm run prototype:mobile -- --upstream http://127.0.0.1:4177
```

Open the loopback control URL printed by the command. The CLI chooses an RFC1918
LAN interface; `--address` can select another local LAN interface. It excludes
common tunnel and container interfaces. Interface changes require restarting
this experiment. Do not open a public tunnel or forward its port on a router.

## How the shared address works

Each group has a random `llm-<group-id>.local` hostname and port 41780. Signed
multicast heartbeats on UDP 41781 find group members on the selected local
subnet. The lowest node ID owns the hostname. Peers expire after six seconds;
the survivor then advertises the same name using mDNS on UDP 5353. A records
have a three-second TTL and cache-flush flag; orderly shutdown sends a goodbye.
Actual browser DNS caching can make takeover slower. This is a local network
experiment, not a guarantee across arbitrary routers, VLANs or guest networks.

Phone authorization is an HMAC-signed HttpOnly, SameSite=Strict cookie, accepted
by all group members. The 24-hour phone QR bootstrap travels in the URL fragment
and its consumed hash is shared with other members.
The local control endpoint also returns `linkUrl`, with the same one-use token
in its path, for clickable links opened by embedded browsers. GET only displays
the connect page and never consumes a token. For a path link, the server supplies
the verified code in the page and retains it in an HttpOnly, SameSite=Strict
cookie scoped to `/pair`, only until the original 24-hour expiry. This
permits reloading the cleaned URL even when tab storage is blocked. That cookie
does not authorize dashboard access. Tab-scoped session storage also retains
fragment codes; successful pairing or an invalid/expired response clears it.
The code stays in the address until pairing so a phone's Open in another browser
action can transfer it without shared cookies or session storage. A code restored
on the clean `/pair` URL is put back into the path for the same purpose.
Successful pairing replaces the address with `/` and clears the bootstrap cookie;
a rejected code is removed from the address. Both link forms
use no-store and no-referrer headers. The path form reaches the local HTTP
server and must not be logged by a proxy.
Concurrent redemption during a network partition is not fully prevented.
Missing, invalid, expired and already-used codes have separate error messages.
The loopback control status keeps only the last twelve pairing events in memory:
time, action, code state and mobile/other client class. It does not retain tokens,
IP addresses or raw browser identifiers; the phone status never exposes them.

The gateway serves the existing dashboard assets and a small GET allowlist.
It removes sensitive source fields from JSON, rejects mutations and avoids
forwarding the dashboard's force-refresh query. Settings and account controls
are hidden. Pairing controls are only available on loopback, with Host/Origin
checks. This reduces exposure; it does not provide encrypted transport.

## Deliberate limits

- **HTTP only on a trusted LAN.** QR possession does not stop LAN interception.
  This remains the default, with warnings inside the open dashboard. Background
  push is available only through an explicitly configured HTTPS origin, below.
  [Service workers require a secure context](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API).
- No relay, hosted landing page, DNS account, router configuration or external
  service is created. No remote access is implemented. A user-owned private
  VPN and HTTPS endpoint is a later integration, with separate authorization.
  `.local` discovery does not automatically cross a VPN.
- When all installations are off, no fresh dashboard is available. An open
  page can show disconnected status; opening the bookmark with every host off
  produces the browser's network error.
- mDNS and multicast must work on the client and network. Windows, physical
  phones, firewall permission prompts, sleep/wake and multiple simultaneous
  network interfaces remain unverified.
- German and English prototype text is supplied. Other supported locales have
  explicit English prototype fallback text; normal dashboard translations stay
  intact. The prototype page supports RTL layout.

## Notifications

The phone uses `/api/notifications/mobile` on the running dashboard backend.
Desktop and phone share thresholds, provider identity and account-scoped quota
events. Fresh Codex readings cover the five-hour and weekly windows; fresh
Claude API readings cover their reported windows when account scope is known.
The detector records reached limits, restored availability, scheduled or early
resets, and quota adjustments directly, without a Matrix dependency. Events
include the observation time and prior planned reset, without inventing a
cause. Initial observations, account/plan switches, interrupted or stale
readings and moving zero-use deadlines do not produce reset notices.

General warnings and reset/adjustment notices default to on for new settings.
The desktop has a master switch and a separate reset/adjustment switch;
explicit existing opt-outs remain intact. The phone reads those settings.
Recent events appear for ten minutes; bounded local state and persistent
delivery IDs avoid replay after app or gateway restart. Desktop and phone use
the same event wording.

The mobile page has a notification invitation, current warnings and optional
connection guidance. Over LAN HTTP it clearly says that warnings require an
open page, separately from the warning switch. It hides the push activation
button when activation is unavailable and explains the reason. Tailscale is
optional; the basic Wi-Fi dashboard never requires it.

For a future user-owned HTTPS connection, the CLI accepts `--https-origin`
and `--https-proxy-port`. They create an additional **loopback-only** listener.
They do not install Tailscale, change Serve routes, create TLS certificates,
open a tunnel or expose a public service. A trusted local HTTPS proxy must
preserve the exact configured Host and set `X-Forwarded-Proto: https`.
Forwarded headers on the LAN socket cannot enable push. A local operator can
request a new HTTPS pairing link from the loopback `/api/code` endpoint with
`{"https":true}`. HTTPS pairing cookies use Secure; the new origin requires
separate phone pairing and a new Home Screen shortcut.

On iPhone, the HTTPS dashboard must be installed on the Home Screen and opened
from its icon. Only an explicit tap on Enable notifications requests permission.
This follows [WebKit's iOS Web Push requirements](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
The worker handles push and notification clicks; it never caches usage data.
Subscription, unsubscribe and test mutations are paired, same-origin, JSON-only
phone routes. All existing dashboard mutations remain blocked.

VAPID keys, encrypted-push subscription material, expiry and deduplication are
stored privately alongside the group file in a mode-0600 `mobile-push-*.json`.
Only Apple, Google and Mozilla HTTPS push endpoints with valid encryption keys
are accepted. The running host checks the feed every 30 seconds, even with no
phone page open; the backend uses the same freshness policy as native alerts.
Warnings have a 30-minute cooldown per provider/window/type/reset; events send
once. Enrollment skips earlier reset events, and restart/reopening keeps the
deduplication history. Removed subscriptions and expired phone pairing stop
delivery. A test is rate-limited to once per minute per phone. A successful send
means push-service acceptance, not verified delivery to a physical phone.

**Open:** no real HTTPS connection or locked-iPhone delivery has been configured
or verified for this review. Push state is local to its HTTPS host and is not
transferred during LAN host takeover. That host must stay awake and online.
Automatic HTTPS setup, remote onboarding and push takeover remain open.

Review .6 adds notification guidance, shared quota warnings, recent early Codex
weekly reset observations and the optional push transport. Validation covers
encrypted request construction, pairing/origin isolation, persistence and
deduplication, a worker push without an open page, disabled desktop settings,
Docker/Compose, and narrow mobile/RTL browser states. Permission and subscription
UI tests use mocks; they are not physical push-delivery evidence.

The protocol follows the relevant cache-flush, goodbye and negative-answer
mechanisms in [RFC 6762](https://www.rfc-editor.org/rfc/rfc6762.html). Production
work should integrate enrollment/revocation with existing authenticated desktop
sync and validate browser identity, transport and failover on real phones.

## Verification

`npm run check` includes focused checks for unauthorized access, host/origin
checks, cookie scope, token expiry/tampering/reuse, read-only routes, private
field removal and phone sessions accepted by another installation after restart.
Real network and packaged-app results are recorded separately; synthetic API
checks alone do not prove browser DNS failover or physical-phone behavior.

### Observed on 2026-10-10

- The full repository check passes, including mobile pairing, group enrollment
  and restart, shared sessions, private-field filtering and direct QR generation.
- A fresh Docker image and an isolated Compose instance served the dashboard,
  rendered real visible content at a mobile viewport, and returned usage HTTP
  200. The test Compose instance was stopped afterward.
- Two real computers on the same LAN discovered each other and agreed on one
  owner. After abrupt termination of that owner, a native macOS HTTP client
  resolved the unchanged `.local` URL to the survivor and received HTTP 200
  using the original phone cookie. This is protocol evidence, not browser proof.
- Chrome on the test Mac timed out resolving this `.local` hostname although
  native macOS lookup succeeded. The local in-app browser also failed name
  resolution. The exact browser-specific cause remains unverified. On the
  Linux client, the system mDNS service was restricted to an obsolete network
  interface; no machine-wide configuration was changed to make the test pass.
- Therefore automatic takeover of a saved phone home-screen entry is still
  open. The direct IP fallback provides a separate way to test the phone UI.
- A fresh universal macOS DMG installs as a separate prototype app and starts
  the QR control window. Normal dashboard state remains in its original app.
- The direct QR flow was exercised in a real Chromium browser: connect button,
  removal of the bootstrap fragment, signed session cookie, dashboard rendering,
  real upstream usage HTTP 200, hidden settings, no JavaScript page errors and no
  horizontal overflow at a mobile viewport. The control view was also checked
  with Arabic locale/RTL. This still does not substitute for a physical phone.

### Pairing-link repair — 1.7.0-lan-prototype.2

- A physical iPhone reached the direct LAN endpoint and displayed the pairing
  page with its connect button disabled. The screenshot alone does not show
  whether the fragment was lost on navigation or the cleaned page was reloaded.
- A reload before pairing reproduced the lost-code state in the original client.
  The repaired client retains the code for that tab and supports a fragment-free
  clickable link. Network failures permit retry; expired/used tokens require a
  fresh link. No transport or access permissions were widened.
- Repository checks, a fresh Docker build and an isolated Compose smoke passed.
  A real Chromium browser at 390 px verified the clickable path link, reload
  before connecting, fragment link, retry after an interrupted request, replay
  rejection, cleared tab storage and usage HTTP 200. German and Arabic/RTL
  rendered without horizontal overflow or JavaScript page errors. The Compose
  instance and browser were stopped after checking.
- A fresh universal DMG with version 1.7.0-lan-prototype.2 was installed and
  launched on the M1. Its path link and reload-before-connect worked in the
  local in-app browser. Its separate cold backend did not return usage within
  45 seconds, while the already running normal dashboard returned HTTP 200 in
  38 ms. For the phone trial, the CLI gateway was therefore started against
  that existing loopback backend with the same prototype group. The paired
  phone gateway returned usage HTTP 200 in 41 ms; real provider cards and token
  totals rendered in the browser. The separate prototype app was stopped.
  This trial requires the normal desktop dashboard and CLI gateway to stay
  running. Cold-backend startup remains an open prototype limitation.

### Server-supplied pairing code — 1.7.0-lan-prototype.3

- The iPhone's 20:00 screenshot arrived while the preceding code was valid and
  unspent. Expiry and successful redemption do not explain that attempt. The
  screenshot cannot establish whether the code was absent on first load or
  rejected after pressing Connect.
- An accepted path with a trailing slash reproduced a disabled button in the
  previous client. The client now accepts that path and the server delivers the
  code directly, with a short-lived bootstrap cookie for cleaned-URL reloads.
- The full repository check and Docker rebuild passed. An isolated Compose
  instance and Chromium at 390 px verified a trailing-slash link with blocked
  session storage, reload before pairing, successful connection, bootstrap
  cookie removal, usage HTTP 200, retry, replay rejection and Arabic RTL. No
  JavaScript errors or horizontal overflow were observed. Compose and the
  browser were stopped afterward.
- A fresh universal 1.7.0-lan-prototype.3 DMG was installed and launched on the
  M1. Its QR control window rendered and its packaged HTTP server delivered
  the verified code for a trailing-slash link and restored it on a cleaned-URL
  reload. The review app was then stopped; the phone trial uses the existing
  normal dashboard backend through the separate CLI gateway.

### Open in another phone browser — 1.7.0-lan-prototype.4

- The user confirmed that Connect was enabled in the embedded phone browser,
  then disabled after opening the page in iPhone Chrome, before any redemption.
  The gateway recorded a valid mobile link at 20:14:59, followed by requests
  without a code from 20:15:03 onward. The client had removed the code from the
  current address before the browser handoff; browser storage was not shared.
- The address now retains the five-minute one-use code until redemption. A
  second browser receives the complete link. Success replaces it with `/`;
  rejection removes the code. The existing no-referrer policy prevents the
  code from being sent as a Referer. Authorization and expiry are unchanged.
- The new regression failed against the previous client and passes after the
  correction. The full repository check and Docker rebuild passed. Chromium
  verified path and fragment handoffs between separate browser contexts, with
  blocked storage in the first browser, reload, no code in Referer headers,
  successful pairing in the second browser, visible provider cards and usage
  HTTP 200 at 390 px. The first browser remained unpaired. Compose and browser
  processes were stopped after checking. Physical iPhone confirmation is open.
- A fresh universal 1.7.0-lan-prototype.4 DMG was installed and launched on the
  M1. Its control window rendered and the packaged gateway served the corrected
  browser-handoff client. The app was stopped after checking; the phone trial
  continues through the CLI gateway and the existing normal desktop backend.

## Pairing duration review — 1.7.0-lan-prototype.7

Phone links and QR codes last 24 hours. Active remembered phones renew a
one-year session, including upgrades from existing valid 30-day pairings.
Renewal keeps the push subscription owner and warning deduplication history.
Implementation: `c0b57c9`, branch `codex/mobile-lan-prototype`.

Focused tests cover 23-hour link validity, expiry, one-year cookies, legacy
session renewal, expired-session rejection, preserved push subscriptions,
host takeover and restart. Full `npm run check`, Docker rebuild and an isolated
Compose smoke passed. The fresh universal DMG was installed as the separate
prototype app and launched directly; its ASAR files match the source, and its
control page visibly reports the 24-hour limit. The CLI phone trial then
resumes against the normal host with the original group file. It runs detached
from the command session; automatic app integration and service supervision
remain open. This duration change does not address those lifecycle limits.


## Credit expiry review (2026-10-11)

Review source: `codex/mobile-lan-prototype`, product commits `06d415d` and
`6fab418`. Review builds: `1.7.0-lan-host.3` for the installed regular desktop
app and `1.7.0-lan-prototype.9` for the separate LAN prototype. These are local
review builds; no release tag or public tunnel was created.

The current Codex app-server returns `hasCredits`, `unlimited` and `balance`,
but no expiry date. A finite Codex credit balance now shows that the date is
unknown until the user records one. The desktop card opens a date editor;
leaving the field empty removes the date. Dates are labelled as a manual entry,
never as a provider-confirmed expiry. No real expiry date was inferred from a
rounded balance or an unconfirmed December date.

The private local date is bound to the current Codex workspace identity. A
stale editor is rejected after an account change, and cached credit balances
cannot inherit another account's date. Both interactive quota reads and the
background reset collector retain this binding. Dates are local settings;
copying them through the encrypted installation sync is not part of this step.

When desktop notifications are enabled, a positive balance with a date produces
warning stages within 30 days, seven days and the final day. Desktop alerts and
the paired phone notification feed use the same rule. Phone push retains stage
deduplication across restarts for 35 days. Wi-Fi HTTP still only displays warnings
while the page is open; locked-phone delivery still requires the optional HTTPS
push setup described above. Existing notification enablement is preserved.

Verification: full `npm run check`; all 27 locale keys/placeholders; credit date
validation, calendar/DST boundaries, warning stages, private persistence, removal,
account-change rejection, background snapshot scope and push deduplication tests;
Docker rebuild and isolated Compose API smoke (then stopped). The real Mac/phone
browser check covered the unknown-date card, editor availability, German copy,
Arabic RTL and a 390-pixel mobile viewport with the edit control hidden. No real
user expiry date was saved merely for QA.

Both review DMGs were freshly built, installed and launched directly from
`/Applications`; their packaged source matches `6fab418`. The prototype control
page renders the 24-hour pairing copy. The phone gateway was then restored to
the regular host review app with the same group and browser authorization. A
live check after background collection confirms that the credit scope still
matches the date editor. Desktop notifications remain disabled in the existing
settings; no real date or push subscription was added for QA.

## External-link session recovery review (2026-10-11)

Product source: `6fcc0ef`, branch `codex/mobile-lan-prototype`. Separate Mac
review build: `1.7.0-lan-prototype.10`. The unchanged direct phone URL remains
the current LAN host's address on port 41780; no hosted service was added.

The mobile requests at 19:32 UTC reached the running gateway but showed neither
a valid browser session nor an enrollment code. Independently, the test browser
reproduced a surviving session that opened correctly by direct navigation but
landed on the missing-code page when following a link from another origin.
The same external link now returns that browser to the dashboard, with both
Claude and Codex cards, without consuming another enrollment code.

Verification: regression check failed before the fix and passed afterward;
full `npm run check` passed locally and on Linux; Docker rebuild and isolated
Compose smoke passed, including valid/absent sessions and read-only protection.
The Compose container was stopped. The fresh universal DMG was installed and
launched directly, its packaged client matches the source, and the QR control
page rendered. The CLI gateway was restored against the regular desktop app;
its group file is unchanged and the existing test-browser pairing still works.
All temporary browser tabs were closed.

The physical iPhone's current Chrome session has not yet been rechecked. Its
embedded chat browser is a separate session; session recovery cannot transfer
Chrome authorization into an unpaired browser. No expiry or deleted phone
cookie was inferred from the missing-code page.

## Home-screen icon review (2026-10-11)

Product source: `0e9e18b`, branch `codex/mobile-lan-prototype`. Local Mac
review build: `1.7.0-lan-prototype.11`; no public release was created.

The original unauthenticated icon and manifest requests redirected to the
pairing page and returned HTML. Home-screen installers therefore could not
retrieve the icon without the browser session. The icon routes now return the
existing 512-pixel desktop app PNG for GET and HEAD requests, before the phone
authorization gate. The standard root Apple icon paths and explicit page links
follow [Apple's web-clip icon guidance](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html).
The normal network/origin restrictions and dashboard authorization remain.

The regression failed before the fix. Full checks passed locally and on Linux;
Docker rebuild and isolated Compose smoke verified the exact desktop image,
PNG/manifest content types, cookie-free GET/HEAD access, authenticated data and
continued rejection of unauthenticated data. The container was stopped.
The fresh universal DMG was installed and launched directly; its icon routes,
pairing page and PNG match the source. The installed app's icon decoded in the
browser at 512 by 512 pixels. The normal-host CLI gateway was restored with the
original group, and its icon/manifest endpoints work without cookies.

Physical iPhone home-screen installation remains a user/device check. Reload
the dashboard in the paired browser and add it to the home screen again to
request the current icon; this is not proof that an existing shortcut updates.


## Recent-pace estimate review (2026-10-12)

Product source: `ca2b41b`, integrated into `codex/mobile-lan-prototype` from
`codex/recent-pace-estimate`. Local review versions: `1.7.0-lan-host.4` and
`1.7.0-lan-prototype.12`; no public release was created.

The existing calculation already supplied a central `hitAt` estimate, but the
card hid it for `possible` results. That classification means rounded readings
allow the limit to fall on either side of reset; it does not mean there is no
measurable pace. The card now shows an explicitly estimated duration for risk,
safe and possible results. Its reset comparison remains cautious, with the
rounding explanation updated in all 27 languages. The backend formula, quota
classification and notification rules were not changed.

The screenshot regression uses 20 to 23 percent over 300 minutes and a reset
131 hours away. It is classified possible, yet its 77 remaining points at
0.6 points per hour yield 128 hours 20 minutes. The card displays about five
days and eight hours. Missing, stale, flat and changed-reading cases still
show their original state without an invented duration.

The regression failed before the fix. Full checks passed locally and on Linux;
translation keys and placeholders are consistent across all 27 languages. A
fresh Docker image and isolated Compose smoke check verified the dashboard and
exact served JavaScript, German and Arabic translations. Compose was stopped.
The 390-pixel, two-column browser check displays the five-day/eight-hour
estimate in German and Arabic RTL without overflowing the card.

Fresh universal Mac packages were installed from new DMGs and launched
directly. Both installed apps' JavaScript and checked translations match the
product commit. The automatic host DMG step stalled in a macOS sync helper;
its temporary image was converted with `hdiutil`, and the fresh prototype
universal payload was packaged into a DMG with the same macOS tool. The
cancelled build helper has exited. No packaging source was changed.

The normal host and LAN gateway are running again with the original pairing
group and unchanged notification settings. An existing paired browser opened
the dashboard and both provider cards, including the new estimate. Temporary
browser fixtures and the test tab were removed; the separate native prototype
was stopped. Physical iPhone rendering remains a device check.

## Claude restored-history quota review (2026-10-12)

Product source: `4f851bc` plus status-preservation follow-up `73b1956`,
integrated into `codex/mobile-lan-prototype` from
`codex/claude-history-status`. Local host review version:
`1.7.0-lan-host.6`; no public release was created.

The persisted consumption view intentionally omits account metadata and
quotas. During restoration, that absence was incorrectly interpreted as a
missing browser login. A still-valid saved Claude quota now overlays the
history view while current readers refresh, preserving its original timestamp
and existing card status. Expired windows and unreported weekly windows
remain unavailable. Log totals remain independent of the quota overlay; the
fallback token display is not a conversion to subscription consumption.

The login hint now requires actual browser-credit status instead of assuming
missing authentication from absent metadata. The screenshot regression failed
before the fix and passes afterward. Tests also cover partial windows,
expired snapshots, unchanged log totals and the authority of current readers.
Full checks passed locally and on Linux. Docker was rebuilt; isolated Compose
smoke verified the exact served assets and was stopped afterward.

A fresh universal host payload was packaged into a DMG with native
`hdiutil`, installed from that DMG, and launched directly from Applications.
The installed server and frontend sources match `73b1956`. The running API
retained the dated weekly quota while its consumption cache was restored.
An existing paired LAN browser displayed the quota without the login hint
or an unsupported status label; the card also passed a focused 390 px check
without horizontal overflow. The pairing group and notification settings
are unchanged. The temporary browser tab was closed. Physical iPhone
rendering remains a device check.

## Shared reset notification review (2026-10-12)

Product source: `bc314a4`, prepared on `codex/unified-reset-notifications`
for integration into `codex/mobile-lan-prototype`. Local host review version:
`1.7.0-lan-host.7`; no public release was created.

The dashboard now observes reached limits, restored availability, scheduled
and unexpected resets, and other quota changes directly from fresh provider
readings. The existing Matrix monitor's transition checks were inspected;
Matrix is not a dependency or a message source. Desktop banners and the LAN
phone feed use the same persisted events and formatter. Account or plan
changes, missing windows, stale readings and moving zero-use deadlines cannot
create a reset notification. Event IDs survive desktop restarts.

New installations default to enabled warnings and enabled reset/change
notifications. Existing explicit opt-outs are preserved. The reset/change
checkbox and the master switch are independent. Both were enabled on the
current review desktop at Gerhard's request, preserving its warning thresholds.
The phone now distinguishes dashboard warnings from phone push and explains
the HTTPS prerequisite instead of displaying an unavailable grey button.
The Claude card explains that logged input, output and reused cache tokens
are separate from subscription quotas; the two new core labels are translated
in all 27 supported languages.

Full checks passed locally and on Linux. Docker was rebuilt, and isolated
Compose verified identical desktop/phone event feeds, both default switches,
persisted opt-outs and the exact served assets before stopping. Tests cover
transition guards, persistence, native restart deduplication, identical message
formatting and encrypted Web Push requests. Observed events request a 24-hour
push TTL; that requests retention, not guaranteed delivery.

A fresh universal payload was packaged into a native `hdiutil` DMG, installed
from that DMG and launched directly from Applications. Installed backend,
notification and frontend sources match the product commit. The original
pairing group remains intact. The exact paired LAN address rendered meaningful
content at 390 px without horizontal overflow, with the new German warning
and HTTPS status. The desktop reset checkbox saved its opt-out and was restored
to enabled; Arabic RTL labels and the Claude explanation were checked, then
the normal German review state was restored. The temporary browser tab and
Compose fixtures were removed.

The current phone address still uses HTTP. No HTTPS endpoint, public tunnel,
certificate trust or operating-system permission was configured. The desktop
diagnostic reports that macOS notification permission still needs attention.
Actual desktop banners and locked/closed iPhone delivery remain device checks;
the latter requires trusted HTTPS, Home-Screen installation and user permission.
