# Interface geometry

Use the shared tokens in `settings/_tokens.scss` for UI padding, margins, gaps,
and radii. The scale follows [shadcn Mira](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/styles/style-mira.css), expressed relative to the selected interface font size.

- Default controls: `--control-height` (1.75× base); compact controls: 1.5× base.
- Touch controls that need a larger target use `--control-touch-size`.
- Buttons and fields: `--control-padding-inline`; related controls: `--control-gap`.
- Fields: `--field-gap`; groups: `--group-gap`; panels: `--panel-padding`.
- Icons: compact (`--icon-size-sm`, 0.75×), regular (`--icon-size-md`, 0.875×),
  and status (`--icon-size-lg`, 1×). Dimensions and outline weight belong in
  `components/_icons.scss`; keep hit areas independent of glyph size.
- Radii: `--radius-xs`, `--radius-micro`, `--radius-action`, `--radius-card`,
  `--overlay-radius`, and `--radius-pill`. Keep nested corners proportional to their container.
- Control heights and radii round to the root-font pixel increment to reduce fractional edge blur.

Opposite padding edges must match: left/right and top/bottom. Reserve scrollbar
space on both inline edges of actual scroll containers so effective insets remain equal.
Headers and content share a scrolling owner; do not mirror scrollbar gutters on non-scrolling headers.

Align component bounds through normal flow and shared insets. Center canonical SVG artwork
inside controls; do not crop view boxes or align individual glyphs to a container edge.
The editor has one toolbar above both panes, so their content starts on the same row. Do not add
negative margins or positioning offsets to compensate for inconsistent component spacing.
Positioned overlays, caret geometry, floating labels, safe-area insets, and document
rhythm retain their own functional constraints. Markdown typography uses em units
independently of interface density.
