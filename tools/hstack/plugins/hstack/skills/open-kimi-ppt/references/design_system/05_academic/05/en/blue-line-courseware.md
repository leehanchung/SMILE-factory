# Blue-Line Experiment Methodology Courseware · PPT Design System (brand-free, reusable version)

This system is reverse-engineered from a complete experiment-and-measurement-methodology courseware, abstracting only the teaching pacing, method matrices, comparison expression, and editorial layout. Do not copy the platform name, company, person, case, photo, screenshot, original text, or real metric from the source deck; the facts and numbers in the generated deck may come only from the user's query.

Applicable scenarios: marketing-experiment training, product-trial design, growth-team workshops, management-level experiment-governance explanations.

## Visual DNA

- **Handout-style section structure**: each chapter is cut apart by a prominent number, a short title, and a color band; the body reads like a printable operations manual — defining first, then demonstrating.
- **A blue line runs throughout**: deep-blue thin lines, arrows, and axes string the pages into one path of "form a hypothesis — split groups — measure — act"; the line matters more than any icon.
- **Highlighting only signals**: yellow/orange is used for hypotheses, caveats, or next steps, in a small, fixed-position area; the rest of the information is layered in black, gray, and light blue.
- **Comparison first**: control vs. treatment group, before vs. after, input vs. result are all displayed side by side using the same geometric component, without flashy 3D graphics.
- **Cases are practice material**: case pages only demonstrate how the method lands in practice, using anonymous fictional scenarios instead; they do not reproduce a source deck's client narrative or results.

## Canvas and Grid

- Output is uniformly 16:9 (1280×720 or equivalent); the source deck's portrait reading pace is translated into horizontal columns rather than copying its original page ratio.
- Margins are about 5.5% left/right, 7% at the top, 8% at the bottom; the section number and page number are fixed at the upper-left and lower-right anchor points.
- Use a 12-column grid: definition text occupies 5 columns, the method diagram occupies 7 columns; comparison pages use a 5:5 two-column split, with 2 columns left in the middle for connecting lines.
- Lines use 1–2px width, with connecting lines always directional; large color blocks appear only on section pages or a single dark summary page.

## Font Hierarchy

- Use Liter for English and MiSans for Chinese; process labels and numbers may use the same font's semi-bold weight, with JetBrains Mono (brought in via customFonts) reserved for code or formulas.

| Tier | Purpose | Approximate size (1280 width) | Weight | Color |
|---|---|---:|---|---|
| Cover title | Method thesis | 40–48px | Bold | `--ink` |
| Page title | Conclusion/question | 30–36px | Bold | `--ink` |
| Section number | Progress navigation | 48–76px | Bold | `--accent-blue` |
| Method label | Hypothesis, control, treatment, etc. | 16–20px | SemiBold | `--ink` |
| Body text | Definitions, steps, explanations | 15–18px | Regular | `--body` |
| Annotation/footnote | Measurement basis, limitations, page number | 10–12px | Regular | `--muted` |

Write titles as "the judgment this page must produce," not empty section names like "Methodology" or "Best Practices." Every chart must be accompanied by one sentence of "how to read it/what it means."

## Color Tokens

- `--paper`: warm white `#FCFCFA`.
- `--ink`: deep indigo-blue `#14213D`, for titles, the main line, and axis lines.
- `--body`: blue-gray `#3E536B`, for body text.
- `--muted`: gray-blue `#8C9AA8`, for footnotes and auxiliary lines.
- `--line`: light blue-gray `#D8E2EA`, for dividers and grids.
- `--accent-blue`: medium-bright blue `#2F80ED`, for section numbers, the treatment group, or the main path.
- `--accent-yellow`: warm yellow `#F2C94C`, for hypothesis/key-point callouts; choose only one spot as the primary emphasis.
- `--accent-orange`: orange `#F2994A`, for risk/to-be-verified callouts; must not be used as decoration simultaneously with yellow.
- `--control`: gray-blue `#9FB3C8`, for the control group or baseline.
- `--deep-panel`: deep blue `#203A5F`, for the summary page or method box, not for an ordinary content-page background.

By default, each page enables only `--accent-blue` plus one semantic accent color (yellow or orange). The control and treatment groups must both be labeled with text in the legend — do not distinguish them by color alone.

## Page Skeleton

A six-page template progresses through "problem — method — verification — scaling":

1. **Cover**: one experimental thesis sentence, a section number, and a blue line; geometric nodes hint at the path, with no photo or brand mark.
2. **Why experiment**: a question sentence + three common misconceptions, with the boundary of the judgment to be verified this time given at the bottom.
3. **Hypothesis and grouping**: the hypothesis structure on the left, with control/treatment columns on the right explaining the input, what stays constant, and the observed metric.
4. **Method selection**: use a two-dimensional matrix or decision tree to select the test type, clearly stating when it does not apply; all labels use the user query's own terminology.
5. **Read results and act**: an anonymous example's before/after comparison, a confidence-interval placeholder, or a result card, immediately followed by the criteria for "continue / adjust / stop."
6. **Scaling closed loop**: an owner, a timeline, a review cadence, and an experiment log form the loop; the final sentence is an executable next step, not a thank-you page.

## Reusable Layouts

- **M1 hypothesis card**: an `If … then … because …` three-line structure, with the falsifiability condition written at the bottom.
- **M2 two-group comparison**: control group / treatment group side by side, with what stays constant written at the top and the single changed variable written at the bottom.
- **M3 decision tree**: at most three branch levels; each leaf node states "applicable/not applicable" rather than an abstract noun.
- **M4 method matrix**: the horizontal axis is the observation period or intervention intensity, the vertical axis is a user-given dimension such as randomization or geographic scope; the recommended cell gets a yellow border.
- **M5 result card**: four lines — metric, direction, interval/measurement basis, action; if there is no interval, explicitly write "evidence pending."
- **M6 closed-loop swimlane**: four segments — propose → execute → analyze → review — with a role placeholder marked beside each lane, avoiding fabricated names.

## Chart/Table/Image/Component Rules

- **Comparison bar**: the control group in gray-blue, the treatment group in blue; both bars start from the same zero point, directly labeling the direction and unit of the difference.
- **Timeline**: a single blue line connects the baseline, intervention, observation window, and decision point; each node states only one action.
- **Interval chart**: prefer point estimates + error bars or an interval band; do not truncate axes, hide sample size, or present correlation as causation.
- **Decision matrix**: the axis titles, applicability boundary, and "do not use" region must all be present; avoid treating a four-quadrant layout as decoration.
- **Tables**: at most five columns, six visible rows; the first column is the question/hypothesis, the last column is the action or evidence status.
- **Images**: use only self-drawn abstract graphics, wireframe devices, and geometric placeholders; photos of people, product interfaces, logos, and original source-deck charts are prohibited.
- **Formulas/code**: use a monospace font in a light-colored code box, at most 8 lines; explain the input, output, and limitations beside it.

## Density and Spacing

- One judgment per page; body text does not exceed 6 items, decision-tree nodes do not exceed 8, and each matrix axis does not exceed 4 labels.
- Title to main figure 28–44px, spacing between components 16–24px, at least 8px of gap between lines and text; effective content area about 60%.
- Definition pages are low density, method-matrix pages are medium density, result pages are medium-low density; do not shrink the font to cram in more experiment types.

## Footer and Page Numbers

- The lower right uses a `01/06`-style page number, the lower left carries small "measurement basis/hypothesis/example" text; both use `--muted`.
- When a source is needed, write only an anonymous "internal setting/public methodology reference," not a source-deck brand name or a copied copyright line.
- The cover may omit the footer; the closed-loop page retains the page number for reference during reviews.

## Prohibited Items

- Do not copy any platform, company, client, person, trademark, photo, interface, original text, real result, or number from the source deck.
- Do not describe an observational correlation as causal, and do not omit the control group, sample definition and sampling basis, time window, or limitations.
- Do not use rainbow colors, glowing particles, heavy shadows, 3D perspective, or complex illustrations in place of a clear experimental relationship.
- Do not use baseline-free promotional language such as "significantly improved" or "comprehensively leading"; without evidence, write "to be verified."
- Do not let a matrix, process, or big-number card exist independently, detached from the page's title conclusion.

## Delivery Checklist

- [ ] The aspect ratio is 16:9, with the section number, title, and page number sharing a consistent baseline.
- [ ] The six pages cover, in order, the problem, hypothesis grouping, method selection, reading results, and the scaling closed loop, with no table-of-contents or thank-you page.
- [ ] At least one control/treatment comparison page, one method-matrix or decision-tree page, and one result-criteria page are present.
- [ ] Charts clearly state the unit, measurement basis, time window, and limitations; if missing, mark them as evidence pending.
- [ ] Each page enables only one semantic accent color, with both the control and treatment groups carrying text labels.
- [ ] All numbers come from the query or are marked as examples; there is no brand mark, person, photo, screenshot, original text, or source-deck data.
- [ ] The generated PPTD/PPTX opens correctly, the per-page screenshot count matches the page count, and text is readable at projection distance.

- No cards by default: unless the user explicitly requests it, it is strictly forbidden to use rounded rectangles or rectangular cards to build hierarchy or alignment: lines, whitespace, and font-size differences are the superior solution
- No evenly-divided composition: unless there is no other usable layout, do not default to three-way splits, four-way splits, or 2×2 matrices. This includes three-part conclusions such as three-column + title + conclusion
