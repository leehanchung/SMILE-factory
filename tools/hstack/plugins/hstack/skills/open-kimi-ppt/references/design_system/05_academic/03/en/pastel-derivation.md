# Pastel Academic Derivation Deck Design System

A brand-free design system for math/ML-style deep-dive tutorials: pastel-gradient section covers + white-background derivation content pages, with "contour probability plots + formula cards + progressive reveal" as the core narrative device. This system abstracts only the visual style and pacing of explanation, and contains no brand, person, original text, or original chart.

## 1. Visual DNA

- **Two page skins**: ceremonial pages (cover, agenda, section dividers, back cover) use a diagonal pastel gradient; content pages use a near-white solid color, with high information density but generous whitespace.
- **Warm-toned figure area**: all probability/geometry diagrams sit on a uniform warm off-white (peach) canvas block, with orange-to-deep-red heat contour lines representing density — a recurring visual anchor throughout the deck.
- **The formula is the protagonist**: a large serif italic formula, centered or occupying its own line, carried by a pale blue-gray rounded "formula card"; within body text, key terms are colored blue (process/link), magenta (warning/key point), or teal (condition/input) rather than piled up with bold.
- **Progressive reveal (build-up)**: the same title is reused across consecutive pages, adding elements frame by frame and fading in the next conclusion; the pacing is one concept per page, breaking the derivation down as slowly as possible.
- **Rounded-pill components**: definitions, theorems, goals, and caveats are all placed inside rounded rectangles/pill bars, in a two-part "label + content" structure.
- **Annotation arrows**: thin blue/magenta arrows with text labels point to a specific term in a formula or a region of a diagram, replacing parenthetical notes.
- **Small-print footnotes**: a line of extremely small gray text at the bottom of the page carries sources/supplementary notes; body text never cites a reference number.

## 2. Canvas and Grid

- Aspect ratio: 16:9, recommended 1280×720 pt (or 33.87×19.05 cm).
- Safe margins: 48 pt left/right, 40 pt top/bottom; the footer band sits 12 pt above the bottom edge.
- Content grid: 12 columns, 16 pt column gap; common placements are 4+8 (text left, image right), 6+6 (two-column comparison), 3×4 (three-card row), and full-width (single image/single formula).
- Title anchor: upper-left corner, x=48, y=40, title block 72 pt tall, with the content area starting 24 pt below it; the content area's bottom ends at y=640, leaving room for the footnote below.
- Figure-area alignment: all diagram canvas blocks use a unified set of width/height sizes (e.g. 320×240 / 480×360 / full-width 600×420); sizes are not mixed within the same section.

## 3. Font Hierarchy

| Tier | Font | Size | Color | Purpose |
| --- | --- | --- | --- | --- |
| H1 cover/divider title | Sans-serif (e.g. Inter/Helvetica Neue) Medium | 40–48 | Ink black | Main title, section name |
| Section number | Sans-serif Light | 40 | Ink black 70% | Large "01"-style numbering |
| H2 content-page title | Sans-serif Medium | 28–32 | Ink black | Each page's upper-left title |
| Subtitle/pill small title | Sans-serif Medium | 14–16 | Primary blue or ink black 70% | Card labels |
| Body/bullets | Sans-serif Regular | 16–18 | Ink black 85% | Lists, explanations |
| Formulas | Serif italic (CMR/Times family) | 18–28 (protagonist formulas larger) | Ink black, key terms colored | Derivations, theorems |
| Colored keywords | Same as body | Same as body | Blue/magenta/teal | Inline emphasis, replacing underlines |
| Figure captions/footnotes/sources | Sans-serif Italic | 9–11 | Gray 60% | Footer line, figure captions |
| Table text | Sans-serif | 12–14 | Ink black 85% | Comparison tables, data tables |

## 4. Color Tokens

- `--ink` `#1F1F24` (primary text); `--ink-70` `#5A5A63`; `--muted` `#8A8A94` (footnotes/captions).
- Primary accents: `--blue` `#2E6FD6` (process, link, "generate/derive" semantics); `--magenta` `#C8366E` (warning, caveat, key assumption); `--teal` `#0E8A8F` (condition, input, example label).
- Ceremonial gradient color (diagonal 135°, four equidistant stops): `#F7D3E4` (pink) → `#E3DCF7` (lavender) → `#CDE4F6` (sky blue) → `#D7F2E6` (mint). Used as a full-bleed base only on ceremonial pages; prohibited on content pages.
- Figure-area base: `--peach` `#FCEFD9`; density heatmap: `#F2A65A` → `#E0743C` → `#B23A30` (light orange to deep red, 4–6 contour tiers, 0.75–1 pt line width, with a darker outline of the same hue).
- Component background: `--pill` `#EDF2F9` (pale blue-gray info card); `--note` `#FFF7CC` (pale yellow tip bar); `--caveat-bg` `#F3EEF1` (warning-bar background).
- Structural gray: divider lines `#D8D8DE`, table alternating-row background `#F5F6F8`.
- No more than 3 color tokens are used as emphasis on a single page; text coloring follows the fixed semantics of "blue = process/reference, magenta = limitation/problem, teal = condition/example."

## 5. Page Skeleton

1. **Cover**: gradient background; main title + one subtitle line at center-left; a QR-code slot at lower right (replace with your own link or remove when reusing); an info bar at the bottom (institution/date/license-icon slot).
2. **Agenda page**: gradient background; "H1 Agenda" on the left, vertical entries on the right in the form `[Duration] NN Section Name`, with the number in primary blue and the duration in muted gray.
3. **Section divider page**: gradient background; a large number (01/02/…) on the left in the same row as the section name; an optional QR-code slot on the right.
4. **Content derivation page**: white background; H2 title at upper left; content area placed per the grid; a footnote line at the bottom.
5. **Topic-switch page (progress-bar style)**: white background; 2–3 rounded thumbnail cards in a row, the current topic in normal color and the rest grayed to 30%, previewing/reviewing the section structure.
6. **References page**: white background; grouped subheadings + two groups of pale blue-gray rounded cards, each card containing a small italic citation list.
7. **Back cover**: gradient background; a large centered rounded functional card (a list of supported capabilities + a repository/link QR-code slot).

## 6. Reusable Layouts

- **L1 concept diagram**: 5 columns of text on the left (definition + bullet list, dot markers), 7 columns of peach figure canvas on the right; an optional line of small teal annotation below the figure.
- **L2 formula protagonist**: a full-width centered formula (serif, 24–28), a pill-shaped conclusion line above, and a pale blue-gray card below stating "conditions for validity/equivalent relations"; within the formula, different terms are colored blue/magenta with arrow labels attached.
- **L3 two-column comparison**: two side-by-side rounded gray cards, each containing a small thumbnail + 3–4 lines of bullet points (one column of "simple/fast/precise"-type advantages, one column of "large design space/slow"-type costs), with a shared symbol optionally sandwiched between them.
- **L4 three-topic navigation**: three thumbnail cards in a row with the current one highlighted (used for switching between sub-sections within a chapter).
- **L5 pipeline flow**: a horizontal 3–4 step process, with thick arrows between steps labeled with the action name above (e.g. "Data → Path design → Training → Sampling"), optionally with a loop-back arrow indicating iteration.
- **L6 sample grid**: an N×M array of result thumbnails (each cell the same size, 4 pt rounded corners), with small colored labels on the left or above marking conditions/step counts; for placeholder purposes only — real generated results must not be placed here.
- **L7 theorem + derivation, two rows**: a "Theorem" pill in the top row (pale blue background), a large formula card in the bottom row, with a peach figure on the right providing geometric intuition.
- **L8 problem list**: a pill-shaped small title (all-caps, muted gray) + 2–4 question-sentence body lines + a "design choice" sticky-note card at the lower right (pale blue background, pinned-corner shadow).

## 7. Chart / Table / Image / Component Rules

- **Charts**: line charts use 2–4 colors (primary blue, orange, green, gray), 2 pt line width with rounded end dots; axis labels use 10–11 pt gray text; omit tick marks and enclosing axis frames, retaining only pale-gray horizontal gridlines; the legend sits at the upper right or inside the chart. Bar charts use a single color or a two-color scheme, with 2 pt rounded bar corners and values optionally labeled on top. All axis labels must be present, using placeholder names.
- **Tables**: thin gray lines or no vertical lines, with alternating-row light backgrounds; the header may use colored background blocks (blue/magenta/teal each representing one method category); numeric values are centered, method-name columns are left-aligned; do not mix alignment styles within the same column.
- **Images**: always 4 pt rounded corners; a 9–10 pt italic gray caption below the image (source/conditions); multiple images are aligned to the grid with equal width and height; screenshots must not be placed directly on the page (they must be redrawn or replaced with self-produced placeholder images).
- **Rounded info cards**: 8–12 pt corner radius, 16×12 pt padding, a two-part structure of "small title (colored, 14 pt) + content"; a single-line pill bar uses a corner radius of half its height.
- **Bullet markers**: small dots (solid, primary color or gray), with only one nesting level allowed; points ≤ 4 lines, each line ≤ 12 words.
- **Warning/conclusion bars**: `Caveat` (magenta small title + gray-background card), `Open Problem` (magenta title + a centered question line), `Goal:` (teal pill + formula/short phrase).
- **Arrow annotations**: 1.5 pt line + solid triangular arrowhead; blue labels "process/average," magenta labels "limitation/dependency," with 12–14 pt text in the matching color.

## 8. Density and Spacing

- One central idea per page: 1 figure + ≤ 1 main formula + ≤ 4 lines of bullet points; exceeding this means splitting the page (prefer a build-up continuation page instead).
- Element spacing: title → content 24 pt; card → card 16–20 pt; figure → caption 8 pt; formula-card padding ≥ 16 pt; footer-line-to-content distance ≥ 20 pt.
- Within the same build-up series (same title across pages), every previously shown element stays pixel-for-pixel unmoved, with only incremental additions; new elements must fade in at a grid intersection point.
- White pages (transition pages with only a title + one sentence) are allowed, but at most 1 per section.

## 9. Footer and Page Numbers

- Footer: starting 12 pt above the bottom edge and 48 pt from the left, 9–10 pt italic gray text, containing a source/supplementary-note placeholder (replace with your own citation when reusing); multiple sources stack on new lines, and right-alignment is also acceptable.
- Page number: not displayed by default; if needed, 10 pt muted gray at the lower right, in the format `NN` (no prefix).
- Section pages and the cover/back cover carry no footer or page number.

## 10. Prohibited Items

- Do not copy any brand mark, institutional logo, conference name, or speaker name/avatar/photo from a source deck.
- Do not copy original sentences, original formula typesetting, original figures (contour plots, sample grids, loss curves, comparison-table data), or real experimental values; charts may retain only their type and color rules — data must be recreated as placeholder values.
- Do not reuse QR codes, external links, or citation entries as-is; link and citation slots should be presented as placeholder cards.
- Do not mix photographic/realistic-style illustrations into the diagram system; diagrams stay vector-flat + peach background.
- Do not use dark/pure-black background pages, gradient content pages, 3D-realistic charts, or overly heavy card shadows.
- Do not exceed 3 accent colors on a single page, nest bullet levels beyond 1 level, or use a serif font for content-page body text (serif is reserved for formulas only).

## 11. Delivery Checklist

- [ ] 16:9 canvas; 48 pt left/right and 40 pt top/bottom safe margins observed throughout.
- [ ] Ceremonial pages (cover/agenda/divider/back cover) use the four-stop pastel gradient; content pages use a near-white solid color, with the two skins never mixed.
- [ ] All 9 tiers of the font hierarchy table are present: H1, section number, H2, pill title, body, formula, inline coloring, footnote, table text.
- [ ] All colors come from the tokens; the blue/magenta/teal semantics are fixed (process/warning/condition); accent colors per page ≤ 3.
- [ ] All diagrams use a unified peach canvas block + orange-red contour-line language, with a consistent size series.
- [ ] Formulas use serif italics, with protagonist formulas occupying their own card; arrow annotations replace parenthetical notes.
- [ ] The eight layouts (L1–L8) can cover all pages; build-up continuation pages have zero displacement of existing elements.
- [ ] Charts/tables/images follow the rules in Section 7; no real data, screenshots, or photos of any kind.
- [ ] Footer uses 9–10 pt italic gray placeholder citations; page numbers follow Section 9; ceremonial pages have no footer or page number.
- [ ] The entire document contains no brand, no person's name/avatar, and no original text/figures/data; links/QR codes are placeholders.
- [ ] The file is UTF-8; this file's first non-empty line is a level-1 heading.

- No cards by default: unless the user explicitly requests it, it is strictly forbidden to use rounded rectangles or rectangular cards to build hierarchy or alignment: lines, whitespace, and font-size differences are the superior solution
- No evenly-divided composition: unless there is no other usable layout, do not default to three-way splits, four-way splits, or 2×2 matrices. This includes three-part conclusions such as three-column + title + conclusion
