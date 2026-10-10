# Mobile LAN prototype — 1.7.0-lan-prototype.1

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
by all group members. The five-minute QR bootstrap travels in the URL fragment,
is removed before pairing, and its consumed hash is shared with other members.
Concurrent redemption during a network partition is not fully prevented.

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
