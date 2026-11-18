# Design System: Consumer Trend Monitor · Landscape Presentation Edition

> Reverse-engineered from: the real visual evidence of a 36-page portrait (US Letter 612×792) investment-monitoring quarterly (cover + page-by-page images of all 35 pages).
> This system keeps only its **visual methodology** — newspaper-style grids, serif headlines mixed with data charts, a teal/amber/crimson chart language, and paper-beige footers —
> it does not copy any third-party logo, brand name, trademark, or source text; per the task requirements, the portrait report grammar is converted into a 16:9 landscape presentation system.
> Any value that cannot be confirmed precisely from pixel evidence is marked "approximate."

---

## 1. Visual DNA (One Sentence)

**A financial-newspaper-style data-monitoring report**: a restrained black-on-white layout + large serif headlines + dense column-line combination charts + a deep-sea-blue cover and beige footers; the overall temperament is a "trustworthy industry dashboard," not a marketing poster.

Four executable principles:
1. **Conclusions spoken in italic serif, evidence given by charts** — every information block is a pairing of "italic serif conclusion sentence + chart/body text."
2. **Charts are the protagonists**: page area goes to charts first; text is the charts' annotation.
3. **Color only encodes, never decorates**: teal = primary series, dark teal = secondary series, amber/yellow = comparison lines, crimson = warning or second theme, beige appears only in the footer and separator bands.
4. **Dense but not crowded**: small type, multiple columns, tight leading — but with clear whitespace between modules.

---

## 2. Canvas and Grid (16:9 Landscape Conversion)

| Item | Value | Note |
|---|---|---|
| Canvas | 960 × 540 px | 16:9 presentation standard |
| Left/right margins | 44 px | Source portrait margins ≈ 7% of page width, carried into landscape (approximate) |
| Content area | y = 20 ~ 508 | Above the beige footer band |
| Footer band | y = 512 ~ 540 (28 high) | Beige horizontal band, see §9 |
| Column system | 12-column mental grid, commonly split into 2 / 3 columns; gutter 24 px | Source body uses a fixed 3 narrow-column layout |
| Baseline rhythm | multiples of 4 px | All spacing takes multiples of 4 (approximate) |

Portrait → landscape conversion rules:
- Source "full-page large image + three-column body below" → landscape becomes "left 60% chart + right 40% text column" or "chart on top, text below, chart spanning the full width."
- Source 2×2 chart-matrix pages (vertically arranged) → landscape becomes a natural 2×2 grid — a native fit.
- The source's only landscape page (regional map + stacked bars on both sides) proves this system supports landscape; align density to that page.

---

## 3. Font Hierarchy

Map Chinese fonts as follows (font names must exactly match the library):

| Role | Font | Size / style | Usage | Evidence |
|---|---|---|---|---|
| Display serif | `{latin: Oranienbaum, ea: 思源宋体}`, bold | cover 40~48 / page title 26~28 | Cover main title, each page's large headline | Source titles are Georgia-type bold serif (approximate mapping) |
| Conclusion line / chart title | same as above, italic + bold | 14~15 | Each page's conclusion line, each chart's italic title | Source chart titles are italic serif (approximate) |
| Sans-serif body (Sans) | `MiSans` | 10~10.5, line height 1.45~1.5 | Multi-column body, legends, axis labels | Source body ≈ 9px sans-serif in three columns (approximate) |
| Eyebrow | `MiSans`, letterSpacing 2~3 | 9~10, all-caps feel replaced with bold | Column identifier above the page title | Source "DEALS BY SECTOR"-style small-type eyebrows |
| Data labels | `MiSans` bold | 9~10 | Values inside columns / on lines | Source white bold values inside columns |
| Big numbers (Stat) | display serif bold or MiSans bold | 28~36 | Key metric cards | Source back-cover and inner-page big-number treatment (approximate) |
| Footer / source note | `MiSans` | 8~9, gray | Footer-band text, under-chart source notes | Source footer's small uppercase gray type |

Rules:
- Within one page, serif is used only for "titles + conclusion lines + chart titles"; body text and chart annotations are always sans-serif.
- No fonts beyond the two families above; no calligraphic/handwritten faces.

---

## 4. Color Tokens (Hex; all are pixel-sampled approximations)

| Token | HEX | Role | Sampling basis |
|---|---|---|---|
| `ink` deep sea blue | `#06223F` | Cover/section-page base, table headers, darkest chart series, emphasis text | Cover base #051C38, header #2C4057, darkest map state #001830 |
| `ink-soft` | `#14324F` | Deep-blue auxiliary (cards, secondary headers) | approximate |
| `teal` | `#2FBFC4` | Primary-series column color, main line, emphasis icons | Main-chart columns #30C0C0~#3CC0C0 |
| `teal-dark` dark teal | `#1B6E72` | Secondary-series columns, second stacked segment | Dark-teal columns #186C6C~#246C78 |
| `teal-pale` light teal | `#BFE5E6` | Lightest stacked segment, light area-chart layer, chart background blocks | Light-teal segment #C0E4E4 |
| `amber` | `#D9A62E` | Comparison line (the "line" in column-line combos), growth-rate annotations | Gold line #CCA80C~#E4C09C |
| `yellow` bright yellow | `#DCC83C` | Single-series yellow columns (industry-page primary color), stacked segments | Yellow columns #D6D470~#CCA80C |
| `orange` | `#E5862E` | Third-theme column color, stacked segments | Orange columns #E48430 |
| `crimson` | `#76101A` | Warning / second-theme column color, dark stacked segments | Deep-red columns #6C0000~#780C0C |
| `salmon` | `#F0A89A` | Middle stacked segment (between crimson and light teal) | Pink-segment sample #FEF1EE brightened estimate (approximate) |
| `slate` slate blue | `#5E84A0` | Map/chart mid-tones, auxiliary lines | Mid-tone map state #60849C |
| `paper` paper white | `#FFFFFF` | Content-page base | — |
| `beige` | `#EDE7D6` | Footer band, horizontal separator bands, note-box fills | Footer band #EFEBDE |
| `beige-line` | `#D8D2C2` | Top edge of beige band, thin table lines | Band edge #D2D1C9 |
| `text` body ink | `#262626` | Body text | approximate |
| `muted` gray | `#8A8A8A` | Axis labels, legends, source notes, footer text | approximate |
| `grid` grid gray | `#E7E7E7` | Table outer frames, thin dividers | approximate |

Contrast floor: on `ink`, only white/light-teal text; data labels on deep `teal`/`crimson`/`orange` columns are white or placed above the column in dark gray; on the beige band, only text at `#6B6B6B` depth or darker.

---

## 5. Page Skeleton (Common to Content Pages)

```
┌─────────────────────────────────────────────────────────────────────┐
│ ▪ wordmark "Specialty Coffee Consumption Monitor"                    │  ← header row y≈20~44
│ version at right: 2026 Annual Insights · sample setting               │
│                                                                      │
│ Eyebrow (9px, wide letter spacing, gray)                             │  ← y≈56
│ Serif display headline 26~28px                                       │  ← y≈74~104
│ Italic serif conclusion line 14px (the page's only conclusion)       │  ← directly under the title
│                                                                      │
│ ┌────────────────── content area y≈130~486 ────────────────────────┐ │
│ │  chart / multi-column body / table / cards (choose layout per §6) │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                page number (centered, 9px serif gray)                │  ← y≈496
│ ▔▔▔▔▔▔▔▔▔▔ beige footer band: report name centered 9px ▔▔▔▔▔▔▔▔▔▔ │  ← y≈512~540
└─────────────────────────────────────────────────────────────────────┘
```

- Header left wordmark: a solid teal small square (10×10) + the bold sans-serif report name; on the right, a small gray version identifier. **Any real brand logo is forbidden.**
- The page number is centered just above the beige band (source style); the footer band holds the centered full report name in small type.

---

## 6. Reusable Layouts (8)

1. **Cover (deep sea blue)**: full-bleed `ink` base + concentric thin arcs/thin-line signal pattern on the right (low-opacity blue-gray elliptical strokes, entirely within the canvas) + large serif headline (may mix italic and roman) + one line of version info + a bottom key-numbers band (3 stats, teal/white text).
2. **Conclusion page (cover variant)**: same skeleton as the cover, but the headline is the page's conclusion sentence, with 3~4 data stat bands below as evidence.
3. **Large chart + text column**: left 55~60% holds one column-line combination chart (with italic chart title + legend + source note); right 40% holds one body-text column + one stat card or small chart.
4. **Full-width chart + three-column body**: a full-width combo chart on top (occupying 45~50% of the height), three columns of 10px body text below, each column optionally opening with a bold lead-in sentence.
5. **2×2 chart matrix**: one small chart per quadrant, each with "italic serif chart title + small-type subtitle + chart + source note," with 24px whitespace between quadrants.
6. **Horizontal bars + right stat track**: left 60% a horizontal-bar ranking chart; right 40% a vertical stack of 2~3 stat cards (beige or light-teal fills, large serif numbers + small-type notes).
7. **Comparison paired columns + interpretation column**: left-of-center comparison chart with 2~4 large columns (values labeled above and outside the columns), one interpretation-text column on the right + one "x-fold difference" arrow annotation.
8. **Table page / card page**: a dark-teal-header white-text table (see §7) or 2~3 equal-width action cards (card = light-teal top bar + serif subtitle + sans-serif body + bottom data-anchor chip).

---

## 7. Chart and Table Language

### Charts in general
- Chart title: italic serif bold 14px `ink`, left-aligned; the line below is a 9px gray subtitle (metric basis).
- Axes: no y-axis gridlines (`gridLine: false`), no axis lines or only a thin `#E7E7E7` baseline; axis labels 9px `muted`; currency axes carry unit abbreviations.
- Legend: horizontal below the chart, small color swatches + 9px gray text.
- Source note: 8px gray text at the chart's lower right — "China Specialty Coffee Consumption Trend Monitor · sample data (internal estimates)."
- Value labels: 9~10px; column-series labels preferably white bold inside the column, or dark gray above the column when they do not fit (if the renderer does not support position control, place them uniformly above and outside, treated as an approximation of the source).
- Line-series labels sit above the endpoints, in `muted` gray.

### Chart-type recipes (ordered by evidence frequency)
1. **Column-line combination (this system's signature chart)**: solid columns (one of `teal` / `crimson` / `orange` / `yellow`) + a contrasting thin line (`amber` or `teal`), dual axes; columns labeled with amounts, the line labeled with counts/ratios.
2. **Multi-line**: 4~5 thin lines of 1.5~2px, color order `ink`→`teal`→`amber`→`crimson`→`slate`, with endpoint values labeled directly at the right ends.
3. **100% stacked bars**: segment colors per theme from `teal`/`teal-pale`/`salmon`/`crimson` or `teal`/`teal-dark`/`ink`, with white % text inside segments.
4. **Horizontal-bar ranking**: single color family (`teal` or `ink`), values labeled at bar ends, category axis on the left.
5. **Layered area**: `ink`→`teal-dark`→`teal`→`yellow` bottom to top, used only for "stock accumulation" semantics.
6. **Comparison paired columns**: two same-family columns in dark and light, with a "x-fold difference" arrow and text between them.

### Tables
- Header: `ink` background, white bold 9~10px text, left-aligned (numeric columns right-aligned).
- Data rows: white background, only a `#E7E7E7` 0.75~1px baseline between rows, no vertical lines, no zebra striping (source tables have no zebra striping).
- Row height 22~26px, cell padding 8px left and right.
- Tables also get a source note below.

---

## 8. Image Cropping and Graphic Components

- **Images**: only covers/section pages may use full-frame images, always `fit: cover` full-bleed cropping; portrait images in landscape take only the middle band (`crop: {top, bottom}` trimming 15~25% each); content pages use no photos — charts and graphic components substitute. Source portraits are right-column small squares (about 120×150) + a gray-text bio; use a same-spec placeholder only when genuinely needed.
- **Signal pattern (cover decoration)**: 3~4 concentric elliptical thin strokes (`slate`/`teal`, opacity 0.15~0.3), all bounds within the canvas; or one 2px teal "pulse" polyline.
- **Stat cards**: `teal-pale` or `beige` fill (no stroke, no shadow), large serif `ink` number + 9px gray note; on deep-blue pages switch to a transparent fill + teal big numbers.
- **Action cards**: white base + a 4px `teal` solid top bar + serif subtitle + 10px body + bottom data chip (`beige`-filled rounded small type).
- **Icons**: only Font Awesome free solid (`fas:`), single color `teal` or `ink`, 16~20px, no mixed styles.
- **Separation**: always a 1px `#E7E7E7` thin line or whitespace; no shadows, no gradient blocks (except the cover signal pattern).

---

## 9. Density, Spacing, and Footers

- Information density aligns with the source: 1 conclusion + 1~2 charts + no more than 3 columns of body text per page; body 10px, line height 1.45, paragraph spacing 6~8px.
- Module spacing: title area → content area 20~24px; chart-matrix quadrants 24px apart; cards 16~20px apart.
- Footer: a beige band (`beige`, 28px high) spans the full width, holding the centered 9px `muted` report name "China Specialty Coffee Consumption Trend Monitor · 2026"; the page number is 9px serif gray centered 6px above the band.
- The lower-right chart note on every page uses the unified §7 source-note phrasing.

---

## 10. Do-Nots

1. No third-party logos, brand names, sponsor marks, trademarks, or source-manuscript original text.
2. No pie/donut charts for share rankings (the source has no pie charts at all); shares always use 100% stacked bars or horizontal bars.
3. No shadows, gradient fill blocks, frosted glass, 3D charts, or animation-flavored chart decoration.
4. No cards with corner radius greater than 8px; chart columns stay right-angled.
5. No text pressed over images, and no chart elements bleeding outside the canvas (all bounds must stay within 960×540).
6. No large-area beige fill in body areas outside the beige footer band; beige is only a "band," never a "block."
7. No fabricated numbers: all values must come from the task query; qualitative judgments must be marked "internal judgment."
---

## 11. Pre-Delivery Checklist

- [ ] Every page has one and only one explicit conclusion, presented as an italic serif sentence directly under the title.
- [ ] The 6 pages form a complete narrative: conclusion → market structure → consumer segmentation → channel and membership economics → opportunity map → action recommendations.
- [ ] Every number can be traced one-to-one to query.md; nothing fabricated, no external data.
- [ ] All colors come from the §4 tokens; chart coloring follows the §7 recipes; no gradients/shadows.
- [ ] Only two font families: serif `{Oranienbaum, 思源宋体}` and sans-serif `MiSans`; sizes follow §3.
- [ ] The header wordmark, beige footer band + page number, and under-chart source notes are present on every page at consistent positions.
- [ ] `kimi-ppt check` reports no errors; page-by-page screenshots show no overlap, no cropping, no overflow, no unexpected line wraps; dark-background white-text contrast passes.
- [ ] Final directory: `deck.pptx` (the only PPTX) + the complete PPTD bundle + `final-screenshots/pages/1.jpg~6.jpg`.

- No default use of cards: unless the user explicitly requests it, it is strictly forbidden to use rounded rectangles or rectangular cards to build hierarchy or alignment — line segments, whitespace, and font and font-size differences are better solutions.
- No equal-division composition: unless no other layout is available, do not default to three-way splits, four-way splits, or 2×2 matrices — including three-part structures such as three-way split + title + conclusion.
