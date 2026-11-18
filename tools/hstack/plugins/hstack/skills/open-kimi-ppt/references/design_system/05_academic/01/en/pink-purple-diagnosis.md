# Soft Cloud-Layer Diagnostic Narrative · PPT Design System (brand-free, reusable version)

This document is reverse-engineered from a 32-page technical talk source deck, retaining only the visual language and narrative method for reuse in any technical-proposal-style presentation. The full text contains no third-party logos, brand names, people, product screenshots, source-deck body text, or original data; any value that could not be precisely sampled is marked "approximate."

Applicable scenarios: performance diagnostics, monitoring proposals, technical methodology talks — narrative-style presentations that follow "pose the problem → establish metrics → give the method → show evidence → close the loop."

## Visual DNA

- Primary tone: **white background + bold dark-blue titles + a single accent color bar**. Pages have abundant whitespace, low-to-medium information density, one point per page.
- Character keywords: clean, restrained, soft, engineering-feel. All decoration serves the narrative — decoration is never added for its own sake.
- Two cover moods:
  - The opening cover uses a **soft pink-purple cloud-layer gradient** (approximately `#F7CDD8` → `#DCC8F2`), creating a light, friendly first impression.
  - The closing page uses a **deep-purple gradient** (approximately `#3A1D6E` → `#5C40A8`) with large white text, closing out the whole talk.
- Recurring identity element: a **short, thick underline** below and to the left of the title (about the width of the title's first word, about 4–6px tall), whose color switches with the current section's theme color (a yellow-green or bright-yellow family). This is the entire deck's only "brand anchor" and may be replaced with any theme color.
- On-page emphasis relies on **font weight and bolded keywords**, occasionally seasoned with a single emoji (at most one per page); icon-stacking is not used.

## Canvas and Grid

- Aspect ratio: **16:9** (1280×720 or equivalent), landscape projection preferred.
- Safe margins (approximate): about 5% on left and right each (≈64px @1280), about 6% at the top, about 8% at the bottom (footer zone).
- Grid: an implicit 12-column grid. Body text defaults to a left-aligned single column, occupying the left 7–8 columns; image-text pages commonly use a "text left, image right" 7:5 split, or a centered large image spanning 10 columns.
- Baseline rule: titles consistently start from the same y-coordinate (approximately 8–10% from the top); the body's starting point is consistently about 48–64px below the title underline, with no drift across the deck.
- Bottom diagonal color band: some section pages place a **large-angle diagonal color band** at the bottom edge or lower right (height about 15–25% of the canvas, diagonal angle about 5–10°) as a visual signal for section separation; content pages usually stay pure white.

## Font Hierarchy

Font family: Liter (English) and MiSans (Chinese), approximating a system sans-serif; use JetBrains Mono (via customFonts) for code and other monospace needs. Do not use serif or other decorative fonts.

| Tier | Purpose | Font size (approximate, 1280-width baseline) | Weight | Color |
|---|---|---|---|---|
| H1 page title | The single title per page | 34–40px | Bold | Deep-blue ink |
| Cover main title | Opening cover | 40–48px | Bold | Deep purple |
| Cover subtitle | Byline/date line | 20–24px | Italic/Regular | Deep purple (lighter) |
| Subheading/definition question | "What is X?"-style lead-in sentence | 18–22px | Bold | Deep-blue ink |
| Body/list | Points, paragraphs | 16–18px | Regular, keywords Bold | Dark gray |
| Annotation/footer | Copyright, source, small print | 10–12px | Regular | Medium gray |

Rules:
- Titles are mostly **questions or assertive statements** (e.g., "What are our goals?", "Context is everything"), advancing the narrative directly through the title.
- Body emphasis uses inline Bold, not color changes or underlines.
- Definition pages follow a fixed sentence pattern: a subheading question + a definition paragraph (keywords bolded) + one "goal sentence" summarizing the experience goal that metric corresponds to.

## Color Tokens

The following are reverse-sampled approximate values; fine-tune on implementation, but maintain the relationship of "a low-saturation base color + one high-saturation accent color."

- `--ink` (titles/emphasized text): deep-blue ink, approximately `#1C2B4A`
- `--body` (body text): dark gray, approximately `#333A45`
- `--muted` (annotations/footer): medium gray, approximately `#8A93A0`
- `--paper` (base color): pure white `#FFFFFF`
- `--accent-lime` (theme accent A, green-family sections): approximately `#8CC63F`, used for title underlines, diagonal color bands, and loop diagrams
- `--accent-yellow` (theme accent B, yellow-family sections): approximately `#F2A900`, used for title underlines, diagonal color bands, and task bars
- `--cover-gradient`: pink `#F7CDD8` → pale purple `#DCC8F2` (cover cloud-layer base)
- `--end-gradient`: deep purple `#3A1D6E` → purple `#5C40A8` (closing-page base)
- `--purple-title` (cover title): approximately `#6E2E7E`
- Three-state status colors (rating/threshold legend, approximate): `--ok` `#3FBF6F`, `--warn` `#F5C400`, `--bad` `#F05A5A`
- Timeline bar colors (approximate): task segment `--task` `#F5D76E`, event segment `--event` `#B98FE0`

Usage constraint: each page has **one and only one** accent color (green-family or yellow-family, determined by the section); the three-state status colors appear only grouped within rating legends and are not mixed with the section accent color for decoration.

## Page Skeleton

The whole deck is organized around a "diagnostic narrative arc," with a reusable skeleton sequence:

1. **Cover**: gradient cloud-layer base + left-aligned main title/subtitle, with a slot at the upper right for an event or institution mark (leave blank when reusing, or place your own mark).
2. **Quote page**: pure white background, an oversized quotation-mark character (theme color) + a quote paragraph + an em-dash byline, with a diagonal color band at the bottom. Used to establish thematic authority.
3. **Goals page**: a question-style title + a bullet list of up to 4 items, answering "what are we pursuing."
4. **Section title page**: pure white or with a diagonal color band, a large short-phrase title (e.g., "Common metrics"), serving as a section divider.
5. **Metric definition pages** (repeated in groups, 1–3 pages per metric):
   - Definition page: a question-style subheading + a bolded-keyword definition + a goal sentence.
   - Problem page: a "Some issues with X"-style list of limitations.
   - Calculation/measurement page: a formula or diagram + a wireframe illustration such as a phone outline.
6. **Method turning-point page**: a large-text question (e.g., "So… what should we measure?") + one witty answer line, picking up from the first half's setup.
7. **Context/method page**: a checklist-style question ("Do we care about…?"), pulling absolute metrics back to a concrete scenario.
8. **Implementation page**: text-left/code-right, full-width code, or a step list, explaining the means of implementation.
9. **Evidence page**: a timeline diagram, Before/After comparison, or rating bar, presenting the measurement results.
10. **Closed-loop page**: a loop diagram (Measure → Analyze → Improve), making the point of a "continuous process."
11. **Recap page**: a "Recap" summary of 5–6 bolded-keyword points.
12. **Closing page**: deep-purple gradient + large white "Questions?"-style text.

## Reusable Layouts

- **L1 pure list page**: title + underline + bullet list (≤6 items, each within one and a half lines). Applicable to: goals, limitations, summaries.
- **L2 text-left/image-right page**: 40% text on the left (definition/list), 60% large image or diagram on the right. Applicable to: concept explained with an illustrative screenshot-style diagram, code explanation.
- **L3 centered large-image page**: title on top, a centered image below spanning 60–80% of the width (timeline diagram, waterfall chart, curve chart). Applicable to: evidence presentation.
- **L4 comparison page**: two groups of matching wireframe diagrams (e.g., phone wireframes, task bars) arranged left-right or top-bottom, connected by a middle arrow, labeled Before / After. Applicable to: before/after optimization, two alternative solutions.
- **L5 formula page**: title + a centered formula line + an illustrative example below + one line of calculation result. Applicable to: metric algorithms.
- **L6 quote/question page**: a single large-text sentence, centered or left-offset, paired with a theme-color symbol (quotation mark, ellipsis). Applicable to: transitions and tone-setting.
- **L7 code page**: title + a dark rounded-corner code block (positioned right or full-width), with 2–4 lines of explanation on the left. Syntax highlighting within the code block uses a soft color scheme, not a pure-black background (approximately deep charcoal-gray `#2B2F38`).
- **L8 loop-diagram page**: a centered ring/loop-arrow diagram (3 nodes: Measure, Analyze, Improve), with one sentence at the ring's center. Applicable to: methodology closed-loop.

## Chart/Table/Image/Component Rules

- **Timeline/waterfall chart**: horizontal bands express stage duration, with stages distinguished by soft fill colors (yellow = task, purple = event, approximate), thin leader lines connecting to stage-name labels; the vertical or horizontal axis retains only necessary tick marks.
- **Before/After task bars**: two horizontal bars — the top row "before optimization" as one long bar, the bottom row "after optimization" split into several short bars, with arrows marking event-handling points; colors as above.
- **Rating-bar component**: a large metric abbreviation (theme color or deep blue) + three color bars below (green/yellow/red) labeling Good / Needs Improvement / Poor and their thresholds, with three placed side by side for comparison. When reusing, replace with any three-tier rating semantics.
- **Wireframe device illustration**: use a simple rounded-rectangle wireframe to represent a phone/browser viewport, with only gray block placeholders inside to express content layout, and red/blue dashed lines and arrows marking displacement or regions; **do not embed real product screenshots**.
- **Curve chart**: a single smooth curve + sparse axes (a three-tier scale like 0%/50%/100%), no gridlines, mostly whitespace.
- **Loop diagram**: a ring divided into three equal arrow segments, node words arranged along the outside of the ring, a short sentence at the ring's center, arrows using a theme-green gradient.
- **Tables**: the whole deck almost never uses data tables; if one is needed, use a minimalist style with no vertical rules, thin dividers between rows, and a bolded, background-free header.
- **Images**: always placed centered with a thin gray border or no border; using third-party product-interface screenshots, real website photos, or photos of people is prohibited.
- **List symbols**: dots are the default; "recommended/satisfied"-type lists may use a green checkmark (✅) instead of a dot.

## Density and Spacing

- **One core message per page**: the title is the conclusion, and the body only supports that conclusion.
- List-page body text does not exceed 6 items; definition-page body text does not exceed 120 words; code-page code does not exceed 25 visible lines.
- Paragraph spacing (approximate): title underline → body text 48–64px; between list items 12–16px; image → caption text 24–32px.
- Whitespace ratio: on pure-white content pages, the effective content area occupies about 50–65% of the canvas, with the rest as whitespace; prefer splitting across pages over compressing line spacing.
- Overall page-count rhythm reference (32 pages): setup 40% (goals + metric definitions), turning point 10%, method and evidence 35%, closing 15%.

## Footer and Page Numbers

- Footer position: lower-left corner, a single line of 10–12px medium-gray small text (approximate), containing a copyright line like "© Year Institution Name. All rights reserved."; replace with your own institution when reusing, or remove it.
- A **small mark slot** may be placed on the left side of the footer (approximately a 16×16px colored-dot/graphic placeholder); when reusing, place your own logo or leave it blank — do not reuse the source deck's mark.
- The source deck **does not display page numbers explicitly**; if page numbers are needed, a medium-gray number at the lower right in 10px is recommended, on the same baseline as the footer.
- The cover and closing gradient pages carry no footer or page number.

## Prohibited Items

- Do not copy any third-party logo, conference mark, brand name, trademark, or mascot graphic.
- Do not use real product/website screenshots, real data, or the original charts and specific values from the source deck.
- Do not quote sentences from the source deck's body text; definitions and copy must be rewritten following this system's sentence patterns.
- Do not include photos of people or a speaker's likeness.
- Do not mix multiple decorative colors: each page is limited to one section accent color for decoration (except the three-state status legend).
- Do not use shadows, gradient text, outlined large text, 3D effects, or complex textured backgrounds (except the specified gradients on the cover and closing pages).
- Do not use serif or handwriting fonts, and do not introduce decorative variants beyond the specified Regular/Bold weights and limited italic usage.
- Do not add a large color-block background on pure-white content pages; color blocks are allowed only in the bottom diagonal band, the title underline, and inside charts.

## Delivery Checklist

- [ ] 16:9 aspect ratio, with margins and title baseline consistent throughout.
- [ ] Each page has only one title and one core message; the title is a question or an assertive statement.
- [ ] The title underline is present and its color matches the current section's accent color.
- [ ] The entire deck uses only the font size/weight/color combinations from the font hierarchy table.
- [ ] The section order follows the "problem → metrics → turning point → method → evidence → closed loop → recap → closing" skeleton.
- [ ] Metric-related content uses the "definition page + limitations page + calculation/evidence page" grouped structure.
- [ ] At least one Before/After comparison page and one closed-loop diagram page are included.
- [ ] Chart colors are drawn from the tokens, with no extra decorative colors outside the charts.
- [ ] The cover is a soft pink-purple cloud-layer gradient; the closing page is a deep-purple gradient + large white text.
- [ ] The footer copyright line has been replaced with your own institution or removed; no source-deck marks remain; page-number style is compliant.
- [ ] The document contains no third-party brands, screenshots, people, original text, or original data; approximate values have been calibrated to actual needs.
- [ ] Pure-white pages retain ≥35% whitespace, with no crowded pagination; code line counts and list-item counts stay within the limits.

- No cards by default: unless the user explicitly requests it, it is strictly forbidden to use rounded rectangles or rectangular cards to build hierarchy or alignment: lines, whitespace, and font-size differences are the superior solution
- No evenly-divided composition: unless there is no other usable layout, do not default to three-way splits, four-way splits, or 2×2 matrices. This includes three-part conclusions such as three-column + title + conclusion
