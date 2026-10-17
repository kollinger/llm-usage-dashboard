# Account-scoped reset history review — 1.7.0-preview.3

The previous history renderer selected the most recently sampled account and
provided no account identity in the view. Additional-profile probes did not
record reset history. Notification baselines used one provider-wide slot, so
alternating accounts could silently lose a transition. A reproduced alternating
account case emitted zero reset events before the repair and one afterwards.

Product source: `a4a0498`, based on `codex/mobile-lan-prototype` at `2deed25`.
The correction keeps one history and notification baseline per account. The view
shows each known account separately, a last-measured-before-reset percentage and
its timestamp, and the current measurement separately from a window's maximum.
Unknown legacy logs remain in their own unassigned section. Additional signed-in
Codex profiles are sampled without starting model turns. One unavailable profile
does not erase another account's baseline. Existing private history is retained;
unrecorded past observations cannot be reconstructed as account facts.

## Verification

- Full checks passed on macOS and Linux. Focused final checks cover interleaved
  records, two synthetic accounts at 100% and 18%, zero usage, restart/migration,
  scoped interruption, account metadata without email and actual profile-probe
  persistence. All supported translation keys and placeholders agree.
- The final Docker image rebuilt. Isolated Compose served exact changed assets
  and its HTTP history endpoint returned both synthetic accounts with the correct
  previous percentages. Containers and the temporary network were removed.
- The shared component was checked in the browser on desktop, a narrow viewport
  and Arabic RTL. Both accounts and their distinct previous values were visible;
  tables scroll within their wrapper without making the page overflow. Synthetic
  fixture data was kept outside Git.
- A fresh universal Mac DMG was built with `npm run dist:mac`, installed into
  Applications and launched directly. All 32 changed runtime/locale files match
  the product source. The installed history API and rendered dashboard show the
  account sections, unassigned history and new column. The existing phone group
  and enabled setting were preserved.
- Native window automation was unavailable because macOS ScreenCaptureKit could
  not start. Installed source parity, the real installed HTTP API and its browser
  rendering were checked instead. No physical check on another user's computer
  or phone is claimed. This Mac review version has not been publicly released.

## Separate Matrix monitor

The Matrix monitor observes its configured runner account, not every room
member's accounts. Its committed formatter repair `a6b528a` in Multica Ops adds a
short hashed account label, the last percentage with its observation time, and
the new percentage. Eighteen synthetic sender tests passed on Mac and Linux.
The pinned runtime was activated with private config/state preserved; its timer
continued successfully with an unchanged poll. No manual/test message or replay
was posted. The operational verification is recorded in Multica Ops `72ed682`.
