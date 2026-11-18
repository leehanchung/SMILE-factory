# Academic Thesis Defense Design System (brand-free, reusable)

> Applicable scenarios: long academic thesis defenses / research presentations / paper talks (100+ page scale). This system abstracts only visual and layout rules and contains no brand, person, institution, title, original text, original figure, or real data.

---

## 1. Visual DNA

- **Character**: restrained, academic, white-background minimalism. Information density is high but whitespace is generous, winning through typographic hierarchy rather than decoration.
- **Base color**: a pure white canvas, with full-bleed color blocks appearing very rarely; color is used only as functional coding (emphasis, categorization, progress), never as decoration.
- **Line quality**: core illustrations use a hand-drawn/line-art style (thin black lines, gray fills), contrasting with the sans-serif body font to create a "rigorous framework + approachable diagram" feel.
- **Progressive narrative**: the same composition is built up progressively across multiple pages (frame-by-frame highlighting, graying-out, adding elements) — this is the deck's single most important expressive device, so static pages must reserve room for "step-by-step reveal."
- **Dual-engine structure**: main-thread sections are driven by a full-width navigation footer; side-thread/backup slides (extra slides) use a simplified footer, with one stable page skeleton unifying 140+ pages.

## 2. Canvas and Grid

- **Ratio**: 16:9 landscape.
- **Safe margins**: about 4–5% of the canvas width on left and right, about 6% at the top, with about 10–12% reserved at the bottom for the footer zone.
- **Main grid**: mostly a single column; for two-column comparisons, equal widths on both sides (48/48, with a 4% gap in between); for a four-column card grid, four equal-width columns with consistent column gaps.
- **Alignment**: titles, body text, and charts are all left-aligned; only cover secondary info, divider-page large text, and the acknowledgments page may be centered or center-left.
- **Content area**: title area (top, one line) + body area (middle, about 70% of the height) + footer area (a fixed band at the bottom). Within the body area, when charts and text are mixed, text sits on the left and diagrams on the right or center.

## 3. Font Hierarchy

The whole deck uses a single sans-serif family, QuattrocentoSans (humanist sans; Chinese: MiSans), differentiated only by weight and size; code/formula snippets use JetBrains Mono (brought in via customFonts).

| Tier | Purpose | Relative size | Weight | Color |
| --- | --- | --- | --- | --- |
| H0 | Cover main title | 100% baseline ×2.2 | Bold | Near-black |
| H1 | Content-page title | ×1.5 | Bold | Near-black |
| H2 | Column title / card title | ×1.1 | Bold | Near-black |
| Divider-page large text | Section divider page | ×1.8 | Bold (keywords) + Regular (the rest, light gray) | Black/light-gray mix |
| Body | Lists and paragraphs | ×0.85 | Regular | Near-black |
| Small text | Footnotes, table notes, figure captions | ×0.6 | Regular | Medium gray |
| Footer | Navigation and page number | ×0.5 | Regular (current item Bold) | Gray/black |

- Body line height 1.3–1.4; list-item spacing is 0.5× the line height.
- Emphasis is limited to: **bold**, the theme color, and a local highlight background — italics, underlines, and shadowed text are not used.

## 4. Color Tokens

| Token | Color value (approximate) | Purpose |
| --- | --- | --- |
| `bg` | `#FFFFFF` | Global base color |
| `ink` | `#1A1A1A` | Titles and body text |
| `ink-muted` | `#8C8C8C` | Secondary text, non-current footer items, grayed-out state |
| `line` | `#BFBFBF` | Table rules, connecting lines, chart axis lines |
| `accent` (primary) | `#2E8B7E` deep teal-green | List square markers, divider-page outline, quote/label block background |
| `accent-wash` | `#DFF1EE` | Light background for label blocks |
| `info` (secondary) | `#5B9BD5` medium blue | Goal/conclusion banners, card headers, icon background |
| `info-wash` | `#E8F1FA` | Light fill for banners and card bodies |
| `highlight` | `#F2B90F` amber | "Current focus" highlight during progressive builds, key values, local background |
| `annotate` | `#8E5AA8` purple | Annotation bubbles, quotation-marker boxes |
| `danger` | `#C0504D` red | Negation, error paths, cancellation marks (used very sparingly) |
| `neutral-tag` | `#9AA5B1` | Secondary group bar (e.g. a "baseline/gap" group header) |

Rules: colored area per page ≤ 15%; the same semantic meaning stays the same color throughout the deck (e.g. "in progress/focus" is always amber); graying-out is the only way to express "past/irrelevant."

## 5. Page Skeleton (Masters)

1. **Cover page**: a title block at upper left (main title Bold + subtitle + one small line of byline/date); below, a full-width dark banner image occupying about 1/4 of the height (abstract texture, not a photo of people).
2. **Section divider page A (gray-text style)**: a large title centered-left, with non-keyword portions in light-gray Regular and keywords in black Bold, creating "light/dark contrast within one sentence."
3. **Section divider page B (outlined-frame style)**: a thin-lined rounded rectangle centered on the page (`accent` outline, no fill), with the section name centered inside in Bold; even whitespace above and below.
4. **Standard content page**: H1 at upper left; the body area carries a list/two columns/chart/table; a fixed footer at the bottom (see §9).
5. **Section summary page (Digest)**: H1 reads "Section Name - Digest"; the left side is a three-part structured list (Task / Method / Result, each with 2–4 square-marker sub-items), the right side has one method diagram + 1–2 source label blocks (`accent-wash` background + `accent` text + a small icon).
6. **Conclusion/closing page**: reuses the standard content page, with list items allowed to end with a back-reference mark such as "→ Goal number ✓" (circle + number + checkmark).
7. **Acknowledgments page**: purely text, centered, two lines (a main sentence + a secondary sentence), optionally paired with a simple symbol.
8. **References page**: H1 + a two-column or single-column dense numbered small-text list (×0.55 size), with no other decoration.
9. **Backup/appendix pages**: share the same skeleton as the main content, but the footer switches to simplified navigation (only 3–4 groups + a dot-progress indicator).

## 6. Reusable Layouts

- **L1 single-column list**: H1 + a multi-level square-marker list, up to three levels; level 1 uses a solid `accent` square, level 2 a small square or short dash of the same color, level 3 hollow/gray.
- **L2 two-column comparison**: two equal-width columns, with a Bold short phrase as the column header ("A looks for … / B looks for …" pattern), each column containing a short list; no divider line is drawn between them — grouping relies on spacing.
- **L3 centered pithy statement**: a bold statement line at the page's center (which may include a symbol like ⇒), with large whitespace above and below; used for transitional argument pages.
- **L4 banner card**: `info-wash` background + a solid `info` icon area on the left + a Bold label on the right + one line of explanation; rounded corners, thin border; used for statements that "need to be remembered," such as research goals or core conclusions.
- **L5 multi-column goal matrix**: a rounded `info` header bar at the top (with a gear-type icon on the left) → a `neutral-tag` group header below it (two groups: baseline / gap) → 4 equal-width columns, with column headers as rounded `info` chips (number + short name) and column bodies as `info-wash`-filled rounded rectangles; a vertical sidebar at the far left, embedding 4–6 line icons + vertically arranged category text. Matrix cells support three fill states: empty (yet to be discussed) / a ✓✗ comparison grid / numbered points + source labels.
- **L6 progressive-build page**: the same composition spans multiple consecutive pages, with each page adding only one change: ① a new element fades in; ② an existing element is emphasized with a `highlight` yellow frame/background; ③ non-focus elements are grayed out as a whole (`ink-muted`). The page must be designed as a composition stable enough that "adding one more layer still doesn't collapse it."
- **L7 text-left/image-right**: a structured list on the left, a line-art diagram on the right (document icons, connecting lines, label chips); the image occupies about 45% of the width.
- **L8 full-width table/figure**: H1 + a table or chart occupying 90% of the body area, with small-text footnotes immediately following.
- **L9 large comparison table**: a multi-row, multi-column metric comparison table + one line of small footnote text at the bottom explaining the measurement basis.

## 7. Chart / Table / Image / Component Rules

**Charts**
- Style: academic simple diagrams. Thin gray axis lines, no decorative tick marks, direct labeling; bars, lines, and scatter plots are all usable, with colors limited to `accent`, `info`, `highlight` + two shades of gray.
- Error bars and confidence intervals are expressed with thin lines; legends sit at the upper right or right side inside the chart, at ×0.6 size.
- When multiple subplots sit side by side, unify the axis range and font size; subplot labels use small (a)(b)(c) markers.
- Time/trend line charts may use multiple thin colored lines, but the same metric must use the same color across pages.

**Tables**
- A three-line-table variant: a medium-thin horizontal line at the top and bottom, a thin horizontal line below the header, with no vertical lines or only extremely faint vertical lines.
- Headers are Bold, numbers are right-aligned or aligned by decimal point; the best value may be Bold + colored with `accent`, but at most once per column.
- Table footnotes: a superscript letter/symbol + ×0.55 gray text, immediately following the table.

**Images and diagrams**
- Only two types are used: ① an abstract full-width banner (cover-only); ② a line-art diagram (document/pipeline/process). Photos, screenshots, and realistic illustrations are prohibited.
- Line-art diagram convention: thin black outlines, gray-scale fills simulating lines of text, small colored chips marking key positions; elements are connected by gray curved arrows, with arrows indicating direction only, not weight.
- Icons: a unified set of line icons (same stroke width, same corner radius), in two sizes (within lists / within cards), colored from `accent`/`info`/gray.

**Components**
- Square-marker list: a solid small square ■, in `accent` color, sized at about 0.45× the text height.
- Source/citation label block: a rounded rectangle, `accent-wash` background + `accent` text, with a small document icon on the left; 1–2 may appear side by side on the same page.
- Annotation bubble: a rounded rectangle + a pointer line, `annotate` outline, containing a handwriting-feel short sentence or formula fragment inside; used only for "in-text quote/parameter"-type annotations.
- Numbered back-reference: circled numbers (①②③) used for point numbering; goal back-references use "diamond/circle + number + ✓."
- Pipeline diagram: left-to-right flow, with stages represented by line-art blocks or cylinders (data sources) + rectangles (artifacts), stage numbers placed on gray rounded bars, arrows as solid gray lines.

## 8. Density and Spacing

- **Rhythm**: content pages have medium-to-high information density (1 central argument per page + ≤ 6 first-level points); insert one low-density divider or pithy-statement page every 8–15 pages as a breathing point.
- **Spacing system** (with body text size as 1u): title to body 1.5u; between list items 0.5u; between list groups 1u; chart to caption 0.75u; between columns 2u; footer to body 1.5u.
- **Progressive-page discipline**: each step of a step-by-step reveal changes only one thing; do not add a new element and gray out another within the same step.
- **Whitespace floor**: on any page, the bounding box of the body area's elements must not exceed 85% of the content area, and at least two corners must retain noticeable empty space.

## 9. Footer and Page Numbers

- **Main-thread footer (three parts)**:
  1. Top navigation row: all section names laid out horizontally (about 7–8 items), with the current section Bold near-black and the rest `ink-muted`; below each section name is a row of small dots representing that section's page count — discussed/current dots are solid (the current page's dot in `accent` or solid black), undiscussed dots are hollow.
  2. Lower left: a small `current page/total pages` label (e.g. `12/51` or as a fraction).
  3. Bottom row: a date (left) + a gray small-text byline row (speaker · report title, replaced with a generic placeholder when reusing).
- **Backup-page footer**: only 3–4 group names + a dot-progress indicator + page number, with no byline row.
- Divider page B and the acknowledgments page may omit the footer entirely; divider page A retains the footer to maintain a sense of position.
- Page numbers are numbered continuously throughout the deck (the backup section may either restart or continue the numbering, as long as the choice is applied consistently).

## 10. Prohibited Items

- Prohibited: any brand mark, institutional logo, real person's name/photo, the thesis's original title and body paragraphs, original charts and real experimental data, webpage/software screenshots, or original reference-list entries.
- Prohibited: gradient fills, drop shadows, 3D effects, decorative display type, textured backgrounds, full-bleed colored background pages.
- Prohibited: italics/underlines as emphasis, more than two colors emphasizing the same element simultaneously, sticker-style emoji graphics.
- Prohibited: vertical body text (only sidebar category labels may be set vertically), list nesting beyond three levels, more than one central argument per page.
- Prohibited: footer dots not matching the actual section page count, the same semantic color changing across pages, and jumpy positioning across progressive-build pages.

## 11. Delivery Checklist

- [ ] 16:9, white background; no brand, no people, no photos/screenshots, no original text/figures/data.
- [ ] Only one sans-serif family + one monospace font are used; font-size tiers match the §3 table.
- [ ] All colors come from the §4 tokens; colored area per page ≤ 15%; the same semantic meaning uses the same color.
- [ ] All eight reusable skeletons — cover, the two divider-page types, standard content page, Digest page, conclusion page, acknowledgments page, references page, backup page — are present and reusable.
- [ ] At least one example each of layouts L1–L9; progressive-build pages change only one thing per step and keep a stable composition.
- [ ] Tables follow the three-line-table style with complete footnotes; chart colors are compliant, with the same metric using the same color across pages.
- [ ] The footer's navigation section names + dot progress match the actual state; page numbers are continuous; the backup section's footer is the simplified version.
- [ ] The four component types — square-marker lists, source label blocks, annotation bubbles, numbered back-references — are styled consistently throughout the deck.
- [ ] A low-density breathing page appears every 8–15 pages; the body area occupies ≤ 85%.
- [ ] The whole document is UTF-8; placeholder text uses generic research narrative (goal/gap/task/method/result/limitation) with no identifiable source information.

- No cards by default: unless the user explicitly requests it, it is strictly forbidden to use rounded rectangles or rectangular cards to build hierarchy or alignment: lines, whitespace, and font-size differences are the superior solution
- No evenly-divided composition: unless there is no other usable layout, do not default to three-way splits, four-way splits, or 2×2 matrices. This includes three-part conclusions such as three-column + title + conclusion
