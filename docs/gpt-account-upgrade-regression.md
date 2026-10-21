ChatGPT quota identity upgrade regression (KOL-664)

Before commit 69099d0, account discovery used an email-derived registry ID even
when credentials supplied a workspace ID. Later discovery correctly used the
workspace ID, but the persisted email-first entry still appeared as another
account. Re-login created another profile without removing this historical
record. KOL-663's fresh snapshot fixtures did not reproduce that upgrade state.

Credential collection now retains only the opaque hash of the corresponding
email identity alongside each verified workspace identity. Presentation uses
that exact hash to classify the old email-first entry as unscoped history.
It remains in the stored registry and in the public `historicalAccounts`
collection. Its old measurements never supply a workspace's quota or establish
a favorite alias. Different workspace IDs remain separate even when their
emails and masked labels match. Masked labels and profile paths cannot classify
an unrelated entry. Repeated managed logins produce one connection row per
verified identity while keeping every credential profile intact.

The quota widget ignores recognized historical entries in both the registry and
cached connection mirrors. Device composition also applies locally established
classification to old peer snapshots, including a selected peer view. It does
not change the signed snapshot format, mutate peer payloads, or infer an
unobserved remote identity. New captures export the current account collection.
An old remote email-only record that has no local credential evidence remains
unresolved. Existing workspace-based favorites and verified aliases remain
stable; an ambiguous email-only favorite is retained without guessing its owner.

The regression starts with raw synthetic Codex/OpenCode auth and the historical
registry shape, then runs the production collectors, scan/cache/persistence and
managed connection functions. On baseline ba44630, this command failed with
`3 !== 2` before product source edits; it passes after the fix:

```sh
node test/gpt-account-lifecycle.test.mjs
```

It also covers repeated login completion and scans, cache restoration, registry
restart, unchanged credentials/history, same-label negative cases, old signed
peer snapshots, per-account zero/unknown values and authenticated transport.
The HTTP fixture uses the production widget route and middleware with unrelated
consumption collectors isolated. The real Unix bridge and packaged Python
helper carry its output to the native QML checks:

```sh
npm run check
QT_QUICK_BACKEND=software xvfb-run -a npm run test:plasma:native
```

For a real isolated Plasma shell, build the package and run the operator-only
lifecycle. It installs/updates the per-user package inside a private session,
visually observes actual account counts using OCR, exercises two login, failed
refresh, registry restart and recovery cycles, then restarts the shell with a
favorite and restores All. It requires Plasma 6, Xvfb, qdbus6, ImageMagick,
xdotool, Tesseract and an installed Latin OCR language. `PLASMA_OCR_LANGUAGE`
defaults to `eng` and may select another installed language, such as `afr`.

```sh
npm run plasma:build
xvfb-run -a -s '-screen 0 1600x1100x24' dbus-run-session -- \
  python3 test/plasma-session-smoke.py x11 --gpt-lifecycle
```

Synthetic screenshots and logs stay under ignored `.cache/kol-664/`. This
establishes the reproduced upgrade mechanism and native rendering; it does not
establish which version is installed on a review member's machine.
