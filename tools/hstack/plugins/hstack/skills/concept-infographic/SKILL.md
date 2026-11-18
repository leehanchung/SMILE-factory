---
name: concept-infographic
description: Create source-grounded educational infographics from paper excerpts, mathematical ideas, and conceptual relationships using a clean illustrated teaching style with soft panels, numbered steps, concrete examples, and visual outcomes. Use for standalone visual concept explainers; adapt the layout to the idea. For slide decks or PPTD/PPTX deliverables, use open-kimi-ppt.
allowed-tools: "Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch"
---

# Concept infographic

Turn one bounded idea into a visual explanation someone can follow without reading the source first. Preserve the reference's teaching style while choosing a structure that fits the concept.

## Reference and defaults

Inspect [the bundled example](assets/bradley-terry-example.png) with the available image-viewing tool before rendering. Read [the visual system](references/visual-system.md) for the reusable design choices. This original generated example demonstrates the style, not a fixed layout or evidence for another topic. Its [example record](references/example.md) documents the mathematical source, numerical checks, and rendering limits. If the user supplies a different style reference, use that instead and create original explanatory content without copying publisher branding.

Unless the user specifies otherwise, assume a technically curious reader, English, a single portrait infographic, and a concise mechanism-level explanation. Use the request's language when appropriate. State material assumptions briefly and proceed; ask only when the source, audience, or ambiguity would materially change the explanation. A named paper without an excerpt may require finding the exact paper and selecting a clearly identified subsection.

## Establish the content

1. Search available user notes before researching elsewhere, following the workspace's source-priority instructions. Read supplied excerpts and original papers directly when available. For paper claims, record the exact title, version/date, section/page/equation, and URL or file path. Never substitute a similarly named model or paper version silently.
2. Define one sentence the reader should understand. Choose one concrete example whose entities recur through the panels. Separate source statements, derived calculations, illustrative examples, and explanatory analogies. Do not manufacture experimental results or imply that a diagram is empirical evidence.
3. Build a compact content brief using [the brief template](references/brief-template.md). Include exact displayed copy, symbol definitions, source anchors, each panel's meaning, arrow semantics, and the one qualification needed to prevent the central misunderstanding. Keep the brief internal unless review is requested; do not impose an approval checkpoint.
4. Apply the relevant checks in [input types](references/input-types.md). Verify calculations with code or a calculator. Preserve the distinction between training and inference, mathematical definitions and empirical claims, tendencies and guarantees.

If necessary evidence is inaccessible, explain the gap and create only a clearly labeled draft or generic explainer supported by what is available. Do not attribute guessed mechanisms to the named paper.

## Choose the teaching structure

| The idea needs | Use | Show at the end |
|---|---|---|
| A meaningful comparison | Aligned parallel panels with the same example and comparison criteria | Different outcomes or tradeoffs under stated conditions |
| A mechanism | Input → 3–5 transformations → output, with loops only where they exist | What changed in the example |
| A mathematical relationship | Concrete case → symbols → operation → numerical result | Boundary cases or the effect of changing one variable |
| A measurement concept | Question → response categories → observations → interpretation | A distribution or valid interpretation |
| A relationship between structures | Corresponding diagrams with persistent entities and labeled connections | A concrete implication plus a limit |

Two columns, exactly three steps, and an iteration strip are optional. Avoid false binaries and invented before/after progress. If the idea needs several independent takeaways, narrow the focus or use a small series instead of shrinking the text.

## Render

Image generation depends on the host's available and authorized tools. Skill discovery and the common tool metadata do not install a renderer or grant access to native image tools. Follow the host's image-generation workflow when available; otherwise use the unfinished-render fallback below.

- Use the available image-generation capability for the default illustrated raster output, following its current tool schema. Pass the selected reference image using a supported style-reference mechanism, or inspect it and describe its visual system in the prompt if direct reference conditioning is unavailable. It is not an edit target.
- Build the prompt from the brief and visual system. Specify composition, exact copy, symbol definitions, diagram relationships, source footer, and constraints. Tell the renderer which content is illustrative and which labels must be exact. Use short explanatory labels, not paragraphs pasted into boxes.
- For equations, preserve a canonical LaTeX/plain-text version in the companion brief even when they appear in the generated image. Do not promise that a raster renderer produces reliable editable math.
- For quantitative charts, use deterministic plotting when precise geometry matters. A generated bar can disagree with its correct numeric label; if the quantities only support the explanation, labeled value cards can avoid an unnecessary area/length encoding.
- When the user requests exact typography, editable vector output, publication figures, or long derivations, typeset text and math and draw semantic geometry deterministically in SVG/HTML/LaTeX or suitable plotting tools. Disclose that route and inspect the actual rendered export. Use image generation only for optional illustration where it helps. If revising a raster image, use the available image-editing workflow rather than silently switching to pixel manipulation.
- Export only formats that were actually created and checked. A PNG alone is not an editable source, SVG, or PDF. If generation is unavailable, deliver the brief and production prompt and state that the image is unfinished.

## Inspect and correct

View the finished image at full resolution and at its intended reading size. Check:

- Every word, mathematical symbol, number, operator, axis, category label, and source footer against the brief.
- Arrow direction, graph connections, object identity, color meaning, step order, proportional geometry, and all comparison denominators/conditions.
- Whether the visual accidentally claims causality, equal intervals, guaranteed convergence, measured improvement, or universal behavior that the source does not support.
- Main takeaway and qualifications remain legible; no overlap, clipping, tiny captions, decorative clutter, or dependence on color alone.

OCR may assist but does not replace visual inspection, especially for equations. Make a targeted correction when needed. If two focused correction attempts still leave a material error, change to a simpler or precision-rendered treatment when feasible, or clearly mark the unresolved draft. Do not call a known-wrong image final.

## Deliver

Return the actual image and a short explanation of its takeaway. Save the final asset plus a compact companion Markdown brief containing sources, canonical equations, illustrative assumptions, accessible description, production prompt, and inspection status. Preserve an existing output by creating a versioned sibling unless replacement was requested.

Use the requested destination or a local output directory. In a notes vault, follow its existing asset, metadata, linking, and generated-note conventions; do not create a new directory scheme or rewrite personal interpretations without being asked. Avoid leaving project assets only in temporary storage or a generation cache.

When reporting reliability, distinguish a design judgment from actual testing. Report which inputs and outputs were tested; do not invent success percentages, learning outcomes, or consistency guarantees.
