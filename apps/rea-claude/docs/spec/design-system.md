# Silico desktop renderer: design system and layout spec

Source: Silico.app v0.137.0 (Goodfire), renderer bundle. Evidence: the prettified stylesheet
`pretty/renderer.css` (2,625 lines; cited below as `css:L`), `pretty/renderer.js` (cited as `js:L`), and
`out/renderer/index.html`. This is a clean-room description: it gives values and behavior, not the
original stylesheet. Each value comes from the CSS as read. Anything not stated directly in the CSS
is marked **Inferred** or **Unknown**.

---

## 1. Overview

Silico's renderer looks like a quiet, editorial developer tool. Surfaces are white "paper", with a
warm cream sidebar and near-black blue-grey ink. Headings and lab names use a serif (Newsreader).
Body text and controls use a neutral grotesque (Suisse Intl). Logs and fingerprints use IBM Plex Mono.
The design is flat. Hairline grey borders do the separation, and only popover menus have a shadow.
Burnt orange ("ember") is reserved for links, the single primary CTA, toggles and selection
accents. Hierarchy comes from border weight, type weight and the serif/sans contrast, not from
fills. Motion is short and calm: fades and small rises on a strong ease-out curve, plus a pulsing
brand mark for loading. All of it is turned off under `prefers-reduced-motion`.

The app has **only one theme (light)**. The CSS has no dark-mode tokens, no `prefers-color-scheme`
query and no `data-theme` attribute (Observed: the only media query is `prefers-reduced-motion`, css:862.
`js` grep for `prefers-color-scheme`/`data-theme`/`nativeTheme` finds nothing in app code). The only
root attribute the app sets is `data-platform` (js:23162), which drives window-chrome variants.

---

## 2. Tokens

All tokens are declared on `:root`, in two blocks (css:46-89 and css:800-803). The dark column is
"n/a" everywhere because the app ships no dark theme. A rebuild that wants dark mode has to design it
from scratch (see section 8).

### 2.1 Color

| Token | Light value | Dark | Usage (observed) |
|---|---|---|---|
| `--alabaster` | `#1d272a` | n/a | Body text / ink; hovered text of quiet controls |
| `--sandstone` | `#7b7b7b` | n/a | Muted text: secondary copy, icons, ghost buttons, rail version |
| `--sandstone-200` | `#d6d6d6` | n/a | Scrollbar thumb at rest |
| `--sandstone-300` | `#acacac` | n/a | Scrollbar thumb on hover |
| `--sandstone-400` | `#999999` | n/a | Fainter text: hints, placeholders, host lines, chevrons, menu context header |
| `--juniper-100` | `#efefef` | n/a | Faintest dividers (row rules, settings rows, menu context divider), sweep track |
| `--juniper-200` | `#e3e3e3` | n/a | Default hairline border (buttons, inputs, panels, rail edge, menu) |
| `--juniper` | `#b4b4b4` | n/a | Stronger border (icon-grid popout, toggle knob ring); terms text; footer bullet separator |
| `--juniper-500` | `#9c9c9c` | n/a | Hover border of quiet buttons / icon button |
| `--ember` | `#c4650d` | n/a | Primary accent: links, primary button fill, toggle on, active icon, radio accent, sweep segment |
| `--ember-50` | `#fdf1e7` | n/a | Soft ember wash: icon picker hover/active, staged-update banner |
| `--ember-700` | `#854208` | n/a | Hover of links and primary button |
| `--solar` | `#d07533` | n/a | Focus border on inputs; hover border of icon picker controls |
| `--card` | `#f7f7f3` | n/a | Cream: rail and sheet-rail background, row hover, menu item hover, panel bar, inline `code`, neutral pill |
| `--card-hover` | `#eeeee8` | n/a | Rail item hover, host-picker option hover, titlebar nav hover |
| `--card-50` | `#fdfdfc` | n/a | Console background, host-key panel, "new connection" row |
| `--paper` | `#ffffff` | n/a | Page and control surface |
| `--selected` | `#e3e3db` | n/a | Active rail item |
| `--success` | `#2e6e4e` | n/a | Declared; **no rule uses it** (Observed: no `var(--success*)` reference) |
| `--success-50` | `#e8f3ec` | n/a | Declared, unused |
| `--success-100` | `#c8e1d2` | n/a | Declared, unused |
| `--warning` | `#a66e0e` | n/a | Env badges text, warning hints/messages, spinner arc, keyring note |
| `--warning-soft` | `#ffebaa` | n/a | Env badge fill |
| `--warning-border` | `#e2c98a` | n/a | Env badge border, spinner track |
| `--danger` | `#8c3a2c` | n/a | Errors, danger menu item, danger pill, failure icon |
| `--danger-soft` | `#f5dcd7` | n/a | Error box fill, danger pill fill, alarm host-key panel fill |
| `--danger-border` | `#d9a99e` | n/a | Error box border, alarm panel border, host-key command chip border |

Literal colors that are not tokens: `#fff` on `.signup-shell`, `.signup-shell__bar` and `.picker` (css:731, 747, 1478).
The menu shadow uses `rgb(0 0 0 / 0.1)` (css:327-329). The `linear-gradient` in the sweep is
transparent → ember → transparent (css:2111).

### 2.2 Font stacks

| Token | Value |
|---|---|
| `--font-sans` | `"Suisse Intl", system-ui, -apple-system, sans-serif` |
| `--font-serif` | `"Newsreader", Georgia, serif` |
| `--font-mono` | `"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace` |

### 2.3 Radius

| Token | Value | Usage |
|---|---|---|
| `--radius-control` | `4px` | Buttons, menu items, pills, badges, icon buttons, rail items, rows, search input, fingerprints |
| `--radius-panel` | `6px` | Panels, menus, the inputs in `.form` and `.nest`, the host list, the icon grid |
| literal `4px` | | inline `code` |
| literal `6px` | | `.labbar__navbtn` |
| literal `9999px` / `50%` | | scrollbar thumb / spinner, toggle knob, avatar |
| literal `11px` | | toggle track (pill) |
| literal `3px` | | sweep track + segment |

### 2.4 Elevation

The look is flat by design. The **only** shadow is on the overflow menu `.ov__menu`:
`0 10px 15px -3px rgb(0 0 0/.1), 0 4px 6px -4px rgb(0 0 0/.1)` (css:327-329). This matches Tailwind's `shadow-lg`.
Z-index values used: menu backdrop 10, menu 11, icon grid 11, a row whose menu is open 20, sticky
backbar 2, sheet close button 2.

### 2.5 Motion tokens

| Token | Value |
|---|---|
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` |
| `--dur-view` | `200ms` |

### 2.6 Local / platform tokens

| Token | Scope | Value |
|---|---|---|
| `--mac-traffic-gutter` | `.labbar` | `92px` (css:2302) |
| `--wco-clearance` | `[data-platform="win32"]` | `calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px)) + 12px)` (css:2563-2566) |

### 2.7 Spacing scale

No spacing tokens exist. Paddings and margins are literal px values. Recurring values: 2, 4, 5, 6, 7, 8,
9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 40, 48. Some recurring rhythms:
- Page column inset 32px horizontally (24px in compact picker, 28px in settings sheet).
- Page title → content 26px. Section head top margin 30px, bottom 2px.
- Gaps in button/action rows are 8 to 10px. Form field gap is 14px (`.form`) and label→input is 5px.

### 2.8 Global base

- `* { box-sizing: border-box }`. `html, body` have margin 0, background `--paper`, color `--alabaster`,
  font `--font-sans` 14px, `font-variant-numeric: tabular-nums slashed-zero` (also on `:root`),
  `-webkit-font-smoothing: antialiased`, and `text-rendering: optimizeLegibility` (css:88-105).
- Links: ember, underlined, `text-underline-offset: 2px`. On hover they turn ember-700 (css:158-166).
- Inline `code`: mono, 0.92em, cream background, padding 1px 5px, radius 4px (css:666-672).
- Scrollbar (WebKit): 10px track, transparent. The thumb is a `--sandstone-200` pill (radius 9999px) with a
  1px transparent border and `background-clip: padding-box` (so it renders about 8px). It has
  min-height/min-width 48px and turns `--sandstone-300` on hover. The corner is transparent. Firefox-only
  fallback via `@supports not selector(::-webkit-scrollbar)`: `scrollbar-width: thin`,
  `scrollbar-color: --sandstone-200 transparent` (css:121-155).

---

## 3. Typography

### 3.1 Families and roles

| Family | Faces shipped (file) | Weights declared | Role |
|---|---|---|---|
| Suisse Intl (commercial) | Book .otf, Medium .otf, SemiBold .otf, Bold .otf | 400, 500, 600, 700 | All UI text, controls, body (`--font-sans`) |
| Newsreader (SIL OFL) | one variable .ttf | range `400 700` | Page titles, wordmark, lab names, empty-state question, loading/failure titles |
| IBM Plex Mono (SIL OFL) | Regular .ttf, Medium .ttf | 400, 500 | Connect console, host-key fingerprint and command chips, inline `code` |

All faces use `font-display: swap` (css:2-44). One rule asks for weight **300** (`.labbar__title`, css:2321), but no
300 face is declared. Chromium will fall back to the nearest available face (400 Book). **Inferred.**

### 3.2 Type scale (observed sizes)

| Size | Family / weight | Letter-spacing | Line-height | Where |
|---|---|---|---|---|
| 27px | serif 400 | -0.01em | normal | `.app__header h1` (dead CSS, see 7.3) |
| 25px | serif 400 | — | normal | `.gate__title` (sign-in) |
| 24px | serif 400 | -0.01em | normal | `.pane__h1` page title |
| 22px | serif 400 | -0.01em | normal | `.opening--loading .opening__title` |
| 20px | serif 400 | +0.025em | normal | `.brand__name` wordmark |
| 20px | serif 400 | -0.01em | normal | `.labstate__title`, `.opening__title`, `.opening__fail-title` |
| 20px | sans 500 | — | normal | `.viewer-recovery h1` |
| 18px | serif 400, muted | — | normal | `.labs__question` |
| 15px | serif (inherits 400) | -0.01em | normal | `.labrow__name` |
| 14px | sans 400 | — | normal | body default; `.form input/select`; `.gate__btn`; `.settings__k` (500) |
| 13.5px | sans | — | 1.5 / normal | `.labstate__sub` (1.5), `.nest input`, `.hostpick__alias` (500), `.hk__title` (600) |
| 13px | sans 500 | — | normal | `.btn`, `.label`, `.rail__item` |
| 13px | sans 400 | — | normal / 1.6 | `.ov__item`, `.linkaction`, `.gate__intro` (1.45), `.opening__fail-msg` (1.6), `.rail__acct`, `.hostpick__search`, `.labrow__addlink` |
| 12.5px | sans 500 | — | normal | `.panel__phase`, `.lbl`, `.labs__subhead` (muted) |
| 12.5px | sans 400 | — | 1.45 to 1.6 | `.gate__error`, `.test-msg` (1.45), `.hk__body` (1.5), `.labs__sub` (1.6), `.opening__phase` (1.6), `.backlink`, `.picker__foot`, `.foot__title`, `.hostpick__none`, `.hk__err` |
| 12px | mono 400 | — | 1.55 | `.console`, `.hk__fp`, `.hk__cmd` |
| 12px | sans 400 | — | 1.5 | `.settings__kk`, `.sview__secsub`, `.keyring-note`, `.hostpick__host`, `.gate__waiting`, `.labs__nudge`, `.gate__env`, `.foot__restart` |
| 12px | sans 300 (see note) | — | normal | `.labbar__title` |
| 11.5px | sans 400 | — | normal | `.hint`, `.labrow__hint`, `.labrow__host` |
| 11px | sans 500 | +0.01em | normal | `.brand__env` |
| 11px | sans 500 | — | normal | `.labrow__pill` |
| 11px | sans 400 | — | normal / 1.5 | `.ov__context`, `.signup-shell__env`, `.foot__sub` (1.5) |
| 10px | sans 400 | — | normal | `.gate__terms`, `.foot__ver`, `.opening__logs` (base) |
| 9px | sans 400 | — | normal | `.rail__ver` |

Numerals are tabular with a slashed zero everywhere (root `font-variant-numeric`).

---

## 4. Components

Component names come from the React functions in `renderer.js` that emit each className. Unless noted,
"hover" means `:hover`.

### 4.1 Buttons — `.btn` and variants (css:432-504)
- **Base `.btn`**: inherits font; 13px/500. Padding 6px 13px, 1px `--juniper-200` border, radius 4px, `--paper`
  background, ink text. Laid out as inline-flex, centered, gap 6px (icon + label). Transitions: background, border-color and color at 0.12s
  ease-out, and transform at 0.09s ease-out.
  - Hover (not disabled): the border darkens to `--juniper-500`. Nothing else changes, and there is deliberately no ember tint.
  - Active (not disabled): `scale(0.97)`.
  - Disabled: opacity 0.5, `cursor: not-allowed`.
- **`.btn--primary`**: weight 600. Fill and border are `--ember` and the text is `--paper`. On hover the fill and border turn `--ember-700`.
  This is the app's only solid fill. It is used for committing actions (Sign in, Save/Add, Accept host key, Retry).
- **`.btn--ghost`**: transparent border and background, `--sandstone` text. On hover the background is `--card` and the text turns ink
  (Cancel / Back).
- **`.labrow__open`** (modifier on `.btn`): weight 500, padding 4px 12px (the compact "Open" in rows).
- **`.gate__btn`** (on `.btn.btn--primary`): full width, padding 10px, 14px.
- `.labstate__actions .btn`: `white-space: nowrap`.
- `.addacct .btn`: `margin-left: auto`.

### 4.2 Link-style buttons
- **`.linkbtn`** (css:228-247): unstyled button in ember with an underline (offset 2px). Hover turns it ember-700. Disabled is
  sandstone with no underline and a default cursor. Used for the sign-in gate secondary link, `.labrow__addlink`
  (13px, margin-left auto) and `.foot__restart` (12px).
- **`.linkaction`** (css:252-267): ember, 13px, **no** underline at rest. On hover it turns ember-700 and gains an underline. Used
  for navigation-style actions ("Connect to a different lab"). `.picker__settings` overrides it to ink 12.5px with an underline only on hover
  (css:1545-1555).
- **`.backlink`** (css:2470-2487): inline-flex, gap 4px, 12.5px, sandstone. Hover turns it ink, with a 0.12s color transition. It holds a 16px
  chevron-left icon (js:21688).
- **`.opening__logs`** (css:2192-2209): 10px, `--sandstone-400`, opacity 0.6, margin-top 4px. Hover turns it ember at opacity 1 with an underline.
  Inside `.opening__footer` it is overridden (with `.linkaction`) to 13px, line-height 1.4, sandstone, opacity 1, and an underline only on
  hover in sandstone (css:2142-2155).

### 4.3 Icon buttons
- **`.ov__btn`** (overflow trigger, css:277-303): 28×28, radius 4px, 1px `--juniper-200` border, paper background, sandstone glyph.
  Inline-flex, centered. Hover: border `--juniper-500` and ink glyph. Active: scale 0.97. It contains a 16px "overflow menu horizontal" icon
  (js:21476). `OverflowMenu` can take a different trigger className (`"btn"` is passed at js:20359).
- **`.smodal__close`** (css:2415-2438): absolute top 14px / right 14px, 30×30, no border or background, radius 4px, sandstone. Hover turns it
  ink on `--card`. The icon is an 18px close glyph (js:23104).
- **`.labbar__navbtn`** (css:2345-2370): 24×24, radius 6px, transparent, sandstone. Hover (enabled) is `--card-hover` with ink. Disabled has
  opacity 0.3 and a default cursor. Transitions are 120ms ease. The icon is an 18px arrow (js:22949, 22960).
- **`.icon-btn`** (icon-picker cell, css:582-609): 30×30, transparent 1px border, radius 4px, paper, ink. Hover: border `--solar`,
  glyph ember, background `--ember-50`. `--active`: border ember, glyph ember, background `--ember-50`. Transitions are 0.12s ease.

### 4.4 Overflow menu — `OverflowMenu` (css:269-404)
- `.ov` is a relative inline-flex wrapper.
- `.ov__backdrop` is fixed, inset 0, z 10, and transparent. It is a click-catcher, and the icon picker reuses it too.
- `.ov__menu`: absolute, right 0, top 36px, z 11, min-width 162px. Paper background, 1px `--juniper-200` border, radius 6px, the shadow-lg
  shadow, padding 5px, flex column. Transform-origin top right. Entrance: `ovMenuIn` 140ms ease-out, `backwards` fill.
- `.ov__menu--up`: `top:auto; bottom:36px`, origin bottom right, animation `ovMenuInUp`. JS flips the menu up when the menu height + 8px
  is more than the space below the button (js:21459-21461).
- `.ov__item`: left-aligned, 13px ink, padding 7px 11px, radius 4px, nowrap. Hover background is `--card`. `--danger` makes the text danger.
- `.ov__context`: 11px `--sandstone-400`, padding 4px 11px 5px, max-width 240px, ellipsis. It is the non-interactive header.
- `.ov__context-sub`: margin-top 1px, ellipsis, 1px `--juniper-100` bottom border, margin-bottom 4px (the version line).
- `.labrow:has(.ov__menu)`: relative, z 20, so an open menu stacks above the rows below it.

### 4.5 Form controls — `ConfigureForm`
- **`.form`**: grid, gap 14px. **`.field`**: grid, gap 5px. **`.label`**: 13px/500 ink. **`.hint`**: 11.5px/400
  `--sandstone-400`, margin-left 6px. **`.hint--warn`** is warning colored and align-self center.
- **`.form input, .form select`**: inherits font, 14px, ink, padding 9px 11px, 1px `--juniper-200` border, radius **6px**, paper.
  Focus: no outline, border `--solar`. No focus ring beyond that.
- **`.nest`** ("new host" sub-fields): margin-top 12px, grid gap 12px. **`.fld`** is a grid with gap 5px. **`.lbl`** is 12.5px/500.
  **`.lbl__opt`** is `--sandstone-400`/400 with margin-left 6px. `.nest input`: 13.5px, padding 8px 11px, same border/radius/focus as above,
  width 100%, min-width 0.
- **`.row2`**: flex, gap 9px. Its `.fld` children have flex 1. **`.fld--port`** is fixed at 84px. **`.keyrow`** is flex with gap 7px and the input flexes.
  `.row` (gap 7px) also exists but is dead CSS.
- **`.nameicon`**: flex, gap 10px. `.nameicon__name` has flex 1.
- **`.iconpick`** (relative inline-flex). **`.iconpick__btn`**: inline-flex, gap 6px, 1px `--juniper-200` border, radius 4px, padding 8px 10px,
  paper. Hover gives border `--solar` and background `--ember-50`. It holds an 18px icon and an 11px chevron-down **`.iconpick__car`**
  (`--sandstone-400`) (js:22083-22087).
- **`.icon-grid`** popout: absolute at `top: calc(100% + 6px)`, left 0, z 11. A 7-column grid of 30px cells with gap 4px and padding 8px,
  paper, 1px **`--juniper`** (stronger) border, radius 6px, and no shadow.
- **Host picker**: `.hostpick__search` is a block at 100% width, margin-top 10px, padding 7px 10px, 13px, 1px `--juniper-200`, radius 4px. Its placeholder
  is `--sandstone-400` and its focus border is `--solar`. `.hostpick` is an unstyled list, margin-top 10px, max-height 340px with scrolling, 1px border, radius 6px.
  Adjacent items are divided by a 1px `--juniper-100` top border. `.hostpick__opt` is flex, gap 10px, padding 10px 12px. Its hover background is `--card-hover`.
  `.hostpick__body` is a column with gap 1px. `.hostpick__alias` is 13.5px/500. `.hostpick__host` is 12px sandstone with ellipsis. `.hostpick__new`
  is a separate bordered row below the list (margin-top 10px, radius 6px, `--card-50`). `.hostpick__none` has padding 12px and is 12.5px `--sandstone-400`.
- **`.choice__radio`**: native radio with `accent-color: --ember` and margin 0.
- **`.test-row`**: flex, gap 12px, margin-top 16px. **`.test-msg`**: flex 1, inline-flex, gap 6px, 12.5px/1.45, with a 14px
  warning icon (js:22380). `--err` is danger colored and `--warn` is warning colored.
- **`.form__actions`**: flex, left-aligned (`flex-start`), gap 10px, margin-top 22px. The primary button leads the row.

### 4.6 Toggle — `ToggleRow` (css:1124-1162)
- Track `.toggle`: 38×22, radius 11px, no border, background `--juniper-200`, padding 0. Background transition 0.12s ease.
- Knob `::after`: 16×16 circle, 1px `--juniper` border, paper background, at top 2px / left 2px. The `left` transition is 0.12s ease.
- `.toggle--on`: track turns ember and the knob moves to left 18px.
- `:disabled`: opacity 0.4, not-allowed (a dependent toggle while its master toggle is off).

### 4.7 Spinner — `.spinner` (css:406-421)
A 9×9 inline-block with margin-right 6px. Its 2px ring is `--warning-border` with a `--warning` top arc, radius 50%. It runs
`spin` 0.8s linear infinite (rotate to 360deg). It is used inline in buttons and loading cards.

### 4.8 Loading marks and progress
- **Flame pulse** (`.opening__logo`, `.labstate__logo` [dead], `.labcover__mark`): width 34px, base opacity 0.5,
  `flamePulse` 2s `cubic-bezier(0.4,0,0.6,1)` infinite (opacity 1 → 0.5 → 1).
- **Sweep track** `.opening__track` (css:2096-2121): margin-top 18px, width 200px (max 55%), height 3px, radius 3px, `--juniper-100`,
  overflow hidden. `::after` is a 40%-wide segment with an ember-centered transparent gradient, running `openTrackSweep`
  1.7s ease-out infinite (translateX -120% → 320%). Indeterminate only.
- **Viewer splash** `.viewer-splash img`: height 2rem, `viewer-splash-pulse` 1.6s ease-in-out infinite (opacity 0.18 ↔ 0.38).

### 4.9 Status pills, badges, dots
- **`.labrow__pill`** (css:1862-1882): 11px/500, radius 4px, padding 2px 7px, nowrap, no border.
  - `--danger`: danger text on `--danger-soft` ("Can't connect").
  - `--open`: sandstone text on `--card` ("Already open").
- **Environment badges** (non-prod indicator, warning palette with a 1px `--warning-border`, radius 4px):
  - `.brand__env`: 11px/500, +0.01em, padding 1px 7px, align-self center (beside the wordmark, and in the picker footer).
  - `.gate__env`: inline-block, 12px, padding 2px 8px, margin-bottom 14px (sign-in).
  - `.signup-shell__env`: 11px, padding 2px 7px, justify-self end.
- **Status dots**: none exist in the CSS. **Observed absence.**

### 4.10 Notices, errors, banners
- **`.gate__error`**: danger text on `--danger-soft`, 1px `--danger-border`, radius 4px, padding 8px 10px, 12.5px, margin-bottom 14px,
  left-aligned. This is the app's tinted error box.
- **`.keyring-note`**: plain warning-colored text, 12px/1.5, no box. `--gate` has margin-top 14px. `--settings` has margin-top 12px and max-width 560px.
- **Staged-update banner `.foot.foot--banner`** (`RestartFoot`): `--ember-50` wash. It contains `.foot__title` (12.5px ink),
  `.foot__sub` (11px sandstone, 1.5, margin 3px 0 8px) and `.foot__restart` (linkbtn 12px).
- **`.foot`** (`UpdateFooter`, version read-out): 1px `--juniper-200` top border, padding 10px 16px. `.foot__ver` is 10px sandstone.
- **Toasts**: none exist in the CSS or app code classNames. **Observed absence.**

### 4.11 Host-key trust panel — `HostKeyPanel` (css:1389-1457)
- `.hk`: margin-top 12px, 1px `--juniper-200`, radius 6px, `--card-50`, padding 13px 15px.
- `.hk--alarm` (key changed): border `--danger-border`, background `--danger-soft`. Its title and body turn danger.
- `.hk__title`: flex, gap 6px, 13.5px/600, margin-bottom 6px (icon + text).
- `.hk__body`: sandstone, 12.5px/1.5, margin 0 0 10px.
- `.hk__fp`: block mono 12px on paper, 1px `--juniper-200`, radius 4px, padding 8px 10px, margin-bottom 12px, `word-break: break-all`.
- `.hk__cmd`: inline-block mono 12px on paper, 1px `--danger-border`, radius 4px, padding 6px 10px.
- `.hk__err`: danger, 12.5px. `.hk__acts`: flex, gap 8px.

### 4.12 Connect progress panel / console — `ProgressPanel`
- `.panel`: margin-top 12px, 1px `--juniper-200`, radius 6px, overflow hidden, paper. Entrance `viewRiseIn` 180ms ease-out.
- `.panel__bar`: flex space-between, gap 8px, padding 8px 12px, `--card` background, 1px bottom border. `.panel__phase` is 12.5px/500.
  `.panel__actions` is flex with gap 6px.
- `.console`: a `<pre>`-like block. Margin 0, padding 11px 12px, max-height 260px with scrolling, `--card-50`, ink, mono 12px/1.55,
  `pre-wrap`, `break-word`. Inside `.opening__console` it has a **fixed** height of 220px and no max-height. `.opening__console` is 100% width,
  max 720px, margin-top 4px, left-aligned.

### 4.13 Lab list — `App` (labs view), `ChooseLab` (add-a-lab picker)
- `.lablist`: unstyled `<ul>`, margin `0 -8px`. It overhangs the text column by 8px per side.
- `.labrow`: relative flex, align center, gap 13px, **height 52px**, padding 0 8px, radius 4px, pointer cursor, background transition
  0.12s ease-out. Hover background is `--card`. The divider is `::after`, absolute, inset left/right 8px at the bottom, 1px `--juniper-100`
  (inset so it lines up with the text column). The list has no top rule.
- `.labrow__icon`: 16px wide, sandstone (16px icons). `.labrow__name`: serif 15px, -0.01em, ellipsis.
  `.labrow__name--muted` is sandstone.
- `.labrow__hint`: 11.5px `--sandstone-400`, nowrap ("Update on open").
- `.labrow__actions`: margin-left auto, flex, gap 8px. It holds `.btn.labrow__open` and the `.ov` menu.
- Variants:
  - `--disc` (discovered, empty state): default cursor, no hover background.
  - `--pick` (a real `<button>` in the add flow): width 100%, inherits font, left-aligned, transparent, no border, height auto,
    min-height 52px, vertical padding 9px. Hover background is `--card`.
  - `--stacked` (two-line outside picker): same auto-height sizing as `--pick`.
- Two-line anatomy: `.labrow__main` (flex 1 column) → `.labrow__titlerow` (flex, gap 8px, holds name and pill) →
  `.labrow__host` (margin-top 2px, 11.5px `--sandstone-400`, ellipsis). `.labrow__chev` is `--sandstone-400`.
- Page header: `.labs__head` is flex, align center, gap 12px, margin-bottom 26px. `--tight` sets margin-bottom to 4px (when `.labs__sub` follows).
  `.labs__actions` is margin-left auto, flex, gap 10px (holds a `.btn` with a 16px add icon).
- `.labs__subhead` (section head, `<h2>`): margin 30px 0 2px, 12.5px/500 sandstone. `--first` has margin-top 0, except
  `.sview .labs__subhead--first`, which has margin-top 20px.
- `.labs__sub`: margin 0 0 16px, 12.5px/1.6 sandstone, max-width 64ch. `.labs__question`: serif 18px sandstone, margin 0 0 16px.
  `.labs__nudge` is 12px `--sandstone-400`.
- `.addacct` (account on the empty picker): flex, align center, gap 11px, margin-top 18px. It holds a 34px avatar and a `.btn` pushed right.
  `.addacct__note` has margin-top 14px.
- `.addlocal` (section wrapper) and `.labs` (modifier on `.pane__inner`) are used in JS but have **no CSS rules**.

### 4.14 Settings — `SettingsView`, `ToggleRow`, `Avatar`
- `.sview__sec`: margin-top 26px. When it directly follows `.labs__subhead` the margin-top is 0. `.sview__secsub`: margin 3px 0 0, 12px/1.5 sandstone.
- `.settings__item`: flex, space-between, align center, gap 18px, padding 15px 0, 1px `--juniper-100` bottom border. The last child
  in a section keeps its border. `.settings__k` is 14px/500. `.settings__kk` is 12px/1.5 sandstone with margin-top 2px.
- `.settings__id`: flex, align center, gap 11px (36px avatar + text).
- `.avatar`: `<img>` that does not shrink, round (50%), `object-fit: cover`, `--card` placeholder background. The size comes from the width/height
  attributes. Observed sizes: 18 (picker footer), 22 (rail account), 34 (add-account), 36 (settings), default 32.

### 4.15 Sign-in gate — `SignIn` (css:675-724, 1013-1078)
- `.gate`: min-height 100vh, grid with `place-items: center`, padding 24px. Entrance `viewCardIn`.
- `.gate__card`: width 100%, max 360px, padding-top 8px, centered text. `--loading` is a centered grid with min-height 160px (holds a spinner).
- `.gate__logo`: height 44px, margin-bottom 14px. `.gate__title`: serif 25px/400, margin 0 0 7px.
- `.gate__intro`: sandstone 13px/1.45, margin-bottom 18px. `.gate__actions`: grid gap 8px.
- `.gate__waiting`: sandstone 12px, margin-top 12px. `.gate__terms`: `--juniper` 10px, margin-top 14px (8px between consecutive ones).
  Links inherit the color and turn ember on hover.

### 4.16 Signup shell — `SignupShell` (css:729-797)
- `.signup-shell`: min-height 100vh, `#fff`.
- `.signup-shell__bar`: **height 78px** (34px traffic-light clearance + 32px row + 12px bottom). It is a 3-column grid
  `1fr auto 1fr`, padding 34px 16px 12px, `#fff`, and it is a **drag region**. The JS-side constant `SIGNUP_HEADER_HEIGHT` must match it (per comment).
- `.signup-shell__back`: no-drag, justify start, inline-flex, gap 7px, min-height 32px, ember, no underline at rest. On hover it turns
  ember-700 and gains an underline.
- `.signup-shell__title img`: height 22px. `.signup-shell__env`: see 4.9.

### 4.17 Lab state / opening screens — `LabStatePanel`, opening branches of `App`
- `.centered`: grid center, min-height 100vh, padding 40px 24px.
- `.labstate`: centered text, max 440px. `.labstate__icon` is a centered flex in sandstone (38px renew icon, js:21407).
  `.labstate__title`: serif 20px, -0.01em, margin-top 14px. `.labstate__sub`: sandstone 13.5px/1.5, margin-top 8px.
  `.labstate__actions`: flex wrap, gap 10px, centered, margin-top 20px.
- `.openfull`: min-height 100vh, paper, flex column, `overflow-y: auto`.
- `.opening`: max-width 880px, `margin: auto` (true centering inside `.openfull`, collapsing to top-aligned when tall), width 100%,
  padding 40px 32px, flex column centered, centered text. Entrance `viewFadeIn`.
- `.opening--loading`: margin 0, padding 0, no max-width, flex 1, stretch. It contains `.opening__center` (flex 1, max 880px, padding
  40px 32px, column centered both ways) and `.opening__footer` pinned at the bottom (row, centered, gap 12px, padding 14px 0 24px). The
  separator `.opening__sep` is `--juniper` 12px, not selectable. In this variant the logo is static (opacity 1, no animation) and
  the title is 22px with margin-top 18px.
- `.opening__title`: serif 20px/400, -0.01em, margin-top 16px. `.opening__phase`: margin-top 8px, max 56ch, 12.5px/1.6
  sandstone. It re-runs `viewFadeIn` 180ms each time its text key changes.
- `.opening__actions`: flex, gap 10px, centered, margin-top 18px. `--secondary` has margin-top 12px.
- `.opening__fail`: column centered, max 560px. `.opening__fail-icon` is danger (20px warning icon). `.opening__fail-title` is serif
  20px ink with margin-top 14px. `.opening__fail-msg`: 13px/1.6 sandstone, max 56ch, `overflow-wrap: anywhere`.
- `.opening__hk`: 100% width, max 560px, left-aligned. Its actions are left-aligned with margin-top 12px.
- JS also renders a hidden (visibility:hidden, aria-hidden) placeholder copy of the loading layout to reserve space
  (≈js:21116-21150, the `openfull` branch of `App`). **Observed.**

### 4.18 Viewer window — `ViewerShell`
- `.viewer-splash`: fixed, inset `32px 0 0 0`, flex centered, paper. The image is 2rem tall and pulses.
- `.viewer-recovery`: flex column centered, min-height `calc(100vh - 32px)`, gap 16px, padding 32px, centered text. The image is 40px wide.
  The `h1` is 20px/500 with margin 0. The `p` has max 440px and margin 0 0 8px. Buttons are plain `.btn`.

---

## 5. Layout and window chrome

### 5.1 Window modes (React root selection, js:23162-23175)
- Hash `#settings-modal/<tab>` → `SettingsModal` (sheet).
- Hash `#viewer` → `ViewerShell`.
- Otherwise `App`, which shows one of: sign-in gate, signup shell, full workspace shell, compact picker, opening screen, lab
  state, or the lab titlebar strip.
- `document.documentElement.dataset.platform` is set from preload (`darwin`/`win32`/`linux`). The macOS layout is the
  default whenever the attribute is absent or isn't win32/linux.

### 5.2 Workspace shell (`.shell` → `.rail` + `.pane`) (css:1462-1756)
- `.shell`: flex, height 100vh, overflow hidden, `viewFadeIn` entrance.
- **Rail** `.rail`: fixed width **232px** (flex 0 0 232px), column, `--card` background, 1px `--juniper-200` right border.
  - `.rail__top`: **drag region**, padding **38px 20px 12px** (the 38px top clears the macOS traffic lights). It holds `.brand`
    (flex, gap 9px). `.brand__logo` is 26px tall by default and **18px inside `.rail__top`**. `.brand__name` is the serif 20px wordmark. `.brand__env` may follow.
  - `.rail__nav`: column, gap 2px, padding 0 10px. `.rail__item`: flex, gap 8px, 13px/500 ink, transparent, radius 4px,
    padding 7px 10px, left-aligned, **no-drag**, background transition 0.12s. Hover is `--card-hover` and `--active` is `--selected`. Icons are 14px.
  - `.rail__spacer` (flex 1) pushes the footer down. Then the optional `RestartFoot` banner.
  - `.rail__acct`: column, gap 6px, padding 12px 12px 14px 16px, 1px top border, 13px/400. `.rail__acct-row` is flex with gap 8px and holds a
    22px avatar and `.rail__login` (ellipsis). `.rail__ver` is 9px sandstone with ellipsis.
- **Pane** `.pane`: flex 1, column, paper.
  - `.pane__bar`: **drag region**, **32px** tall, flex, right-aligned (`flex-end`), gap 10px, padding 0 20px.
  - `.pane__body`: flex 1, `overflow-y: auto` (the pane is the scroll container, not the body).
  - `.pane__inner`: centered column, **max-width 880px**, padding **6px 32px 48px**, `viewFadeIn` entrance. `.pane__h1` is the serif page title.
  - `.pane__body .app` (legacy views) takes the same 880px column and padding.
- `.labcover`: fixed from top 32px to the bottom, paper, grid center, `pointer-events: none`. It is the backdrop behind the native Lab
  view during handovers and holds a 34px pulsing flame mark at opacity 0.5.

### 5.3 Compact mode — the Labs picker (`.picker`, css:1473-1555)
- This is a small window holding only the list. JS calls `window.silico.setCompact(labsPicker, contentHeight)` and measures content height
  so the main process can resize the window to fit (js:19760-19798). **Observed**. The exact window dimensions live in the main process and are **Unknown** here.
- `.picker`: flex column, 100vh, overflow hidden, `#fff`, **padding-top 32px** (reserves the fixed `.dragstrip`). `viewFadeIn`.
- `.picker__body`: flex 1, scrolls, no padding of its own, so sticky headers sit flush at y=32.
- `.picker__body .pane__inner` and `.picker__body .app`: padding **14px 24px 32px** (`.app` loses its max-width and margin).
- `.picker__foot`: flex, gap 8px, padding 10px 16px, 1px top border, 12.5px sandstone. It holds an 18px avatar, `.picker__login` (ellipsis),
  `.brand__env`, and `.picker__settings` pushed right.
- `.backbar` (sub-pages: settings, add-a-lab): **sticky top 0**, z 2, margin `0 -24px 22px`, padding `0 24px 8px`, paper background,
  so content scrolls behind it. It holds a `.backlink`.

### 5.4 Drag regions (`-webkit-app-region`)
| Selector | Value | Height / position |
|---|---|---|
| `.dragstrip` | drag | fixed top/left/right 0, **32px** (gate, lab-state, open-full, picker) |
| `.rail__top` | drag | rail header block |
| `.pane__bar` | drag | 32px |
| `.labbar` | drag | 32px |
| `.signup-shell__bar` | drag | 78px (mac), 56px (win/linux) |
| `.rail__item`, `.signup-shell__back`, `.labbar__nav` | **no-drag** | interactive children |

There is a single titlebar height of **32px** everywhere. Comments say it must match `TITLEBAR_STRIP_HEIGHT` /
`LAB_VIEW_TOP_INSET` in main.

### 5.5 Lab titlebar strip — `TitlebarStrip` (`.labbar`, css:2293-2370)
- Shown while a Lab is open. The native Lab view sits flush beneath it. It is 32px tall, a flex row, centered, on a paper background, with **no bottom border**.
- It uses symmetric horizontal padding of `var(--mac-traffic-gutter)` = **92px**, so the title stays window-centered.
- `.labbar__title`: 12px, weight 300, sandstone, ellipsis.
- `.labbar__nav` (back/forward): absolute at `left: 92px`, top 0, height 32px, flex, gap 2px, no-drag. Each button is a 24px `.labbar__navbtn`.
- macOS traffic lights: the CSS only reserves space. Comments say the lights start at x:16 and center vertically in the
  strip (y = (32 − 12)/2 = 10). The rail's 38px top padding and the signup bar's 34px top padding clear them. The light
  position itself is set in the main process. **Observed (comment)**; actual values are **Unknown** from CSS.

### 5.6 Platform overrides (css:2562-2602)
- **win32**: `--wco-clearance` is defined (window-controls-overlay, which covers the right 138px plus a 12px gap by fallback). Overrides: `.rail__top` padding-top
  12px; `.pane__bar` padding-right = clearance; `.labbar` padding `0 clearance` (symmetric); `.signup-shell__bar` height 56px, padding
  12px 16px, padding-right = clearance.
- **linux** (native frame): `.rail__top` padding-top 12px; `.labbar` padding 0 16px; `.signup-shell__bar` height 56px, padding 12px 16px.

### 5.7 Settings sheet — `SettingsModal` (`.smodal`, css:2377-2438)
- A modal child window over a Lab. `.smodal` is relative, 100vh, flex, paper, overflow hidden, with a **1px `--juniper-200` border around
  the whole window** (keeps the frameless edge visible).
- `.smodal__rail`: **188px**, column, padding-top 16px, `--card`, right border. It reuses `.rail__nav`/`.rail__item`/`.rail__spacer`/`.foot`.
- `.smodal__main`: flex 1, scrolls. `.smodal .pane__inner` has no max-width, padding 24px 28px 32px, and **no entrance animation**
  (the OS sheet animation is the entrance).
- `.smodal__close` sits at top-right (see 4.3). Escape also closes it (per comment).

### 5.8 Legacy `.app` container
`.app` (max 820px, padding 28px 28px 48px, fade-in) and `.app__header` are declared, but the class `app` never appears in app code,
so they are dead CSS. Their only effect is the `.pane__body .app` / `.picker__body .app` overrides, which also never match. **Observed (grep).**

### 5.9 Responsive rules / media queries
- **No width breakpoints exist.** The only `@media` is `prefers-reduced-motion: reduce` (css:862-882).
- The only `@supports` is `not selector(::-webkit-scrollbar)` (css:121).
- Fluid behavior comes from max-widths (880/820/720/560/440/360px, 64ch, 56ch), `margin-inline:auto`, flex-wrap on
  `.labstate__actions`, and `max-width: 55%` on the sweep track.

---

## 6. Motion

| Name | Keyframes | Duration / easing / fill | Applied to |
|---|---|---|---|
| `viewFadeIn` | opacity 0 → 1 | 200ms (`--dur-view`) ease-out, backwards | `.app`, `.shell`, `.picker`, `.pane__inner`, `.opening` |
| `viewFadeIn` | same | 180ms ease-out, backwards | `.opening__phase` (re-keyed per status text) |
| `viewCardIn` | from opacity 0, translateY(6px) scale(0.985) → none | 200ms ease-out, backwards | `.gate` |
| `viewRiseIn` | from opacity 0, translateY(8px) → none | 180ms ease-out, backwards | `.panel` |
| `ovMenuIn` | from opacity 0, translateY(-4px) scale(0.97) | 140ms ease-out, backwards; origin top right | `.ov__menu` |
| `ovMenuInUp` | from opacity 0, translateY(4px) scale(0.97) | 140ms ease-out; origin bottom right | `.ov__menu--up` |
| `spin` | rotate → 360deg | 0.8s linear infinite | `.spinner` |
| `flamePulse` | opacity 1 / 0.5 @50% / 1 | 2s cubic-bezier(0.4,0,0.6,1) infinite | `.opening__logo`, `.labstate__logo`, `.labcover__mark` |
| `openTrackSweep` | translateX(-120%) → 320% | 1.7s ease-out infinite | `.opening__track::after` |
| `viewer-splash-pulse` | opacity 0.18 / 0.38 @50% / 0.18 | 1.6s ease-in-out infinite | `.viewer-splash img` |

`ease-out` above always means `--ease-out` = `cubic-bezier(0.16, 1, 0.3, 1)`.

**Transitions**
- Quiet controls (`.btn`, `.ov__btn`): color, border and background 0.12s ease-out, plus transform 0.09s ease-out (press scale 0.97).
- `.labrow` background 0.12s ease-out. `.backlink` color 0.12s ease-out.
- `.icon-btn`, `.iconpick__btn`, `.rail__item`, `.toggle` (+ knob `left`), `.smodal__close`: 0.12s `ease` (the plain keyword).
- `.labbar__navbtn`: 120ms ease.

**Reduced motion** (css:862-882): animation is set to none on `.app, .gate, .shell, .pane__inner, .opening, .panel, .ov__menu,
.labstate__logo, .labcover__mark, .opening__logo, .opening__phase`, and the press scale is removed from `.btn` and `.ov__btn`. **Not**
covered: `.picker`'s fade, `.spinner`, `.opening__track::after` sweep, `.viewer-splash img` pulse. That list is **Observed**. Whether
leaving them out was deliberate is **Unknown**.

---

## 7. Evidence ledger

### 7.1 Observed (direct from CSS, by line)
- Font faces and families: css:1-44, 76-78. Palette and radius tokens: css:46-89. Motion tokens: css:800-803.
- Base, scrollbar, links: css:91-166. Brand: 189-223. Link buttons: 228-267. Overflow menu: 269-404. Spinner: 406-421.
- Buttons: 432-504. Form: 507-621. Panel/console/code: 624-672. Gate: 675-724, 1013-1078. Signup: 729-797.
- Keyframes / view animations: 805-860. Reduced motion: 862-882. Dragstrip: 890-898. Openfull/labcover: 902-941.
- Centered/labstate: 944-1011. Settings rows / avatar / toggle: 1081-1162. Host picker / nest fields: 1165-1360.
- Test row: 1363-1386. Host-key: 1389-1457. Shell/picker/rail/pane: 1462-1756. Lab list: 1759-2036.
- Opening screens: 2039-2286. Labbar: 2293-2370. Settings sheet: 2377-2438. Backbar/sview: 2459-2516.
- Viewer splash: 2521-2543. Platform overrides: 2562-2602. Viewer recovery: 2604-2625.

### 7.2 Observed (from JS)
- Component → className mapping (section 4 headings): extracted from `renderer.js` app code (≈js:19270-23175).
- `data-platform` set on `<html>` from `window.silico.platform` (js:23162). Root switch by hash (js:23163-23175).
- Menu flip rule (js:21459-21461). Compact mode `setCompact` and content-height measurement (js:19760-19798).
- Icon sizes: add 16, overflow 16, rail nav 14, back chevron 16, titlebar arrows 18, close 18, renew 38, warning 20/15/14,
  icon-picker 18 + caret 11. Icons are React components with a 32×32 viewBox and a default size of 16 (js:18040-18900). By naming
  (Add, Chemistry, Renew, OverflowMenuHorizontal, WarningAltFilled), they appear to be the **IBM Carbon icon set** (**Inferred**.
  No package name survives in the bundle).
- CSP in index.html allows remote images only from github.com / avatars.githubusercontent.com (the avatar).

### 7.3 Dead or vestigial CSS (Observed: class never emitted by app code)
`.app`, `.app__header`, `.row`, `.spacer`, `.labstate__logo`, `.addflow__actions`. The success-* tokens are never referenced.
`.btn-quiet` appears only in a comment.

### 7.4 Inferred
- Weight 300 on `.labbar__title` renders as 400 (no 300 face).
- `.btn` with icon + label uses the 6px gap for a 16px icon (e.g. "Add a lab").
- `.ov__backdrop` is transparent (no background declared), and it also closes the icon grid (reused in `ConfigureForm`).
- The scrollbar thumb renders as roughly an 8px visible pill (10px minus the 1px transparent border on each side).

### 7.5 Unknowns
1. **Dark mode**: none exists. Colors for a dark theme are undefined (any rebuild values are new design, not reverse-engineered).
2. Window sizes (full, compact picker min/max, settings sheet), `trafficLightPosition`, and vibrancy are set in the main process, not
   visible in the renderer CSS.
3. The comment in css:2581 mentions "the mac 84px", but the token value is 92px. Treat **92px** as authoritative.
4. Whether the shipped font files are full or subset glyph sets (not inspected).
5. Focus-visible styling for keyboard users: no `:focus-visible` rules exist. Only inputs change border on focus. Buttons rely on the UA
   default outline (**Unknown** whether Chromium shows it in this app's context).
6. Exact icon set and version (Carbon is Inferred).
7. Toast/notification styling: none in the renderer. Any OS-level notifications are out of scope.

---

## 8. Reimplementation notes

### 8.1 Proposed CSS file structure (plain CSS, imported once from the React entry)
```
src/styles/
  fonts.css        @font-face via @fontsource imports (see 8.2)
  tokens.css       :root tokens (color, fonts, radius, motion, z-index); [data-platform] vars
  base.css         reset, html/body, links, code, scrollbar, reduced-motion global block
  motion.css       all @keyframes + view entrance assignments
  chrome.css       dragstrip, labbar, signup-shell bar, platform overrides
  components/
    button.css     .btn, --primary, --ghost, .linkbtn, .linkaction, .backlink, icon buttons
    menu.css       .ov*
    form.css       .form/.field/.label/.hint, .nest/.fld/.lbl, .row2/.keyrow, hostpick, iconpick, toggle, test-row
    feedback.css   spinner, pills, env badges, gate__error, keyring-note, foot banner, hk panel, panel/console
  layouts/
    shell.css      .shell, .rail*, .pane*, .labcover
    picker.css     .picker*, .backbar
    lablist.css    .lablist, .labrow*, .labs__*
    opening.css    .openfull, .opening*, .centered, .labstate*
    settings.css   .sview*, .settings__*, .smodal*
    gate.css       .gate*
    viewer.css     .viewer-splash, .viewer-recovery
```
- Keep BEM-style class names so behavior-level specs from the other analysts map 1:1. Drop the dead classes in 7.3.
- Define `--ease-out`/`--dur-view` in the same `:root` block as the other tokens. The original splits them across two blocks.
- Add a `:focus-visible` ring (e.g. 2px `--solar` outline, offset 2px). The original has none, so this is an a11y improvement and
  should be labeled as a deviation.
- If dark mode is wanted, add it as a **new** token layer under `@media (prefers-color-scheme: dark)` plus a
  `:root[data-theme]` override, and document it as an extension. Do not present it as Silico behavior.

### 8.2 Fonts and licensing
| Role | Original | License | Rebuild |
|---|---|---|---|
| Sans (UI) | Suisse Intl (Swiss Typefaces) | **Commercial**. Must **not** be shipped or copied | **Inter** via `@fontsource-variable/inter` (SIL OFL 1.1). Load 400/500/600/700. Inter supports `tnum` and `zero`, so the root `tabular-nums slashed-zero` still works. Optional: `font-feature-settings: "cv11"` is not needed. Note Inter is slightly wider and taller than Suisse, so expect minor line-length drift |
| Serif | Newsreader (Production Type) | **SIL OFL 1.1**. Redistribution and bundling are permitted (the font may not be sold by itself, and modified versions may not use the Reserved Font Name) | `@fontsource-variable/newsreader` (weights 400–700). Do not copy the app's `.ttf` (clean-room) |
| Mono | IBM Plex Mono (IBM) | **SIL OFL 1.1**. Bundling permitted under the same terms | `@fontsource/ibm-plex-mono` weights 400 and 500 |

Keep the fallback stacks exactly as in 2.2, with `"Inter"` replacing `"Suisse Intl"` at the head of `--font-sans`. Inter ships a
300 weight, so the `.labbar__title` weight-300 rule will **actually render light** in the rebuild. To match the original's
appearance, use 400 instead (see 7.4).

### 8.3 Icons
Use `@carbon/icons-react` (Apache-2.0) if fidelity to the inferred Carbon set is wanted, or any 16px-grid outline set otherwise.
Sizes are listed in 7.2.
