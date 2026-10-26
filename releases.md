# Releases

Release descriptions are copied verbatim from their linked sources. Dates below
identify PR merges or GitHub Release publication, as labelled.

<!-- prettier-ignore-start -->

## v3.1.1

Merged: 2026-10-20
Source: [Pull request #28](https://github.com/toxdes/vylk/pull/28)

## Changes

Changes since [previous release](https://github.com/toxdes/vylk/releases/tags/v3.1.0):
1. feat(zen): inline formatting and links; hide markdown markers; add compact toolbar and link editor popups
2. fix(zen): correct mixed formatting; "Select All" + "Delete" action; caret mapping, IME input, and undo action
3. fix(editor): slower edge-drag selection scrolling; stop caret animations from running indefinitely
4. ui(zen): typography, popup spacing; keyboard/mobile accessibility
5. ui(preferences): Add `Google Fonts` hyperlink to `use google fonts` checkbox
6. ui(preview): remove the 72ch width cap and black focus outline; focus the active writing pane
 7. ui(dialogs): uniform modal entrance/exit animations, motion preferences
8. fix(sync): preserve retry back-off during cross-tab lock contention, preventing rapid retry loops and excessive CPU usage
9. ci: fix release deployment hooks for the demo and landing page; update `staticcheck` compatibility.
10. chore: remove unused code and stale tests; expand editor, sync, motion, and browser regression coverage

## v3.1.0

Merged: 2026-10-03
Source: [Pull request #23](https://github.com/toxdes/vylk/pull/23)

## Changes 

Changes since [previous release](https://github.com/toxdes/vylk/releases/tag/v3.0.4):
1. feat(e2ee): Add end-to-end encryption, recovery keys, passphrase management, and resumable vault migration.
2. feat(devices): Add device management and remembered unlocks across tabs and refreshes.
3. fix(sync): Prevent reset-induced sync loops, preserve pending edits, and safely detect database replacements.
4. fix(saving): Resolve save/acknowledgement races that caused false conflicts.
5. feat(ui): Add consistent navigation/dialog animations and configurable reduced motion.
6. feat(defaults): Default to write view with interactive preview; update Zen defaults and add Ctrl+1–4 view shortcuts.
7. fix(editor): Improve mobile controls, preview alignment, Zen scrolling, composition, and undo.
8. fix(updates): Harden service-worker reloads and dismiss obsolete update banners.
9. feat(ci): Automate tagged GitHub releases and HTTPS deployment hooks, with downgrade protection and explicit rollback.
10. docs(api): Add comprehensive OpenAPI and client-protocol documentation; refresh self-hosting guides.
11. breaking(encryption): Remove legacy server-side file encryption and its configuration.
12. test: Expand encryption, recovery, sync, and browser coverage; stabilize animation-dependent assertions.

## v3.0.4

Published: 2026-09-23
Source: [GitHub Release v3.0.4](https://github.com/toxdes/vylk/releases/tag/v3.0.4)

## Installation 
Check [install instructions](https://vylk.toxdes.com/docs/#install).
## What's Changed
* refactor: human friendly code; UI elements touch-up by @toxdes in https://github.com/toxdes/vylk/pull/16
* release: v3.0.4 by @toxdes in https://github.com/toxdes/vylk/pull/17


**Full Changelog**: https://github.com/toxdes/vylk/compare/v3.0.3...v3.0.4

<!-- prettier-ignore-end -->
