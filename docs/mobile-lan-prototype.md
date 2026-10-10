# Mobile LAN prototype — 1.7.0-lan-prototype.4

An explicitly started experiment for a phone dashboard without a hosted service.
The regular desktop application and its saved accounts are not modified. This
prototype is not a release and is not enabled in the normal application.

## Try the desktop prototype

Build `npm run dist:mobile-prototype:mac`, install the separate
**LLM Usage Dashboard LAN Prototype** application from its DMG and open it.
Scan the displayed QR code on a phone in the same trusted LAN, press Connect,
and save the resulting dashboard URL to the home screen. If the shared name
fails, create a direct Wi-Fi QR code instead. That fallback is bound to the
current computer and its IP; it does not provide takeover by another host. The phone session lasts
30 days; after expiry a new QR scan is required. iPhone home-screen storage and
physical Android/iPhone compatibility still need device verification.

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
by all group members. The five-minute QR bootstrap travels in the URL fragment
and its consumed hash is shared with other members.
The local control endpoint also returns `linkUrl`, with the same one-use token
in its path, for clickable links opened by embedded browsers. GET only displays
the connect page and never consumes a token. For a path link, the server supplies
the verified code in the page and retains it in an HttpOnly, SameSite=Strict
cookie scoped to `/pair`, only until the original five-minute expiry. This
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
  No secure-context PWA/service worker or reliable offline home-screen app is
  claimed. [Service workers require a secure context](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API).
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
