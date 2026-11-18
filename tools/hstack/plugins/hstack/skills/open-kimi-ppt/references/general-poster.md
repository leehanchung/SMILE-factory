# General Infographics and Posters

Use this guide only when the user explicitly requests an infographic, poster, or a highly visual single-page design. Do not load this guide for ordinary PPT requests.

This guide defines only the design decision process and quality baselines; it does not prescribe fixed color schemes, fonts, maps, timelines, grids, or page skeletons. Design independently based on the subject, audience, materials, and usage scenario; never copy a sample by default just because it is more detailed.

## Production Workflow

### 1. Understand the Subject and Communication Goals

First confirm:

- What this poster should make readers see, understand, remember, or do.
- The primary audience, viewing distance, display medium, and available reading time.
- The size, aspect ratio, colors, style, content, and output format explicitly requested by the user.
- The core relationship the material truly needs to express: time, space, process, contrast, hierarchy, object structure, or pure spirit/atmosphere conveyance.
- Whether the available images, data, and verifiable facts are sufficient to support the chosen form of expression.

### 2. Explore Different Directions First, Then Choose One

Before writing any `.page` file or placing elements, internally form 2–3 visual directions with substantive differences. They should differ in at least two of the following:

- Primary visual focus: image, typography, object, data, map/relationship diagram, or abstract graphics.
- Information structure: linear narrative, radial hub, local zoom, layered section, juxtaposed comparison, image matrix, or a single scene.
- Spatial organization: full-bleed, off-axis, symmetric, high-density, generous whitespace, or zoned structure.

At least one candidate direction should treat the entire canvas as one visual field, scene, or object relationship, rather than first splitting the content into containers of equal width and height. Cards may appear among the candidates, but must not automatically become the default just because the information has three or four items.

Before finalizing a direction, compare which primary visual medium best carries the content. Whenever people, artifacts, materials, environments, or event scenes are important evidence for the subject, actually examine at least 2 existing images, search results, generated images, proofs, or reference screenshots that differ substantively in composition or visual language; whenever process, hierarchy, system, propagation, causality, contrast, or spatial relationships are central, compare at least 2 editable vector or SmartArt-like figure drafts with clearly different structures. After comparing subject recognizability, thumbnail memorability, information capacity, compositional coexistence, and editability, choose photography/real-object imagery, generated images, custom vectors, structured figures, or a hybrid solution. Do not default to pure vectors just because PPTD vectors are easier to implement or because searching/generating assets takes time, and do not force in images unrelated to the content just to "have assets."

Choose one direction based on the subject's characteristics, the user's tone, asset quality, and the primary reading task. You don't need to deliver three designs, but don't start building the moment you see the first workable option.

Available grammars include but are not limited to typography-led, photography-led, object/section annotation, archival collage, data field, spatial map, or relationship diagram. These are angles for thinking, not templates that must be applied.

### 3. Write `style.md` in the Project

For a newly created poster/infographic, create a brief `style.md` in the PPTD project root before writing `.page` files. It is the design brief for the current task — not a new skill file, not a hard process gate, and not an extra deliverable.

Review the user's assets, actual image candidates, and the fonts available in `references/fonts.md` before finalizing `style.md`. Keep the content short, specific, and actionable; it typically includes:

```markdown
# Style Brief
- Goal and audience:
- Output scenario and canvas:
- Core message in one sentence:
- Chosen visual concept/metaphor:
- Primary visual focus:
- Poster-level visual move (why this is not an ordinary content page):
- Visual DNA (background/material, typographic/geometric temperament, how images coexist with structured information):
- Primary visual medium and asset/SmartArt-like figure candidates compared, with reasons for the choice:
- Reading order and composition:
- Color scheme and each color's role:
- Chinese and English fonts, size hierarchy, and usage:
- Image selection, cropping, and treatment:
- Graphics/chart/connector language (if needed):
- Information density, whitespace, and alignment:
- Tropes to avoid:
```

- Explain why this direction was chosen, and record in one sentence the main reason the other directions were not chosen; also state which trope the chosen direction is most likely to degenerate into (for example, an ordinary technical report, a retro propaganda page, a commercial promotion, or a uniform card wall), so it can be checked against during screenshot review.
- When the user has already provided a complete design system, template, or strong style constraints, `style.md` only converts them into actionable decisions; do not invent new styles that conflict with the user's requirements.
- After viewing actual images or discovering asset limitations, you may update `style.md` once before refining the pages. Do not turn it into a lengthy process log.
- Creating a new `style.md` is not mandatory when making local edits to an existing artifact; it is only needed when redesigning the overall visual.

## Canvas Ratio and Orientation

Determine the output scenario and canvas first, then design the grid, font sizes, and content structure. Do not equate a poster with portrait orientation by default, and do not default to inheriting PPT's 16:9.

1. When the user explicitly specifies a size, orientation, or ratio, strictly use the user's requirement.
2. When the user has not specified, choose on your own based on the deployment scenario, information richness, primary reading order, and relationship structure.
3. When there is too much information, prioritize distilling, layering, or splitting into a few pages; do not cram everything into a single page with extremely small font sizes.
4. Once the canvas is chosen, compose directly for that ratio; do not build it in 16:9 first and then stretch or crop the whole thing into another ratio.

| Common ratio | PPTD reference size | Common scenarios |
|---|---:|---|
| 9:16 portrait | `[540, 960]` | Mobile reading, social media, vertical narrative |
| 3:4 portrait | `[720, 960]` | Print-like posters, person/object hero visuals |
| 1:1 square | `[720, 720]` | Social media, centered structures, moderate information volume |
| 4:3 landscape | `[720, 540]` | Higher-density text-image content, document embedding |
| 16:9 landscape | `[960, 540]` | Widescreen display, horizontal relationships and parallel multi-column layouts |

A PPTD canvas can use any `[width, height]`; the sizes in the table are references, not enumerated restrictions.

## Content Relationships and Graphic Selection

First state the page's core message in one sentence, then choose the graphic that best expresses it. Use a structure diagram only when the relationship itself is central; do not add maps, timelines, routes, flowcharts, matrices, or indexes just to look rich. Parallel relationships do not automatically equal cards: first consider groups of objects in the same scene, sequences of images/symbols, scale differences, spatial adjacency, color bands, rule lines, or typographic rhythm.

When the core message is process, hierarchy, system, propagation, causality, contrast, or spatial relationships, treat structured graphics (SmartArt-like figures), maps, routes, or method diagrams as primary visual material. The chosen structure diagram should occupy enough area and participate in the whole-page composition, implemented with editable PPTD elements where possible; generating native OOXML SmartArt objects is not required, but do not let it degenerate into a row of rounded boxes, generic icons, and thin arrows just for the sake of "editability." It can form one continuous visual field together with the main object, scene imagery, close-up details, and anchored captions.

| Core relationship | Possible expressions |
|---|---|
| Time evolution, stage changes | Timeline, milestones, before/after states |
| Paths, propagation, migration | Maps, routes, flows, or networks |
| Steps, mechanisms, methods | Process, swimlanes, input–process–output |
| Differences between objects or viewpoints | Juxtaposed comparison, matrix, scale axis |
| Hierarchy, composition, systems | Tree hierarchy, architecture, layered section |
| Physical objects, products, paper method details | Object annotation, local zoom, visual anatomy |
| Multiple facts or samples | Image matrix, taxonomy map, data field |
| Emotion, ideas, attitudes | Single strong image, pure typographic composition, abstract form |

- When the user explicitly requests a "map," provide a geographic base or outline that can establish spatial relationships; do not pass off an abstract polyline as a map.
- For routes, propagation, and migration, choose on your own among a full-bleed map, a local locator, a radial network, land-sea layering, or multiple branch routes based on semantics; do not default to thin horizontal lines.
- For architecture diagrams, UML, and paper method figures, first ensure the nodes, interfaces, directions, grouping, and legends are correct before visual beautification.

## Design Freedom and Quality Baselines

- Colors, fonts, image treatment, and composition arise from the subject and `style.md`. Unless the user explicitly requests it, do not default to black-white-silver-gray, a single-point fluorescent accent, giant cropped type, archival micro-labels, or thin-line timelines.
- A poster should first establish one dominant visual grammar, with other elements serving it. Do not cram the hero image, giant type, map, timeline, icon matrix, and data charts in all at once just to seem "rich."
- Establish at least one visual memory point that remains recognizable in a full-page thumbnail or at a distance, carried by the hero image, giant type, a large object, a full-bleed color field, a scene, or the core relationship diagram. If the thumbnail shows only a title and a set of regular boxes, recompose.
- When producing multiple pieces on different subjects in succession, do not default to reusing the previous one's main composition, accent-color roles, image proportion, and linear graphics.
- Grids, whitespace, cards, collages, asymmetry, or full-bleed are all optional means, not the default correct answer. Avoid stuffing every category of content below the title into equal-width, equal-height rectangles with rounded corners, outlines, or shadows, forming a "three-card/four-card + CTA" slide or app-interface skeleton. Use containers only when the container itself has clear semantics and will not form a uniform card wall; otherwise prefer organizing content with layout zones, proportion, color blocks, rule lines, spatial adjacency, object groups, or typographic rhythm.
- A page may have very little text, or it may have several high-density modules; but the core message, primary visual focus, and reading path must be clear. Organize rich content primarily through scale hierarchy, local zooms, captions, and spatial relationships; do not disguise sparse content as rich with repeated cards or oversized padding, and do not compress a large number of facts into unreadably small text.
- Body text, annotations, legends, and sources must be readable in the actual output scenario. When there is too much information, cut, layer, or split pages; do not solve it with tiny font sizes.
- Data, facts, dates, locations, labels, units, and sources must stay faithful to the user's materials or verifiable information. For precise figures that cannot be confirmed, use qualitative statements, approximations, or omit them; do not fabricate statistics, coordinates, issue numbers, or publication details for an "archival feel."

### Few-shot: Multiple Complete Briefs and Anonymous Visual-Move Fragments

The following complete samples are used to expand the design moves, primary visual media, and risk awareness you can draw on; they are not fixed visual families, subject mappings, or templates awaiting selection. The concept name, visual DNA, colors, fonts, canvas, and composition of an actual brief must be re-derived from the current subject, assets, and reading relationships; you may recombine a few compatible moves across samples, or devise your own entirely — do not just pick the most similar label and copy the whole set.

#### Poster Editorial

```markdown
# Style Brief — Poster Editorial
- Goal and audience: designed for quick browsing and short dwell; make the subject memorable first, then let readers discover archival details.
- Output scenario and canvas: choose landscape or portrait based on the actual medium; do not take a 16:9 layout and crop it.
- Core message: string together the object, time, and context with one judgment that takes a position; do not use section-style empty titles.
- Visual concept: "a contemporary, editorially curated object archive"; calm, sharp, with print tension, without imitating a real magazine cover.
- Primary visual focus: choose only one of three as the protagonist — a high-contrast object image, an object silhouette, or giant type.
- Reading order and composition: use a rigorous grid with a clear dense-versus-sparse counterpoint; the title, exhibit item, and micro captions form three scales, but not every poster is required to have a route or timeline.
- Color: Editorial White `#F7F6F2` and Deep Black `#0B0B0B` carry the main relationship; silver-gray is used only for secondary information; choose at most one small-area accent from Signal Red `#F20505`, Fluoro Lime `#D6FF00`, or Acid Orange `#FF4A1C`.
- Fonts: the main title uses 得意黑/阿里妈妈数黑体 with HedvigLettersSans; the body uses MiSans/Liter; at most three font families, and the numbering font does not carry body text.
- Image treatment: prefer images with strong contours, close-ups, and room for bold cropping; they may be converted to black and white or desaturated, but keep the object's recognition points.
- Graphic language: use hairlines, short labels, and small nodes only when content relationships need them; maps must have a spatial base, and data charts must have real data.
- Information density: keep one clear visual breathing area; archival details may be dense, but body text and captions must be readable at the actual output size.
- Must avoid: rounded-card walls, evenly distributed accent colors, fake logos/issue numbers/archives, and stacking giant type, a map, a timeline, and an icon matrix all at once just to seem rich.
- Reason for choosing: when the subject needs to be highly memorable while retaining traceable details, this direction is superior to a generic commercial infographic.
```

#### Geometric Composition

```markdown
# Style Brief — Geometric Composition
- Visual concept: translate the core concept into tension among circles, squares, lines, proportions, and glyphs; do not use geometric blocks to decorate empty space.
- Primary visual focus: one geometric relationship or glyph composition occupying the main area, not multiple evenly distributed colored rectangles.
- Poster-level visual move: let the title pass through, embed into, or cut across the main geometry, so text and composition together become the image, instead of the title hovering above the content.
- Visual DNA: decide color roles and typographic temperament from the subject; establish order with proportion, axes, numbering, and scale, with factual information taking its place along the geometric relationships.
- Information organization: bind concept differences, proportions, stages, or a work index to shape relationships; secondary material is tucked into the edges or a narrow index band.
- Must avoid: evenly tiling primary colors, a children's-building-block feel, random circles and squares unrelated to the content, and degenerating the geometric composition into a colored card wall.
```

#### Material Evidence

```markdown
# Style Brief — Material Evidence
- Visual concept: treat materials, artifacts, surface traces, or the making process as evidence, letting tactile quality and provenance relationships tell the content together.
- Primary visual focus: a sufficiently large macro, scan, section, or artifact detail; other images relate to it as slices, sequences, or provenance evidence.
- Poster-level visual move: let the texture or object span the main extent of the canvas, with captions anchored directly to visible details; do not shrink high-quality assets into specimen cards.
- Visual DNA: extract color, grain, and line language from the actual object; fonts and labels serve the material's temperament; maps, genealogies, or processes appear only when relationships need them.
- Information organization: organize facts through source labels, local zooms, material genealogy, craft steps, or propagation paths, keeping one clear breathing area.
- Must avoid: uniform brown retro templates, travel souvenir albums, forged old archives, decorative seals, and a row of equally sized object cards.
```

#### Dark-Field Signals

```markdown
# Style Brief — Dark-Field Signals
- Visual concept: in a dark field, use localized light sources, trajectories, scales, or rhythmic signals to establish a sense of direction; black is space, not background fill.
- Primary visual focus: one brightly lit object, motion image, glowing trail, or high-contrast glyph form, with other elements building distance and speed around it.
- Poster-level visual move: let a signal line, path, or band of light cross the canvas and connect fact nodes, so the subject and direction of motion remain recognizable from a distance.
- Visual DNA: accent colors serve only nodes, directions, numbers, or warnings; numeric fonts, coordinates, and scanning elements must serve reading rather than create tech noise.
- Information organization: organize route, time, frequency, cohort, or status data along a common coordinate field; keep a stable high-contrast safe zone for body text.
- Must avoid: full-page neon, bloom effects, cyber dashboards, small gray text on black, and packing every data group into a glowing panel.
```

#### Scientific Observation

```markdown
# Style Brief — Scientific Observation
- Visual concept: treat the page as a verifiable observation field, using objects, sections, relationships, and scale to explain a mechanism, rather than presenting a popular-science column.
- Primary visual focus: a main specimen, an ecological section, a system relationship, or a local zoom; readers see the object first, then understand the mechanism along the annotations.
- Poster-level visual move: let scale, depth, hierarchy, flow direction, or causality run through the whole page, with imagery and legend sharing the same spatial coordinates.
- Visual DNA: colors distinguish objects, relationships, and risks; annotation lines, units, legends, sources, and confidence boundaries stay readable and checkable.
- Information organization: mechanisms, specimens, and evidence are organized through spatial adjacency and connecting relationships; use a small amount of comparison when necessary, and do not default to three-column cards.
- Must avoid: technical-report front pages, white dashboards, equal-width info boxes, decorative data, and unverifiable precise figures.
```

#### Dynamic Collage

```markdown
# Style Brief — Dynamic Collage
- Visual concept: use directional glyphs, cropped imagery, color bands, and event fragments to create a manifesto feel, with rhythm coming from content conflicts rather than decorative noise.
- Primary visual focus: one boldly cropped title, figure/object silhouette, or high-contrast image; do not let multiple assets compete evenly for attention.
- Poster-level visual move: interweave the title, imagery, and a diagonal or offset structure to form a direction and posture recognizable from a distance.
- Visual DNA: maintain one dominant contrast relationship; collage edges, numbering, event nodes, and short phrases share a unified logic of angle, weight, and spacing.
- Information organization: compress viewpoints, impacts, events, or stages into a few directional band sequences; body text returns to a stable grid to stay readable.
- Must avoid: promotional ads, price tags, meaningless torn paper, slogan stacking, too many angles, and enlarging all text at once.
```

#### Detachable Anonymous Move Fragments

The following provide only local compositional knowledge, not complete directions; do not name the fragments, and do not match subjects to them one by one. First state the current page's core message and dominant relationship, then adapt one or two of these moves as needed, or devise your own entirely:

- Let the title pass through, embed into, or cut across a main geometry that carries information; facts take their place along proportions, axes, numbering, or shape relationships — the geometry is not just space-filling decoration.
- Let objects, textures, macros, or sections span the main extent of the canvas, with captions anchored directly to visible details; other images form slice, sequence, or provenance relationships rather than shrinking into a row of specimen cards.
- Let routes, light bands, or motion trails cross the canvas and connect fact nodes while retaining the necessary geographic, scene, branch, and time information; paths can be formed by imagery, terrain, or spatial relationships rather than defaulting to thin-line charts.
- Let specimens, sections, scale, legends, and causal relationships share one continuous observation field; when immersion matters, preserve the continuity of the environment rather than degenerating into a "main image left + evidence box right" technical report.
- Interweave a recognizable title or object, cropped imagery, and a directional structure; events and viewpoints unfold along a unified rhythm, and avoid letting the title's recognizability drown in collage noise.

In an actual task, regenerate `style.md` from the subject, assets, and reading relationships, using a concept name unique to the current task. Do not first look through the fragments for the "most similar category," and do not write "selected the so-and-so family" in the brief. Keep one dominant visual grammar, with other moves only as compatible support; the final direction must explain why it suits the current content, rather than merely swapping the sample's subject text and accent color.

## Imagery, Copyright, and Authenticity

- Prefer images with a clear subject, usable room for cropping, and genuine semantic relevance to the content. Ensure objects and evidence are correct before stylizing.
- When relying on images to determine composition, actually view the candidate images before deciding subject placement, crop lines, and text safe areas; do not decide from keywords or imagination alone.
- Once a good enough candidate image has been found or generated, let it truly enter the main composition; do not swap specific people, artifacts, materials, or environments back into generic vector icons, silhouettes, or schematic stand-ins just to save implementation effort.
- When choosing photography or real-object imagery as the primary visual grammar, let key images occupy enough area on the canvas to create a memorable impression; do not shrink all high-quality assets into small circular images inside cards or decorative thumbnails. Multiple images can form an overall relationship through cropping, overlapping, matrixing, sequencing, or local zoom.
- When choosing custom vectors as the primary visual grammar, let contours, proportions, connections, scale, or annotations express the specific information of the current subject; do not pass off generic icons, default process boxes, or decorative geometry as content. Complex vector figures should likewise have a clear visual focus and a thumbnail memory point.
- When mixing imagery and vectors, define the division of labor clearly: imagery carries object evidence, materials, people, or environments; vectors carry relationships, paths, scale, legends, and annotations — and anchor them to each other within the same composition, rather than splitting into two unrelated blocks above and below.
- Use self-owned, licensed, officially citable, or generated images. Do not forge real magazines, institutions, brand logos, issue numbers, watermarks, or attribution.
- AI images must not pose as historical archives, scientific evidence, or real data. Label them "AI-generated illustration" when necessary.

## Editable Delivery and Verification

- Keep text, shapes, connectors, data labels, and legends as editable PPTD elements as much as possible; do not merge the entire infographic into a single bitmap.
- When the user only wants images such as PNG or JPG, still complete the editable source in PPTD first, then screenshot or render it to an image.
- Check out-of-bounds, overflow, overlap, and structural issues against the pptd format rules; visually review focus, reading order, contrast, font sizes, and image cropping.
- Look at the full-page overview first, then the details: the overview should reveal the subject and at least one visual memory point; if the main impression is a title, regular cards, and button-like color blocks, restructure first instead of only fine-tuning font sizes and spacing.
- After fixing problem pages, validate and review again, and only then package the PPTX or output images.

## Pre-Production Checklist

- Have you explored different directions based on the subject and written a specific, actionable `style.md` in the project?
- Do the canvas ratio and orientation fit the user's requirements, the deployment scenario, the content structure, and the reading order?
- Are the core message, primary visual focus, and dominant visual grammar clear?
- Did you actually compare hero-image or structure-diagram candidates before finalizing, and does the chosen asset/figure truly enter the main composition?
- Is there a poster-level visual move recognizable at thumbnail size, rather than an ordinary content page, card wall, or app interface?
- Do the map, timeline, routes, flowcharts, matrix, and index genuinely express core relationships, rather than serving as decoration or density filler?
- Do the colors, fonts, image treatment, composition, and graphic language come from the current subject, rather than defaulting to reusing the previous poster case?
- Are facts, data, dates, locations, units, captions, sources, and copyright boundaries complete and verifiable?
- Are body text, annotations, and legends readable at the actual output size, without relying on extremely small fonts to cram in information?
- Does the visual result in the screenshot truly match `style.md`, rather than merely passing the syntax check?
