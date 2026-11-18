# Editorial Growth Courseware · PPT Design System (brand-free, reusable version)

This system is abstracted from a complete source deck of corporate brand and growth-methodology courseware, retaining only the layout, color relationships, and teaching narrative. It is not a reproduction of the source deck: it carries no platform mark, company name, person, photo, original text, case data, or product interface. All colors, dimensions, and values are approximate tokens; when generating, this file should serve as the constraint, with the user's query as the sole source of content.

Applicable scenarios: B2B brand courses, marketing-capability training, growth-methodology workshops, brand-and-demand-alignment explanations for management.

## Visual DNA

- **Editorial paper feel**: content is organized through generous whitespace, thin dividers, short paragraphs, and prominent section numbers; each page advances only one teaching conclusion.
- **Calm base color + a single warm accent**: the base color is near paper-white or extremely light gray, with structural text in deep-blue ink; warm yellow or coral is used only to mark emphasis, action, or results — never as full-screen decoration.
- **The section number is the navigation anchor**: section pages may use an oversized semi-transparent number or a narrow color bar to indicate progress; the number expresses only sequence and carries no statistic beyond what the query provides.
- **Method first, cases later**: principles are first broken down into actionable steps, then verified with anonymous, fictional scenario cards; cases must not become a brand showcase wall.
- **Lightweight illustration**: prefer geometric color blocks, wireframes, arrows, and abstract human silhouettes; do not use photos, real webpage screenshots, or icon stacks.

## Canvas and Grid

- The output aspect ratio is fixed at 16:9 (recommended 1280×720 or equivalent), even if the source deck was portrait-oriented — only its editorial pacing is borrowed, not its portrait ratio.
- Safe margins are about 6% left/right, about 7% at the top, with 7% reserved at the bottom as the footer band. The title, section number, and page number keep the same baseline throughout.
- Use an implicit 12-column grid: the title and main text occupy 7 columns, with evidence/cards on the right occupying 5 columns; a full-width data page may occupy 10 columns while retaining two columns of breathing room.
- Section pages may include a narrow color band extending from left to right; content pages remain paper-white, without a large color block pressing down on the text.

## Font Hierarchy

- Use Liter (English) and MiSans (Chinese); do not use brand-imitation letterforms. Numbers may use a semi-bold weight of the same font.

| Tier | Purpose | Approximate size (1280 width) | Weight | Color |
|---|---|---:|---|---|
| Cover title | One-sentence thesis | 42–50px | Bold | `--ink` |
| Page title | Conclusion sentence | 30–38px | Bold | `--ink` |
| Section number | Navigation mark | 54–90px | Regular/Bold | `--accent` at 20% opacity |
| Card title | Principle/action name | 20–24px | Bold | `--ink` |
| Body text | Explanation, steps, notes | 15–18px | Regular | `--body` |
| Footer | Source placeholder, page number | 10–12px | Regular | `--muted` |

Titles should preferably state a conclusion or a question, not an empty section label like "Contents" or "Introduction." Each body line should not exceed about 26 words; keywords are emphasized with weight rather than a second accent color.

## Color Tokens

- `--paper`: paper white `#FBFAF7`, the background of content pages.
- `--paper-cool`: cool light gray `#F1F3F5`, used for card backgrounds or section dividers.
- `--ink`: deep-blue ink `#102A43`, for titles, axis lines, and primary text.
- `--body`: dark blue-gray `#334E68`, for body text and explanations.
- `--muted`: blue-gray `#829AB1`, for footers, secondary tick marks, and borders.
- `--accent-yellow`: bright warm yellow `#F4C95D`, used for principle numbers, action markers, and a single point of emphasis.
- `--accent-coral`: soft coral `#E98B73`, used only for result/risk callouts — pick one or the other, never using it as decoration alongside warm yellow at the same time.
- `--line`: light blue-gray `#D9E2EC`, for dividers and table rules.
- `--dark-panel`: deep indigo `#243B53`, used only for a single dark closing page or code-style explanation.

Choose at most one primary accent color per page; warm yellow and coral may coexist only when their semantics are genuinely different (action vs. risk), and each must occupy less than 10% of the page.

## Page Skeleton

A six-page template progresses through "recognize the problem → form principles → turn into action → check the closed loop":

1. **Cover thesis**: paper-white background, a left-aligned conclusion sentence, an abstract geometric composition on the right; a small section number or short color band sets the tone.
2. **Why now**: one question sentence + three anonymous signal cards; the cards display only settings given by the query, without introducing source-deck data.
3. **Three principles**: three horizontal cards or a vertical staircase, each card with one verb, one explanation, and one observable behavior.
4. **Action combination**: a matrix/process connects audience, touchpoints, content, and cadence; an accent color points out the currently prioritized action.
5. **Verification and cases**: fictional before/after comparisons or a funnel on the left, with "what to look for/how to judge" on the right; all numbers must come from the query or be clearly marked as examples.
6. **Action closed loop**: a dark or light closing page giving the next step, a placeholder for the owner, a review cadence, and a reusable checklist; do not use a plain "thank you" page.

## Reusable Layouts

- **E1 conclusion + side card**: 60% conclusion and three pieces of evidence on the left, 40% a large number/abstract graphic on the right.
- **E2 three-principle cards**: three equal-width columns of cards, with the section number at the card's top and one line at the bottom stating "what counts as done."
- **E3 staircase path**: a four-tier horizontal staircase expressing progression from awareness to action, with connecting lines using only thin lines and arrows.
- **E4 2×2 choice matrix**: the horizontal/vertical axes each represent one judgment dimension explicitly given in the query, with only short labels placed within the quadrants — do not fabricate rankings.
- **E5 before/after comparison**: the same component in two rows, with the change explained on the left and direction shown with a same-colored bar on the right; using real case screenshots from a source deck is prohibited.
- **E6 closing checklist**: a deep-indigo or paper-white background, three "this week's actions" + one "next review," leaving ample whitespace at the bottom.

## Chart/Table/Image/Component Rules

- **Big-number card**: shows only one number and its unit, with the measurement basis/target written below; a number without a source uses an "example" label, without faking precision.
- **Funnel/path diagram**: at most four tiers, direction left to right; each tier uses only shades of a single color, no rainbow gradients.
- **Matrix**: axes, quadrants, and labels use `--ink`/`--line`, with the accent color marking only one recommended region; the judgment basis must be written beside it.
- **Process and loop**: use rounded rectangles + thin arrows, with step numbers matching the section number; a loop-back must label its trigger condition and review action.
- **Tables**: at most five columns, no vertical lines, with light lines between rows; headers are bolded, and key rows are marked with an accent-colored left border.
- **Images**: prefer abstract geometric placeholders, wireframes, and self-drawn graphics; do not place photos of people, brand logos, product interfaces, or source-deck charts.
- **Cards**: 8–12px rounded corners, 1px border, avoiding heavy shadows; leave at least 16px spacing between cards.

## Density and Spacing

- One repeatable conclusion per page, with body text not exceeding 6 items; on a three-card page, each card should not exceed about 35 words.
- Title to body 32–48px, between paragraphs 14–18px, card padding 18–24px; effective content area about 55–70%.
- The cover and closing pages are low density; the method-matrix and case pages are medium density; do not solve excess content by shrinking the font — cut content or split the page instead.

## Footer and Page Numbers

- Content pages place a page number in the form `01/06` at the lower right, 10–12px `--muted`; section pages may show only the section number.
- The lower left may carry an "internal working draft/example" placeholder, but must not carry a source brand name or a copied copyright mark.
- The cover and closing pages may omit the footer; if retained, use the same gray value and the same baseline.

## Prohibited Items

- Do not copy any platform/company logo, trademark, person, case name, original sentence, real data, or product screenshot.
- Do not use large areas of brand blue, gradient text, glow, heavy shadows, skeuomorphic icons, or decorative photos to manufacture a "marketing feel."
- Do not use empty words like "brand," "growth," or "exposure" as titles; a title must be able to guide a judgment or an action.
- Do not use a percentage without a stated unit and measurement basis, and do not write an anonymous example as if it were a real client result.
- Do not use multiple highly saturated accent colors on the same page, and do not let a wall of cards replace narrative.

## Delivery Checklist

- [ ] The aspect ratio is 16:9, with the title/section-number/page-number baseline consistent.
- [ ] Each of the six pages has one conclusion, with no table-of-contents page, plain thank-you page, or blank transition page.
- [ ] At least one principle-card page, one action-matrix page, one before/after comparison page, and one action-closed-loop page are present.
- [ ] Each page uses only one primary accent color, and color carries a clear semantic meaning.
- [ ] All numbers come from the query or are marked as examples, with the unit and measurement basis stated.
- [ ] No source-deck brand mark, person, photo, screenshot, original text, original data, or identifiable case is present.
- [ ] Cards, tables, processes, and charts are all readable at projection distance, with whitespace ratios not compressed.

- No cards by default: unless the user explicitly requests it, it is strictly forbidden to use rounded rectangles or rectangular cards to build hierarchy or alignment: lines, whitespace, and font-size differences are the superior solution
- No evenly-divided composition: unless there is no other usable layout, do not default to three-way splits, four-way splits, or 2×2 matrices. This includes three-part conclusions such as three-column + title + conclusion
