# PPTD Format Specification

PPTD (PPT-DSL) is a YAML abstraction layer for PowerPoint presentations, used to describe, generate, and edit slides in an AI-friendly way, with lossless bidirectional conversion to and from PPTX

---

## Conventions in This Document
- Uses **TS interfaces** to describe structures, with **field tables** and **minimal YAML examples** to aid understanding
- **Default values** are annotated in TS end-of-line comments as `// default: X`. X may be a literal (`1` / `"top"` / `[0, 0]`) or a descriptive phrase (`not applied` / `not shown` / `falls back along the inheritance chain` / `auto-adapts to chart size`, etc.)
- **Constraints** are annotated in TS end-of-line comments or below the TS block as `// constraint: ...`, uniformly using interval or inequality notation (`[0, 1]` / `> 0`) or textual descriptions
---

## 1. Global Conventions

### Syntax
- Uses **YAML 1.2** syntax
- For special characters such as `:`, `#`, `{`, `}`, the value must be wrapped in quotes or written with a block scalar instead
- For fields with many special characters such as `content.text`, a block scalar (`|`) should be used as its own block, to prevent content like `style="..."` from being parsed incorrectly

### Coordinate System and Units
- All geometry and size units are **px**; the origin `(0, 0)` is the top-left corner of the page
- Default presentation sizes: 16:9 → `[960, 540]`; 4:3 → `[720, 540]`. Default poster sizes: 16:9 → `[1280, 720]`; 9:16 → `[720, 1280]`; 4:3 → `[1280, 960]`; 3:4 → `[960, 1280]`; 1:1 → `[1080, 1080]`
- This specification defines 1px = 1pt (i.e., `fontSize: 18` is 18pt in PPTX)
- Element stacking order is determined by the order of the `Page.elements` array; the later an element, the higher its layer

### Style Priority and Default Values

For property values that conflict, the first source with a value is found by searching the following priorities from top to bottom; when none of the levels is set, fall back to the default values at the end of that section.

> The following rule applies to all subsections of this section: `lineHeight` (a multiple) and `lineHeightPx` (fixed px) are mutually exclusive; when both are set, `lineHeightPx` takes precedence.

#### 1. Text Styles Inside a Text Box

**Priority chain:**
1. Rich-text semantic tags such as `<u>`, `<sup>`, `<strong>` in [Text.content.text](#textcontent)
2. Inline properties set in `<span style="...">`
3. Paragraph properties set in `<p style="...">`
4. **Style fields set directly on [Text.content](#textcontent)** (distinct from the theme style referenced by `style`; including `color`, `fontSize`, `fontFamily`, `bold`, `italic`, `backgroundColor`, `lineHeight`, `lineHeightPx`, `letterSpacing`, `marginTop`)
5. The [TextStyleConfig](#textstyleconfig) theme style referenced by [Text.content.style](#textcontent)
6. Default values:

| Property | Default value |
|---|---|
| color | `#000000` |
| backgroundColor | Not applied |
| fontSize | `18` |
| fontFamily | `"MiSans"` |
| bold | `false` |
| italic | `false` |
| lineHeight | `1` |
| lineHeightPx | Not applied |
| letterSpacing | `0` |
| marginTop | `0` |

#### 2. Table Cell Styles

**Priority chain:**
1. Rich-text semantic tags such as `<u>`, `<sup>`, `<strong>` in [Cell.text](#cell)
2. Inline properties set in `<span style="...">`
3. Paragraph properties set in `<p style="...">`
4. [Cell](#cell) inline fields
5. The [TextStyleConfig](#textstyleconfig) referenced by [Cell.textStyle](#cell) (**applies only to text fields**; does not include `fill` / `border` / `align`)
6. Position-category styles of [TableStyleConfig](#tablestyleconfig)
   - On row vs column conflicts, [TableStyleConfig.rowOverColumn](#tablestyleconfig) decides the winner; default `true` = row wins
   - Row categories: `TableStyleConfig.firstRowStyle` / `TableStyleConfig.lastRowStyle`
   - Column categories: `TableStyleConfig.firstColumnStyle` / `TableStyleConfig.lastColumnStyle`
7. [TableStyleConfig.bodyStyles](#tablestyleconfig): applies to data rows other than the first and last rows, cycled by data-row index
8. [TableStyleConfig.cellStyle](#tablestyleconfig): the baseline cell style for the whole table
9. Default values

| Property | Default value |
|---|---|
| color | `#000000` |
| backgroundColor | Not applied |
| fontSize | Auto-adapts based on cell height |
| fontFamily | `"MiSans"` |
| bold | `false` |
| italic | `false` |
| lineHeight | `1` |
| lineHeightPx | Not applied |
| letterSpacing | `0` |
| marginTop | `0` |
| fill | Not applied (transparent) |
| border | `{style: solid, width: 1, color: "#000000"}` |
| align | `["center", "middle"]` |

#### 3. Chart Styles

Charts involve multiple kinds of styles (series body colors, fonts, data labels, axis/legend visibility, etc.), each with its own independent priority chain, explained below.

**3.1 Series body color priority chain:**
1. A series' explicit `fill` / `lineColor` / `areaColor` (field names differ per type; see [Color Mechanism](#52-color-mechanism))
2. The same-named field for the corresponding type in [Chart.seriesDefaults](#seriesdefaults)
3. The [Theme.colors](#theme) theme color cycle (colors are picked in the order the series appear in the array)

> [scatter](#scatter) is an exception: marker color resolves as `marker.fill > series.fill > theme color cycle`; marker.border likewise takes precedence over series.border.
>
> For each type's specific color fields, derivation rules, and role mappings, see [§5.2 Color Mechanism](#52-color-mechanism).

**3.2 Font priority chain:**
1. Sub-component `fontFamily` ([TitleConfig](#titleconfig) / [LegendConfig](#legendconfig) / [DataLabelConfig](#datalabelconfig) / [AxisConfig.label](#axisconfig) / [SpokeAxisConfig.label](#spokeaxisconfig))
2. [Chart.fontFamily](#chart)
3. Theme default ([Theme](#theme) or the PPTX master font)

**3.3 dataLabels priority chain:**
1. `series[i].dataLabels`
2. [Chart.dataLabels](#chart) (global default)
3. Not shown (equivalent to `show: false`)

> Sub-fields follow a **one-level shallow merge**: `series.dataLabels` only overrides the sub-fields it explicitly provides; unprovided ones fall back from [Chart.dataLabels](#chart); if neither provides them, the per-type default applies (see [dataLabels.content value quick reference](#55-datalabelscontent-value-quick-reference)).

**3.4 `seriesDefaults` merge rules:**

[Chart.seriesDefaults](#seriesdefaults)`[type]` provides common defaults for all series of that type, merged with each series via a **one-level deep merge**:
- **Scalar fields** (string / number / boolean): the series' explicit value overrides defaults
- **Object fields** (`marker` / `dataLabels` / `border` / `upBars` / `downBars` / `totalBars` / gradient `fill` objects, etc.): recursive one-level shallow merge — same-named fields of defaults and series are spread respectively, with sub-fields overridden by the nearest source
- **Array fields** (`fill: []` / `colorScheme: []`): the series replaces defaults as a whole, with no element-level merging
- `type` and `encode` are not allowed inside seriesDefaults
- Only multi-series types support seriesDefaults: `bar / line / area / scatter / bubble / candlestick / radar`

Counterintuitive example:
```yaml
seriesDefaults:
  bar: {marker: {shape: circle, size: 8}}
series:
  - type: bar
    marker: {size: 12}     # after merge: {shape: circle, size: 12}, not {size: 12}
```

**3.5 `boolean | Config` field convention:**

Fields of the form `boolean | XxxConfig` (`marker` / `legend` / `AxisConfig.label / axisLine / gridLine` / `SpokeAxisConfig.label / axisLine / gridLine` / `colorbar`) uniformly follow:
- `false` = off
- `true` = on with default configuration
- Object `{...}` = on + custom configuration

> **The only exception**: [scatter.marker](#scatter) cannot be `false` (a scatter plot without a marker has nothing to render).

---

### Multi-File Structure
A PPTD project consists of a main entry file and individual page files:
```
project/
  slides_name.pptd     # main entry (size/theme/title + page reference list)
  media/               # media resources such as images and videos
  pages/               # page file directory
    1_cover.page       # one .page file per page
    2_intro.page
```
**Path rules:**
1. **Fully self-contained**: all referenced files must be located inside the folder containing the `.pptd` file; **referencing files outside the directory is not allowed**
2. **Only relative paths are supported** (relative to the directory containing the `.pptd` file):
   - The `pages` list in `.pptd`: `pages/1_cover.page`
   - Image paths in `.page`: `media/image1.jpg`
3. **Media supports URLs**: `Image.src`, and the [ImageFill](#fill).src of `background` / `fill`, may be `https://...` (only jpg/jpeg/png/gif supported)

**Main entry is required:** everything must be loaded through the `.pptd` main entry file; a `.page` cannot be passed alone to the `convert`/`check` commands

---

## 2. Shared Types
The following types are reused in multiple places and are defined together up front. Element sections reference them by type name without repeating the expansion

### Color
```ts
type Color = string;
```
> Supports opaque **HEX6** (`#RRGGBB`), alpha **HEX8** (`#RRGGBBAA`), and [Theme.colors](#theme) theme color references (e.g. `$primary`)

### FontFamily
```ts
type FontFamily = string | { latin: string; ea: string };
```
| Form | Example | Description |
|------|------|------|
| String | `"MiSans"` | Chinese and English use the same font uniformly |
| Object | `{latin: "Arial", ea: "MiSans"}` | Explicitly specify Latin (latin) and East Asian (ea) fonts separately |

See [fonts.md](./fonts.md) for the list of available fonts

### Alignment
```ts
type HorizontalAlign = "left" | "center" | "right" | "justify" | "distributed";
type VerticalAlign   = "top"  | "middle" | "bottom";
type Alignment       = [HorizontalAlign, VerticalAlign];
```
| Value | Description |
|----|------|
| `left` / `center` / `right` | Horizontal left / center / right alignment |
| `justify` | Justified (last line not stretched) |
| `distributed` | Distributed (last line stretched) |
| `top` / `middle` / `bottom` | Vertical top / middle / bottom alignment |

### LineStyle
```ts
type LineStyle = "solid" | "dash" | "dot";
```

### Border
```ts
interface Border {
  style?: LineStyle;  // default: "solid"
  width?: number;     // default: 1
  color?: Color;      // default: "#000000"
}
```

#### BorderSpec
[Cell](#cell) and [CellStyle](#cellstyle) support an array form of `Border` to set the four side borders separately

```ts
type BorderSpec = null
                | Border
                | [Border | null, Border | null]
                | [Border | null, Border | null, Border | null, Border | null];
```

| Form | Meaning |
|------|------|
| `null` | Explicit clear: no border on any of the four sides (used to override a border set higher up the inheritance chain)|
| `Border` | Same on all four sides |
| Two-element array `[Border\|null, Border\|null]` | `[top-bottom, left-right]` |
| Four-element array `[Border\|null, Border\|null, Border\|null, Border\|null]` | `[top, right, bottom, left]` (clockwise) |

> A `null` inside the array means no border at the corresponding position; a top-level `null` clears everything.

### Shadow

```ts
interface Shadow {
  blur: number;                // blur radius
  color: Color;
  offset?: [number, number];   // default: [0, 0]; [x, y] offset
}
```

### ColorStop

```ts
interface ColorStop {
  position: number;  // constraint: [0, 1]
  color: Color;
}
```

### ImageFit / ImageCrop

```ts
interface ImageFit {
  mode: "fill" | "contain" | "cover";
}

interface ImageCrop {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}
```

> **Constraint:** the four fields of `ImageCrop` are analogous, default 0. A positive value crops inward from the corresponding edge proportionally (inset); a negative value expands outward toward the corresponding edge proportionally and pads with transparent pixels (outset). Must ensure `left + right < 1` and `top + bottom < 1`, otherwise the source rectangle degenerates.

| ImageFit.mode | Description |
|---|---|
| `cover` | Fills the container, keeps aspect ratio, may crop |
| `contain` | Shows the image completely, keeps aspect ratio, may leave blank space |
| `fill` | Stretches to fill, may distort |

### Fill

```ts
type Fill = SolidFill | GradientFill | ImageFill;

interface SolidFill {
  type: "solid";
  color: Color;
}

interface GradientFill {
  type: "gradient";
  gradientType: "linear" | "radial";
  stops: ColorStop[];                // constraint: at least 2
  angle?: number;                    // default: 0; only effective for linear
}

interface ImageFill {
  type: "image";
  src: string;                       // URL or relative path
  fit?: ImageFit;                    // default: {mode: "cover"}
  crop?: ImageCrop;                  // always applied; see the rendering order with fit below
  opacity?: number;                  // default: 1; constraint: [0, 1]
}
```

> `GradientFill.angle` takes values in `[0, 360)`; `0` means left to right, increasing clockwise. Examples: `90` = top→bottom, `180` = right→left.

> **ImageFill rendering order:** `crop` (adjust the source rectangle proportionally: positive values crop inward, negative values expand outward and pad with transparent pixels) → `fit` (adapt to the fill container per mode). The specific semantics of each `fit.mode` value are consistent with the "rendering logic" discussion in the [Image](#image-image) section.

**Examples:**

```yaml
# Solid
fill:
  type: solid
  color: "$primary"

# Gradient
fill:
  type: gradient
  gradientType: linear
  angle: 90
  stops:
    - {position: 0, color: "$primary"}
    - {position: 1, color: "$accent"}

# Image
fill:
  type: image
  src: "media/bg.jpg"
  fit: {mode: cover}
  opacity: 0.9
```

---

## 3. Main Entry File (.pptd)

### Presentation

```ts
interface Presentation {
  version: "v2";                // required, fixed to "v2" (version identifier)
  title?: string;              // default: no title
  customFonts?: CustomFont[];  // default: no custom fonts are loaded
  size: [number, number];      // [width, height]; see "Coordinate System and Units" for PPT and poster recommendations
  theme?: Theme;
  pages: string[];             // list of relative paths to page files, e.g. "pages/cover.page"
}
```

**Example:**

```yaml
version: v2
title: Annual Work Summary
size: [960, 540]
customFonts:
  - family: Noto Serif SC
    src: "https://fonts.googleapis.com/css2?family=Noto+Serif+SC"
theme:
  colors:
    primary: "#2563EB"
    accent: "#F59E0B"
    text: "#1F2937"
  textStyles:
    title:
      fontSize: 40
      color: "$primary"
    body:
      fontSize: 18
      color: "$text"
      lineHeight: 1.6
  tableStyles:
    default:
      firstRowStyle:
        fill: {type: solid, color: "$primary"}
        color: "#ffffff"
        bold: true
      bodyStyles:
        - {fill: {type: solid, color: "#f8fafc"}}
        - {fill: {type: solid, color: "#ffffff"}}
pages:
  - pages/1_cover.page
  - pages/2_content.page
```

### Theme

The theme centrally manages colors, text styles, and table styles. Use `$<key>` in relevant fields to reference the theme:

| Theme type | Referencing field | Example |
|---|---|---|
| `colors` | Any [Color](#color) field | `$primary` |
| `textStyles` | [TextContent.style](#textcontent) / [Cell.textStyle](#cell) | `$title` |
| `tableStyles` | [Table.style](#table-table) | `$default` |

```ts
interface Theme {
  colors?: Record<string, Color>;
  textStyles?: Record<string, TextStyleConfig>;
  tableStyles?: Record<string, TableStyleConfig>;
}
```

#### TextStyleConfig

```ts
interface TextStyleConfig {
  color?: Color;
  fontSize?: number;
  fontFamily?: FontFamily;
  bold?: boolean;                    // bold
  italic?: boolean;                  // italic
  backgroundColor?: Color;           // text background color (e.g., text highlight)
  lineHeight?: number;               // line-height multiple
  lineHeightPx?: number;             // fixed line height (px); when it conflicts with lineHeight, lineHeightPx prevails
  letterSpacing?: number;
  marginTop?: number;
}
```

> Unset fields fall back along the inheritance chain (see [Style Priority and Default Values](#style-priority-and-default-values) for details)

#### CellStyle

```ts
interface CellStyle extends TextStyleConfig {
  // —— Inherits all properties of TextStyleConfig ——
  //   color / fontSize / fontFamily / bold / italic / backgroundColor / lineHeight / lineHeightPx / letterSpacing / marginTop

  // —— CellStyle-specific ——
  fill?: Fill;                              // background fill
  border?: BorderSpec;                      // border
  align?: Alignment;                        // text alignment
}
```

> Unset fields fall back along the inheritance chain (see [Style Priority and Default Values](#style-priority-and-default-values) for details)

#### TableStyleConfig

```ts
interface TableStyleConfig {
  // —— Cell style: applied to every cell ——
  cellStyle?: CellStyle;

  // —— Row category overrides ——
  firstRowStyle?: CellStyle;  // first-row style
  lastRowStyle?: CellStyle;  // last-row style

  // —— Column category overrides ——
  firstColumnStyle?: CellStyle;
  lastColumnStyle?: CellStyle;

  // —— Alternating row styles ——
  bodyStyles?: CellStyle[];  // data rows other than the first/last row apply these cyclically by data-row index

  // —— Cross-category rule ——
  rowOverColumn?: boolean;            // default: true; whether the row style wins when a cell is covered by both row and column rules
}
```
> **Row/column style rules**: category styles such as `firstRowStyle` / `lastRowStyle` / `firstColumnStyle` / `lastColumnStyle` mean **apply the style independently to every matching cell**, not apply the style to the first row/last column as a whole
> - Writing `firstRowStyle.border: {style: solid, width: 2}` → **every cell of the first row** gets a border on all four sides
> - To add an outer frame to the first row as a whole, use per-side BorderSpec: `border: [<top line>, null, <bottom line>, null]`, then set borders separately on the first-column and last-column cells of the first row


> For fallback rules, see [Style Priority and Default Values](#style-priority-and-default-values)

### CustomFont

```ts
interface CustomFont {
  family: string;  // font family name for use in fontFamily fields
  src: string;     // Google Fonts CSS URL; format: https://fonts.googleapis.com/css2?family=Noto+Serif+SC; only the default weight is supported — weight selection is not supported
}
```

---

## 4. Page Files (.page)

### Page

```ts
interface Page {
  pageType?: "cover" | "table_of_contents" | "chapter" | "content" | "final" | string;  // default: none; category label (does not affect rendering); preset values are recognized as the corresponding page type, arbitrary custom strings are also allowed
  background?: Fill;               // default: {type: solid, color: "#FFFFFF"} (white solid fill)
  notes?: string;                  // default: none; speaker notes; plain text
  elements: Element[];             // the later an element, the higher its layer
  animations?: Animation[];        // default: none; orchestrated in array order; see [Animations](#6-animations)
}
```

**Example:**

```yaml
pageType: cover
background:
  type: solid
  color: "$primary"
notes: Speaker notes
elements:
  - elementId: title1
    elementType: text
    bounds: [100, 200, 760, 80]
    content:
      style: "$title"
      align: [center, middle]
      text: Hello World
```

---

## 5. Elements

### ElementBase

Common properties of all elements.

```ts
interface ElementBase {
  elementId: string;                                                      // constraint: unique within the same page; unique element ID
  elementType: "text" | "shape" | "line" | "image" | "icon" | "table" | "chart";  // element type
  bounds: [number, number, number, number];                               // element size and position, [x, y, width, height]
}

type Element = Text | Shape | Line | Image | Icon | Table | Chart;
```

---

### Text (text box)

```ts
interface Text extends ElementBase {
  elementType: "text";
  rotation?: number;                  // default: 0; degrees, clockwise rotation
  opacity?: number;                   // default: 1; constraint: [0, 1]
  flip?: [boolean, boolean];          // default: [false, false]; [horizontal flip, vertical flip]
  content: TextContent;
}
```

#### TextContent

```ts
interface TextContent {
  text: string;                                // rich text string (block scalar)
  style?: string;                              // references theme.textStyles, written as "$key" (e.g. "$title")

  // —— Style fields (when unset, fall back along the inheritance chain) ——
  color?: Color;
  fontSize?: number;
  fontFamily?: FontFamily;
  bold?: boolean;                              // bold: true=on, false/unset=off
  italic?: boolean;                            // italic: true=on, false/unset=off
  backgroundColor?: Color;                     // text background color (e.g., text highlight)
  lineHeight?: number;                         // line-height multiple
  lineHeightPx?: number;                       // fixed line height (px)
  letterSpacing?: number;
  marginTop?: number;

  // —— Layout fields ——
  textDirection?: "horizontal" | "vertical";   // default: "horizontal"
  wrap?: boolean;                              // default: true; when false, no wrapping, and the part beyond bounds.width overflows the element boundary; explicitly setting false is recommended for single-line text
  align?: Alignment;                           // default: ["left", "top"]

  // —— Visual decoration (unset = not applied) ——
  gradient?: GradientFill;                     // text gradient (applied to the text itself)
  shadow?: Shadow;                             // text shadow
}
```

**Examples:**

```yaml
# Basic: theme style + plain text
- elementId: title-1
  elementType: text
  bounds: [100, 50, 760, 80]
  content:
    style: "$title"
    align: [center, middle]
    text: Annual Work Summary

# Rich text + inline property overrides
- elementId: body-1
  elementType: text
  bounds: [100, 200, 600, 200]
  content:
    fontSize: 20
    color: "$text"
    lineHeight: 1.6
    align: [left, top]
    text: |
      <p><strong>Key achievement</strong>: completed <span style="color:$primary;">3</span> key projects</p>
      <p style="text-align:right"><span style="font-size:14px; color:#6b7280;">—— FY2024</span></p>

# Text gradient + shadow
- elementId: hero-text
  elementType: text
  bounds: [100, 100, 760, 120]
  content:
    align: [center, middle]
    gradient:
      type: gradient
      gradientType: linear
      angle: 90
      stops:
        - {position: 0, color: "$primary"}
        - {position: 1, color: "$accent"}
    shadow:
      blur: 6
      color: "#00000040"
      offset: [0, 3]
    text: |
      <p><span style="font-size:64px;">FUTURE</span></p>
```

#### Rich Text Rules

`TextContent.text` and `Cell.text` follow the rich text rules below for paragraph splitting and for setting paragraph or inline styles.

**Supported tags**

| Tag | Description | Example |
|------|------|------|
| `<p>` | Paragraph; may carry paragraph styles | `<p>paragraph</p>` |
| `<span>` | Inline style; use this tag to set inline styles | `<span style="color:#f00">red</span>` |
| `<strong>` | Bold | `<strong>important</strong>` |
| `<em>` | Italic | `<em>emphasis</em>` |
| `<u>` | Underline | `<u>underline</u>` |
| `<s>` | Strikethrough | `<s>deleted</s>` |
| `<sup>` | Superscript | `E=mc<sup>2</sup>` |
| `<sub>` | Subscript | `H<sub>2</sub>O` |
| `<a>` | Hyperlink; supports `https://`, `http://`, `mailto:`; once set, the hyperlink text style (blue with underline) is applied automatically | `<a href="https://x.com">link</a>` |
| `<ul>` | Unordered list | `<ul><li>item</li></ul>` |
| `<ol>` | Ordered list | `<ol><li>first item</li></ol>` |
| `<li>` | List item; must be used together with `<ul>` or `<ol>` | — |

**style attribute mapping**

`<p>`, `<li>`, and `<span>` may use `style="..."`. Color-type values may all use theme references (e.g. `$primary`), resolved per the [Color](#color) rules.

1. **Paragraph styles (only `<p>` supports them)**

| Property | Description | Values | Example |
| --- | --- | --- | --- |
| `text-align` | Paragraph horizontal alignment | `left` / `center` / `right` / `justify` / `distributed` | `<p style="text-align:center">…</p>` |
| `line-height` | Line height; **unitless** is treated as a `lineHeight` multiple, **with `px`** as a `lineHeightPx` fixed value | number (e.g. `1.5`) or px string (e.g. `24px`) | `<p style="line-height:1.6">…</p>` |
| `margin-top` | Spacing before the paragraph | px string (e.g. `8px`) | `<p style="margin-top:8px">…</p>` |
| `margin-left` | Left margin | px string (e.g. `12px`) | `<p style="margin-left:12px">…</p>` |
| `margin-right` | Right margin | px string (e.g. `12px`) | `<p style="margin-right:12px">…</p>` |

> Do not set `letter-spacing` on `<p>`; to set letter spacing uniformly, use `content.letterSpacing` or `Cell.letterSpacing`.

2. **List-item styles (only `<li>` supports them)**

| Property | Description |
| --- | --- |
| `text-align` | List-item horizontal alignment |
| `line-height` | Line height; value rules same as `<p>` |
| `letter-spacing` | Letter spacing |
| `margin-top` | Spacing before the paragraph |
| `margin-left` | Left margin |
| `list-style` | List style shorthand |
| `list-style-type` | List marker type |
| `list-style-position` | List marker position |
| `list-style-image` | List marker image |

3. **Inline styles (only `<span>` supports them)**

Styles apply only to the text inside that `<span>`.

| Property | Description | Values | Example |
| --- | --- | --- | --- |
| `color` | Text color | [Color](#color) (HEX6 / HEX8 / theme reference) | `<span style="color:$primary">…</span>` |
| `font-size` | Font size | px string (e.g. `24px`) | `<span style="font-size:24px">…</span>` |
| `font-family` | Font family | Font name (e.g. `Arial`, `"Arial, 微软雅黑"`) | `<span style="font-family:Arial">…</span>` |
| `background-color` | Text background color | [Color](#color) (HEX6 / HEX8 / theme reference) | `<span style="background-color:$accent">…</span>` |


```yaml
content:
  align: [left, top]
  lineHeight: 1.2
  text: |
    <p><span style="font-size:32px; color:$primary;">Main Title</span><span style="font-size:18px; color:$secondary;">Subtitle</span></p>
    <p style="text-align:center; line-height:1.8">This paragraph is center-aligned with 1.8x line height</p>
    <p style="text-align:right">This paragraph is right-aligned; line height inherits the default 1.2</p>
```
**Plain-text shorthand**

`content.text` may use plain text directly:
- Single line: `text: "Hello"` ≡ `text: "<p>Hello</p>"`
- Multi-line (block scalar):
  ```yaml
  text: |
    First line
    Second line
  ```
  ≡ `<p>First line</p><p>Second line</p>`
- `<br/>` may be used for a line break within a paragraph, but it is not guaranteed to be preserved on re-conversion after editing. When stable line breaks are needed, use multiple `<p>`.

**LaTeX formulas**

Rich text supports embedding LaTeX formulas with the `\(...\)` delimiters:
- May form their own paragraph, or be mixed with other text inside a `<p>`.
- Rich text tags are **not allowed** inside a formula.
- A formula **only inherits** the `color` and `font-size` styles from its context; other text styles are not passed through.
- A `<p>` tag can wrap a LaTeX formula to control the alignment

```yaml
content:
  text: |
    <p>Pythagorean theorem: \(a^2 + b^2 = c^2\)</p>
    <p>\(\int_0^1 x^2 \mathrm{d}x = \frac{1}{3}\)</p>
```

---

### Shape (shape)

```ts
interface Shape extends ElementBase {
  elementType: "shape";
  rotation?: number;                  // default: 0; degrees, clockwise rotation
  opacity?: number;                   // default: 1; constraint: [0, 1]
  flip?: [boolean, boolean];          // default: [false, false]; [horizontal flip, vertical flip]
  shapeName: string;                  // see ./shapes.md
  adjustments?: number[];             // see ./shapes.md; geometry parameters; default: the default parameter values
  viewBox?: [number, number];         // view box; used only when shapeName="custom", required in that case
  path?: string;                      // SVG shape path; used only when shapeName="custom", required in that case
  fill?: Fill;                        // default: not applied
  border?: Border;                    // default: not applied
  shadow?: Shadow;                    // default: not applied
}
```

> Custom shapes: you may specify `shapeName: "custom"` and use `viewBox` and `path` to define a custom shape; these two parameters have no effect when `shapeName` is not `custom`

> The `adjustments` parameters: reuse the parameter order and quantity defined by OOXML; see ./shapes.md for value constraints.

> **Note**: `shape` does not support embedded text! Add an extra text box to achieve that.

**custom path conventions:**
- `viewBox`: view box, the path coordinate system `[w, h]`
- `path`: SVG path string, supporting the `M / L / H / V / C / S / Q / A / Z` commands.
- Multi-segment paths are supported for shapes such as hollow-outs: make the outer contour **clockwise** (`sweep=1`) and the inner contour **counterclockwise** (`sweep=0`) to achieve a hollow cutout
- **Scaling and aspect ratio**: changing `bounds` resizes the shape (the path needs no rewriting); but the viewBox is stretched independently to bounds — when the ratios differ, the shape distorts. To keep the ratio, require `viewBoxW : viewBoxH = bounds.w : bounds.h`.

**Common shapes**

> See [shapes.md](./shapes.md) for the full 177 shapes.

| shapeName | Description | adjustments default values |
|-----------|------|-------------------|
| `rect` | Rectangle | — |
| `roundRect` | Rounded rectangle | `[16667]` (corner radius) |
| `ellipse` | Ellipse | — |
| `triangle` | Triangle | `[50000]` (horizontal position of apex) |
| `diamond` | Diamond | — |
| `homePlate` | Five-sided arrow | `[50000]` |
| `chevron` | V-shaped arrow | `[50000]` |
| `donut` | Ring | `[25000]` (ring width ratio) |
| `star5` | 5-point star | `[19098, 105146, 110557]` |
| `rightArrow` | Right arrow | `[50000, 50000]` (shaft width, arrowhead length) |
| `wedgeRectCallout` | Rectangle callout | `[-20833, 62500]` |
| `bracePair` | Brace pair | `[8333]` |

**Examples:**

```yaml
# Built-in shape
- elementId: shape-1
  elementType: shape
  bounds: [200, 200, 300, 150]
  shapeName: roundRect
  adjustments: [20000]
  fill: {type: solid, color: "$primary"}
  border: {style: solid, width: 2, color: "$accent"}

# Custom hollow ring (outer contour clockwise + inner contour counterclockwise)
- elementId: shape-2
  elementType: shape
  bounds: [400, 200, 150, 150]
  shapeName: custom
  viewBox: [1000, 1000]
  path: "M500,0 A500,500 0 1 1 499,0 Z M500,200 A300,300 0 1 0 499,200 Z"
  fill: {type: solid, color: "$accent"}
```

---

### Line (line)

```ts
type ArrowType = "arrow" | "stealth" | "diamond" | "oval";

interface Line extends ElementBase {
  elementType: "line";
  rotation?: number;                             // default: 0; degrees, clockwise rotation
  opacity?: number;                              // default: 1; constraint: [0, 1]
  flip?: [boolean, boolean];                     // default: [false, false]; [horizontal flip, vertical flip]
  viewBox: [number, number];                     // path coordinate system [w, h]; points live in this coordinate system, so changing bounds does not require changing points
  points: string;                                // bezier path points "x1,y1 x2,y2 ..."; the first/last points are the start/end the curve passes through, the middle points are control points
  curve?: "sharp" | "round" | "smooth";          // default: "round"; sharp joins / rounded joins / bezier smooth curve
  arrow?: [ArrowType | null, ArrowType | null];  // start arrow, end arrow; default: [null, null] (no arrows at either end)
  border?: Border;                               // default: not applied
  shadow?: Shadow;                               // default: not applied
}
```

> **Constraint:** `points` needs at least 2 points; the first point and the last point are points the curve passes through, the rest are bezier control points; all coordinates must be within `viewBox`.
> **viewBox vs bounds:** at render time, the viewBox is stretched independently to the bounds size; to keep the line from being stretched out of shape, require `viewBoxW : viewBoxH = bounds.w : bounds.h`.

**Examples:**

```yaml
# Normalized coordinates: from top-left to bottom-right, the two middle points are control points
- elementId: l4
  elementType: line
  bounds: [100, 100, 500, 300]
  viewBox: [1, 1]
  points: "0,0 0.2,0 0.8,1 1,1"
  curve: smooth
  border: {style: solid, width: 2, color: "$primary"}

# Bezier arc: passes through the start and end points; the two middle points control the bend direction
- elementId: bezier-arc
  elementType: line
  bounds: [50, 200, 860, 100]
  viewBox: [360, 100]
  points: "0,80 120,0 240,100 360,20"
  curve: smooth
  border: {style: solid, width: 2, color: "$primary"}
```

---

### Image (image)

```ts
interface Image extends ElementBase {
  elementType: "image";
  rotation?: number;                 // default: 0; degrees, clockwise rotation
  opacity?: number;                  // default: 1; constraint: [0, 1]
  flip?: [boolean, boolean];         // default: [false, false]; [horizontal flip, vertical flip]
  src: string;                       // URL or local relative path
  cropShape?: ShapeDef;              // default: rectangle (i.e., no shape cropping)
  fit?: ImageFit;                    // default: {mode: "cover"}
  crop?: ImageCrop;                  // always applied; see the rendering order with fit/cropShape below
  border?: Border;                   // default: not applied
  shadow?: Shadow;                   // default: not applied
}

interface ShapeDef {
  shapeName: string;                 // see ./shapes.md; use "custom" for a custom path
  adjustments?: number[];            // default: use the shape's built-in defaults (see ./shapes.md)
  viewBox?: [number, number];        // used only when shapeName="custom", required in that case
  path?: string;                     // used only when shapeName="custom", required in that case
}
```

> `ShapeDef` fields correspond one-to-one with the shape fields of the [Shape](#shape-shape) element; for detailed conventions (adjustments values and angle conversion, custom path rules, hollow rules, common shape table), see the [Shape](#shape-shape) section.

**Rendering logic:** `crop` (proportionally adjust the source rectangle to get a sub-image: positive values crop inward, negative values expand outward and pad with transparent pixels) → `fit` (adapt the sub-image to the bounds container per mode) → `cropShape` (clip the final display area to the shape outline). All three can be set independently and are applied in the fixed order above.

- `fit.mode="cover"`: scale the sub-image proportionally to fill bounds; the overflow is cropped.
- `fit.mode="contain"`: scale the sub-image proportionally to display it completely; the shortfall is left blank.
- `fit.mode="fill"`: **the sub-image is stretched directly to fill bounds** — although no cropped blank edges are visible in this case, the picture content is still only the sub-region after crop, not the full original image.

**Examples:**

```yaml
- elementId: img-1
  elementType: image
  bounds: [50, 50, 400, 300]
  src: "media/cover.jpg"
  cropShape: {shapeName: roundRect, adjustments: [15000]}
  fit: {mode: cover}
  crop: {top: 0.1, bottom: 0.1, left: 0.05, right: 0.05}   # crop the surrounding proportions first, then apply cover fitting
  shadow:
    blur: 10
    color: "#00000033"
    offset: [0, 4]

# Custom clip outline
- elementId: img-2
  elementType: image
  bounds: [200, 200, 200, 200]
  src: "media/avatar.jpg"
  cropShape:
    shapeName: custom
    viewBox: [1000, 1000]
    path: "M500,0 A500,500 0 1 1 499,0 Z"
  fit: {mode: cover}
```

---

### Icon (icon)

```ts
interface Icon extends ElementBase {
  elementType: "icon";
  rotation?: number;                 // default: 0; degrees, clockwise rotation
  opacity?: number;                  // default: 1; constraint: [0, 1]
  flip?: [boolean, boolean];         // default: [false, false]; [horizontal flip, vertical flip]
  iconName: string;                  // format "style:name"
  fill?: Fill;                       // default: black solid fill
  border?: Border;                   // default: not applied
  shadow?: Shadow;                   // default: not applied
}
```

**iconName format:** `style:name`, using the Font Awesome 7.x free icon library.

| Prefix | Style | Example |
|------|------|------|
| `fas` | Solid (most common) | `fas:house` |
| `far` | Regular | `far:heart` |
| `fab` | Brands | `fab:github` |

Icon search: https://fontawesome.com/search?ic=free-collection

**Example:**

```yaml
- elementId: icon-1
  elementType: icon
  bounds: [100, 100, 48, 48]
  iconName: "fas:lightbulb"
  fill: {type: solid, color: "$primary"}
```

---

### Table (table)

```ts
interface Table extends ElementBase {
  elementType: "table";
  columnWidths: number[];              // array of column-width ratios (not px; relative to the bounds width)
  rowHeights: number[];                // array of row-height ratios (not px; relative to the bounds height)
  rows: Cell[][];                      // 2-D array; merged regions are declared with rowSpan/colSpan, occupied positions are skipped in the array
  style?: string | TableStyleConfig;   // references theme.tableStyles, written as "$key" (e.g. "$default"), or an inline TableStyleConfig object
  fill?: Fill;                         // default: not applied; table-level fill (applied to the whole table, can be overridden by cell fill)
  shadow?: Shadow;                     // default: not applied
}
```

> **PowerPoint limitation:** native tables cannot be rotated/flipped as a whole; whole-table global opacity including text and borders is also not supported. When whole rotation/flip/opacity is needed, render as an image first and treat it as an [Image](#image-image) element.

> **Constraint:** each item of `columnWidths` and `rowHeights` is within `[0, 1]`, and the elements of each sum to 1.

#### Cell

```ts
interface Cell {
  // —— Content ——
  text?: string;             // default: empty cell; rich text string (written as a block scalar), rules same as TextContent.text
  textStyle?: string;        // references theme.textStyles, written as "$key" (e.g. "$body")

  // —— Text styles (when unset, fall back along the inheritance chain) ——
  color?: Color;
  fontSize?: number;
  fontFamily?: FontFamily;
  bold?: boolean;
  italic?: boolean;
  backgroundColor?: Color;             // text background color (e.g., text highlight)
  lineHeight?: number;                 // line-height multiple
  lineHeightPx?: number;               // fixed line height (px)
  letterSpacing?: number;
  marginTop?: number;

  // —— Cell styles (when unset, fall back along the inheritance chain) ——
  fill?: Fill;                         // background fill; supports solid / gradient / image
  border?: BorderSpec;
  align?: Alignment;

  // —— Merging ——
  rowSpan?: number;                    // default: 1
  colSpan?: number;                    // default: 1
}
```

**Basic example (using theme styles):**

```yaml
- elementId: table-basic
  elementType: table
  bounds: [80, 120, 800, 280]
  columnWidths: [0.3, 0.35, 0.35]
  rowHeights: [0.33, 0.33, 0.34]
  style: "$default"
  rows:
    - - text: "Metric"
      - text: "2023"
      - text: "2024"
    - - text: "Revenue (100M CNY)"
      - text: "82.5"
      - text: "96.3"
    - - text: "Net profit (100M CNY)"
      - text: "12.1"
      - text: "15.8"
```

> **Merged-cell rules:** `rowSpan` / `colSpan` declare the merge range; **cells covered by the merged region are omitted from the `rows` array, with no `null` placeholder needed**. For example, after a top-left 2×2 merge, row 0's colSpan=2 covers (0,1), so that row only has two items ((0,0) merged cell + (0,2)); row 1 has (1,0) and (1,1) occupied by the merge, so it only has one item, (1,2).

```yaml
- elementId: table-merged
  elementType: table
  bounds: [100, 100, 600, 400]
  columnWidths: [0.33, 0.33, 0.34]
  rowHeights: [0.33, 0.33, 0.34]
  rows:
    # Row 0: top-left 2×2 merge + C1. The merged (0,1) is omitted
    - - text: "Merged cell"
        fill: {type: solid, color: "$accent"}
        rowSpan: 2
        colSpan: 2
      - text: "C1"
    # Row 1: (1,0) and (1,1) are occupied by the merge → only C2 remains
    - - text: "C2"
    # Row 2: full three columns
    - - text: "A3"
      - text: "B3"
      - text: "C3"
```

---

### Chart (charts)

PPTD v2's chart element follows the ECharts philosophy: **the chart top level carries no `type` field**; each `series[i].type` determines its own form. 13 series types are supported in total, laid out flat by type name, all equal in status:

`bar` / `line` / `area` / `scatter` / `bubble` / `candlestick` / `pie` / `radar` / `waterfall` / `heatmap` / `treemap` / `sunburst` / `sankey`

Each type declares its **series constraint** on the first line of its own subsection: the maximum count allowed within the same chart + which other types it may coexist with.

#### Chart

```ts
interface Chart extends ElementBase {
  elementType: "chart";

  data: ChartData;                            // required
  series: SeriesConfig[];                     // required; constraint: length ≥ 1
  seriesDefaults?: SeriesDefaults;            // default: not applied; common defaults grouped by series.type, merged with each series

  // —— Cartesian coordinate system (conditionally effective by series.type, see §5.3) ——
  xAxis?: AxisConfig | AxisConfig[];          // default: auto-adapt to data; in array form, referenced via series[i].xAxisIndex
  yAxis?: AxisConfig | AxisConfig[];          // default: auto-adapt to data; in array form, referenced via series[i].yAxisIndex
  barWidth?: number;                          // default: adaptive; constraint: (0, 1]; bar width / category slot width ratio
  barGap?: number;                            // default: 0 (flush); constraint: [0, 1); gap between bars when multiple bar series are grouped
  categoryGap?: number;                       // default: 0.2; constraint: [0, 1); blank ratio between category slots

  // —— Radar coordinate system (radar series only) ——
  spokeAxis?: SpokeAxisConfig;                // default: auto-adapt to data; spoke axes + spider grid

  // —— Global components ——
  title?: string | TitleConfig;               // default: no title
  legend?: boolean | LegendConfig;            // default: varies by type (see the default-value table in [LegendConfig](#legendconfig))
  dataLabels?: DataLabelConfig;               // default: not applied; global default, can be overridden by series.dataLabels
  fontFamily?: FontFamily;                    // default: falls back along the theme/master fonts

  // —— Chart frame (controls the rectangular container of the whole chart element, independent of series colors) ——
  fill?: Fill;                                // default: not applied
  border?: Border;                            // default: not applied
  shadow?: Shadow;                            // default: not applied
}

type SeriesConfig =
  | BarSeries | LineSeries | AreaSeries | ScatterSeries | BubbleSeries
  | CandlestickSeries | PieSeries | RadarSeries | WaterfallSeries
  | HeatmapSeries | TreemapSeries | SunburstSeries | SankeySeries;
```

> `fill` / `border` / `shadow` control the **chart element's rectangular frame** (acting on the whole chart container), independent of the series body colors.
>
> **PowerPoint limitation:** native charts cannot be rotated/flipped as a whole; there is also no single global opacity property covering "the whole chart including title, axes, legend, labels, and series". When whole rotation/flip/opacity is needed, render as an image first and treat it as an [Image](#image-image) element.

#### ChartData

```ts
interface ChartData {
  cols: string[];                                   // column names; constraint: unique, non-empty strings
  rows: (number | string | null)[][];               // constraint: each row's length = cols.length
}
```

> **Data integrity constraints** (validated by the checker):
> - Duplicate column names in `cols` → `DuplicateColumnError`
> - `cols` contains an empty string → `EmptyColumnError`
> - `rows[i].length !== cols.length` → `RowLengthError`
> - A column name referenced by encode is not in `cols` → `UnknownColumnError`
> - It is legal for the same column to be referenced by multiple series (e.g., the same y column drawn once by bar and once by line)
> - When a column value of a numeric channel (`y` / `value` / `open` / `high` / `low` / `close` / `size` / `flow`) is a string, it is parsed as a number; on failure, `NonNumericValueError` is raised
>
> **How to write missing cells**: fill with `null`, e.g. `[null, null, 2, 3]`. Consecutive commas `[, , 2, 3]` are **not recommended** — strict YAML parsers will error.

#### General Rules

1. **The `fill` type of series**: `Color | GradientFill`; a string is treated as a solid [Color](#color) (HEX8 or a `$xxx` theme reference), an object as [GradientFill](#fill) (with `type: "gradient"`); some types support the `(Color | GradientFill)[]` array form (cycled by slice/node). **Series-level fill does not support [ImageFill](#fill)**.
2. **Type mixing**: which types a chart's `series[]` may contain is determined by the "series constraint" on the first line of each type's section; the checker validates accordingly.
3. **Conditionally effective top-level fields**: `xAxis` / `yAxis` / `barWidth` / `barGap` / `categoryGap` / `spokeAxis` are **coordinate-system-level** configurations, conditionally effective based on the `series[].type` set (see [5.3 Applicability of chart top-level fields](#53-applicability-of-chart-top-level-fields) for details).
4. **[Color](#color) theme reference scope**: all fields of type `Color` (including every Color position inside nested arrays and objects) support `$xxx` theme references — e.g. `upBars: {fill: "$success"}`, `colorScheme: ["$bg", "$primary"]`, `fill: ["$primary", "$accent"]`.
5. **Omission semantics of optional object-type fields**: all **object-type** fields marked with `?` (`xAxis` / `yAxis` / `spokeAxis` / `colorScale` / `marker` / `dataLabels`, etc.): when omitted, they are equivalent to an empty configuration `{}` of that object, and all sub-fields take their own default values — i.e., "axes/grids/labels etc. still render by default, just with automatically inferred parameters". This differs from `fill` / `border` / `shadow` of [ElementBase](#elementbase) (where omission means **not applied**).

> **bar / waterfall direction**: determined by the axis type — vertical (default) when `xAxis.type === "category"`, horizontal when `yAxis.type === "category"`. `axis.type` is inferred from the data column by default (string → category, number → value); when a numeric column needs to be used as categories (e.g. years), override explicitly with `axis.type: "category"`. In the horizontal case, `encode.x` references the numeric column and `encode.y` the category column, and `numberFormat` is written on the side where the value axis is. For scatter / bubble, both x and y are numeric channels, with no notion of direction.

---

#### TextStyle

```ts
interface TextStyle {
  color?: Color;            // default: falls back along the inheritance chain (theme text color / PPTX master)
  fontSize?: number;        // default: auto-adapts to chart size
  fontFamily?: FontFamily;  // default: falls back along the inheritance chain to Chart.fontFamily or the theme font
}
```

> The common trio of text styles, inherited and reused by [TitleConfig](#titleconfig) / [LegendConfig](#legendconfig) / [DataLabelConfig](#datalabelconfig) / [AxisConfig](#axisconfig).label / [SpokeAxisConfig](#spokeaxisconfig).label; for the font priority chain, see [§3.2](#3-chart-styles).

#### LineStyleConfig

```ts
interface LineStyleConfig {
  style?: "solid" | "dash" | "dot";    // default: "solid"
  color?: Color;                       // default: falls back to the theme
  width?: number;                      // default: 1
}
```

> Generic line style, reused by the `axisLine` / `gridLine` of [AxisConfig](#axisconfig) / [SpokeAxisConfig](#spokeaxisconfig).

#### TitleConfig

```ts
interface TitleConfig extends TextStyle {
  text: string;                        // required
  // fontSize auto-adapts to chart size by default
}
```

#### LegendConfig

```ts
interface LegendConfig extends TextStyle {
  show?: boolean;                      // default: varies by type (see the table below)
  position?: "top" | "bottom" | "left" | "right";  // default: "bottom"
}
```

`show` defaults by type:

| type | Default |
|---|---|
| bar / line / area / scatter / bubble / candlestick / pie / radar | `true` |
| waterfall | `false` |
| treemap / sunburst / sankey | `false` (names and values are already shown on the chart) |
| heatmap | Does not use `chart.legend` (controlled by [series.colorbar](#heatmap)) |

> `legend: false` or `legend: {show: false}` turns it off, **effective for all 13 types**; `legend: true` or the object form only has a visual effect for the types marked applicable in the table above.

#### DataLabelConfig

```ts
interface DataLabelConfig extends TextStyle {
  show?: boolean;                      // default: false
  content?: "value" | "percentage" | "category";  // default: varies by type (see [5.5 value quick reference](#55-datalabelscontent-value-quick-reference))
  numberFormat?: string;               // default: no formatting; Excel number-format string (see below)
}
```

> **numberFormat standard**: takes a subset of Excel number-format strings — `0` (integer) / `0.0` (one decimal) / `0%` (percentage) / `0.0%` (percentage with decimals) / `#,##0` (thousands separator) / `0.0E+00` (scientific notation). Advanced syntax such as `[Red]` color sections, negative sections, and conditional formatting is **not supported**.

#### MarkerConfig

```ts
interface MarkerConfig {
  shape?: "circle" | "rect" | "diamond" | "triangle";  // default: "circle"
  fill?: Color | GradientFill;         // default: follows the series body color
  border?: Border;                     // default: not applied
  size?: number;                       // default: auto-adapts to chart size; unit px
}
```

> The `rect` naming is consistent with the [shapes.md](./shapes.md) shape library.

#### AxisConfig

```ts
interface AxisConfig {
  show?: boolean;                      // default: true
  type?: "category" | "value";         // default: inferred from the data column (string → category, number → value)
  min?: number;                        // default: auto-adapt to data; only effective for value axes
  max?: number;                        // default: auto-adapt to data; only effective for value axes
  reverse?: boolean;                   // default: false; true = reverse the axis direction (maximum at the origin side)
  title?: string | TitleConfig;        // default: no title; the string form is recommended, use the object only for special styling
  label?: boolean | (TextStyle & {     // default: true; tick labels
    numberFormat?: string;             // default: no formatting; only effective for value axes
  });
  axisLine?: boolean | (LineStyleConfig & {  // default: true
    arrow?: boolean | "start" | "end" | "both";  // default: false; true is equivalent to "end"
  });
  gridLine?: boolean | LineStyleConfig;     // default: true
}
```

#### SeriesDefaults

```ts
interface SeriesDefaults {
  bar?: Partial<Omit<BarSeries, "type" | "encode">>;
  line?: Partial<Omit<LineSeries, "type" | "encode">>;
  area?: Partial<Omit<AreaSeries, "type" | "encode">>;
  scatter?: Partial<Omit<ScatterSeries, "type" | "encode">>;
  bubble?: Partial<Omit<BubbleSeries, "type" | "encode">>;
  candlestick?: Partial<Omit<CandlestickSeries, "type" | "encode">>;
  radar?: Partial<Omit<RadarSeries, "type" | "encode">>;
}
```

> Provides common default values for all series of that type, avoiding repetition across multiple series. For the merge algorithm and the range of usable types, see [§3.4](#3-chart-styles).

#### SpokeAxisConfig

Used only by [radar](#radar) series.

```ts
interface SpokeAxisConfig {
  show?: boolean;                      // default: true
  min?: number;                        // default: 0; minimum of the value axis shared by all dimensions
  max?: number;                        // default: auto-adapt to data; maximum of the value axis shared by all dimensions
  label?: boolean | (TextStyle & {     // default: true; tick labels
    numberFormat?: string;             // default: no formatting
  });
  axisLine?: boolean | LineStyleConfig;     // default: true; spoke lines from the center to the outer ring
  gridLine?: boolean | LineStyleConfig;     // default: true; spider grid lines (concentric polygons connecting the spoke endpoints)
}
```

#### LinearSeriesBase

Curve-class common fields shared by [line](#line) / [area](#area) / [radar](#radar).

```ts
interface LinearSeriesBase {
  smooth?: boolean;                                   // default: false
  lineStyle?: "solid" | "dash" | "dot";               // default: "solid"
  width?: number;                                     // default: 2
  marker?: false | MarkerConfig;                      // default: not applied
  nullHandling?: "zero" | "gap" | "connect";          // default: "gap" for line/area, "connect" for radar
  lineColor?: Color | GradientFill;                   // default: follows the theme color cycle; line color of line / polygon stroke color of area+radar
}
```

> If multiple line/area/radar series within the same chart set different `nullHandling` values, only the **first non-empty value** takes effect and the other series follow; multiple null-handling methods are not supported.

---

#### bar

> **series constraint**: may be freely mixed with `line / area / scatter / bubble`; may also mix with `candlestick`; no limit on the number of bar series in the same chart.

```ts
interface BarSeries {
  type: "bar";
  encode: { x: string; y: string };    // required
  name?: string;                       // default: the encode.y column name; for legend display only
  xAxisIndex?: number;                 // default: 0; meaningful only when chart.xAxis is an array
  yAxisIndex?: number;                 // default: 0; meaningful only when chart.yAxis is an array
  stack?: "value" | "percent";         // default: no stacking; "value" sums directly, "percent" normalizes to 100%
  symbol?: ShapeDef;                   // default: normal rectangular bar; pictographic bar shape definition (see [ShapeDef](#image-image))
  fill?: Color | GradientFill;         // default: follows the theme color cycle
  border?: Border;                     // default: not applied
  dataLabels?: DataLabelConfig;        // default: not shown; content only takes "value"
}
```

#### line

> **series constraint**: may be freely mixed with `bar / area / scatter / bubble`; may also mix with `candlestick`.

```ts
interface LineSeries extends LinearSeriesBase {
  type: "line";
  encode: { x: string; y: string };    // required
  name?: string;                       // default: the encode.y column name
  xAxisIndex?: number;                 // default: 0
  yAxisIndex?: number;                 // default: 0
  dataLabels?: DataLabelConfig;        // default: not shown; content only takes "value"
}
```

> line has no area, so `fill` is not provided; for the other curve-class fields, see [LinearSeriesBase](#linearseriesbase).

#### area

> **series constraint**: may be freely mixed with `bar / line / scatter / bubble`; may also mix with `candlestick`.

```ts
interface AreaSeries extends LinearSeriesBase {
  type: "area";
  encode: { x: string; y: string };    // required
  name?: string;                       // default: the encode.y column name
  xAxisIndex?: number;                 // default: 0
  yAxisIndex?: number;                 // default: 0
  stack?: "value" | "percent" | "stream";  // default: no stacking; "stream" = streamgraph (area only)
  areaColor?: Color | GradientFill;    // default: derived from lineColor as semi-transparent
  dataLabels?: DataLabelConfig;        // default: not shown
}
```

> **Stacking group rules**: within the same chart, **all series of the same type that set `stack` are automatically grouped into one stack**, with no explicit group identifier needed. At most one stack group of the same type is supported within the same chart — all series that set `stack` must use the same value (all `"value"` / all `"percent"` / all `"stream"`); mixing raises `StackModeMismatchError`; series without `stack` display independently. If multiple independent stack groups are needed, split them into multiple chart elements.
>
> **`stream` applies only to area**: `value` normalization + central baseline offset; the stacked region is symmetric above and below y=0, taking a "streamgraph" shape.

#### scatter

> **series constraint**: may be freely mixed with `bar / line / area / bubble`.

```ts
interface ScatterSeries {
  type: "scatter";
  encode: { x: string; y: string };    // required; each series references its own x/y column pair
  name?: string;                       // default: the encode.y column name
  yAxisIndex?: number;                 // default: 0
  dataFilter?: { col: string; value: string | number };  // default: no filtering; optional: group with a long table
  marker?: MarkerConfig;               // default: {shape: "circle"}; constraint: cannot be false
  fill?: Color | GradientFill;         // default: follows the theme color cycle; serves as the marker's default fill color (marker.fill takes precedence)
  border?: Border;                     // default: not applied; serves as the marker's default border (marker.border takes precedence)
  dataLabels?: DataLabelConfig;        // default: not shown; content only takes "value"
}
```

#### bubble

> **series constraint**: may be freely mixed with `bar / line / area / scatter`.

```ts
interface BubbleSeries {
  type: "bubble";
  encode: { x: string; y: string; size: string };  // required
  name?: string;                       // default: the encode.y column name
  yAxisIndex?: number;                 // default: 0
  dataFilter?: { col: string; value: string | number };  // default: no filtering; rows where the col column equals value are used as this series' data
  sizeScale?: "linear" | "sqrt" | "log";  // default: "sqrt"
  sizeRange?: [number, number];        // default: auto-adapts to chart size; bubble radius range in px
  fill?: Color | GradientFill;         // default: follows the theme color cycle; bubble fill color
  border?: Border;                     // default: not applied
  dataLabels?: DataLabelConfig;        // default: not shown; content only takes "value"
}
```

> **sizeScale**: `sqrt` (default) makes the area proportional to size; `linear` makes the radius proportional to size; `log` suits scenarios with order-of-magnitude differences. Negative size is treated as 0. For multiple groups, use a wide table + null padding, with each series referencing its own `x/y/size` column triple.

#### candlestick

> **series constraint**: may only mix with `bar / line / area` (common usage: candlestick body + a line overlaying the MA moving average).

```ts
interface CandlestickSeries {
  type: "candlestick";
  /**
   * encode.open is optional → determines the rendering mode
   *   open provided → OHLC candlestick (rendered with 4 series; a solid body expresses the open-close direction)
   *   open omitted → HLC high-low-close (rendered with 3 series; a vertical line + dot marker at close, no body)
   */
  encode: { x: string; high: string; low: string; close: string; open?: string };
  xAxisIndex?: number;                 // default: 0
  yAxisIndex?: number;                 // default: 0
  upBars?:   { fill?: Color; border?: Border };   // rising bar (close > open) style; only effective in OHLC mode (HLC has no body)
  downBars?: { fill?: Color; border?: Border };   // falling bar (close ≤ open) style; only effective in OHLC mode
  wickStyle?: Border;                  // wick (high-low vertical line) style; common to HLC / OHLC
}
```
>
> **Date column handling**: a date column (e.g. `"2024-01-01"`) is treated as string categories, laid out at equal intervals on the x-axis in the order they appear in `rows`, naturally skipping non-trading days. If precise layout by real date intervals is needed, manually padding empty trading days with null rows is recommended.

#### pie

> **series constraint**: the `series` array may only have 1 element, and may not coexist with other types.

```ts
interface PieSeries {
  type: "pie";
  encode: { category: string; value: string };  // required
  innerRadius?: number;                // default: 0; constraint: [0, 1]; > 0 = donut
  startAngle?: number;                 // default: 0 (12 o'clock direction)
  fill?: Color | GradientFill | (Color | GradientFill)[];   // default: follows the theme color cycle; an array cycles by slice
  border?: Border;                     // default: not applied
  dataLabels?: DataLabelConfig;        // default: not shown; content takes "value" | "percentage" | "category", default "value"
}
```

> **Angle direction**: fixed **clockwise** as positive; 0° = 12 o'clock position, 90° = 3 o'clock, 180° = 6 o'clock, 270° = 9 o'clock.

#### radar

> **series constraint**: multiple radar series are allowed in the same chart (sharing one set of spokes), but the type of all series must be `radar`; it may not coexist with other types.

```ts
interface RadarSeries extends LinearSeriesBase {
  type: "radar";
  encode: { category: string; y: string };    // required; the category column holds the spoke labels
  name?: string;                       // default: the encode.y column name
  areaColor?: Color | GradientFill;    // default: derived from lineColor as semi-transparent; polygon fill color
  dataLabels?: DataLabelConfig;        // default: not shown; content only takes "value"
}
```

> The radar chart's spoke axis lines, spider grid, and value range (min/max) are uniformly configured via the chart top-level [spokeAxis](#spokeaxisconfig), shared by multiple series.
>
> **Dimension-column sharing constraint**: all radar series within the same chart must reference the same `category` column (i.e., all polygons share the same set of spoke labels). To display radar charts with different spoke labels, use multiple chart elements. Checker validation: the `encode.category` of all radar series must be identical.

#### waterfall

> **series constraint**: the `series` array may only have 1 element, and may not coexist with other types.

```ts
interface WaterfallSeries {
  type: "waterfall";
  encode: {
    x: string;                         // category column
    y: string;                         // value column (floating bars hold the increase/decrease amounts; total columns hold the absolute value of the cumulative total)
    isTotal?: string;                  // default: omitted = all floating bars; after specifying a bool column, true = total column (opening/subtotal/closing), false/null = floating bar
  };
  totalBars?:    { fill?: Color; border?: Border };   // total column (opening/subtotal/closing, isTotal=true) style
  increaseBars?: { fill?: Color; border?: Border };   // floating increase bar (y > 0) style
  decreaseBars?: { fill?: Color; border?: Border };   // floating decrease bar (y < 0) style
  dataLabels?: DataLabelConfig;        // default: not shown; content takes "value" | "category", default "value"
}
```

> **Colors**: waterfall does not use `fill`; colors are mapped through the three categories `totalBars` / `increaseBars` / `decreaseBars` by isTotal and the sign of y; all total columns (opening/subtotal/closing) share `totalBars`.
>
> **isTotal semantics**: it may appear at any position (first row / middle subtotal / last row are all legal); every `isTotal=true` is an independent total column whose y value should equal "previous total column's y + the sum of all intermediate floating bars' y" — on mismatch, the checker outputs `WaterfallTotalMismatchWarning` (the first-row total column's y is defined directly). The `isTotal` column only accepts bool or null; the string `"true"` or the number `1` both raise `InvalidValueError`.

#### heatmap

> **series constraint**: the `series` array may only have 1 element, and may not coexist with other types.

```ts
interface HeatmapSeries {
  type: "heatmap";
  encode: { x: string; y: string; value: string };  // required; the x and y columns must be categories (string), value is numeric
  colorScheme?: Color[];               // default: falls back to the theme; gradient color-scale endpoints
  colorScale?: {
    type?: "linear" | "diverging";     // default: "linear"
    domain?: [number, number];         // default: data range; for type=diverging, default [-max(|v|), +max(|v|)], 0 centered
  };
  colorbar?: boolean | LegendConfig;   // default: true; color-scale bar legend; position default "right"
  dataLabels?: DataLabelConfig;        // default: not shown; content only takes "value"
}
```

> **Colors**: `colorScheme` serves as gradient endpoints, interpolated per `colorScale.type`:
> - `linear`: `colorScheme` length ≥ 2, interpolated between the endpoints;
> - `diverging`: `colorScheme` length = 3 (low / mid / high); the midpoint is determined by the middle of `domain`, often used in "negative-neutral-positive" scenarios.
>
> **Data layout**: the x / y columns are fixed as categories (string); category order on the axes follows first-appearance order in `rows`; (x, y) combinations that do not appear in `rows` are treated as missing cells, rendered transparent (the background color in PPTX). For a complete matrix, explicitly listing all (x, y) combinations and using null for missing values is recommended.
>
> heatmap does not use `chart.legend`; it is replaced by `colorbar`; `colorbar: false` turns off the color-scale bar.

#### treemap

> **series constraint**: the `series` array may only have 1 element, and may not coexist with other types.

```ts
interface TreemapSeries {
  type: "treemap";
  encode: {
    category: string;                  // node-name column
    value: string;                     // value column
    parent?: string;                   // parent-node column; null/missing/empty = root node (multiple roots allowed)
  };
  levels?: number;                     // default: show all levels
  fill?: Color | GradientFill
       | (Color | GradientFill)[]
       | (Color | GradientFill)[][];   // default: follows the theme color cycle; see "color derivation rules" below
  border?: Border;                     // default: not applied
  dataLabels?: DataLabelConfig;        // default: not shown; content takes "value" | "category", default "category"
}
```

> **Color derivation rules**:
> - `fill: Color | GradientFill` (single value): all root nodes share this color; child nodes are derived by decreasing lightness by 10% per level (along the HSL.L dimension).
> - `fill: (Color | GradientFill)[]` (1-D array): cycles in the order the root nodes appear; each root node's child nodes are derived by decreasing lightness by 10% per level.
> - `fill: (Color | GradientFill)[][]` (2-D array): the outer dimension cycles by root node, the inner dimension specifies levels directly (bypassing automatic derivation); if an inner array is not long enough to cover all levels, the remaining levels are still derived by decreasing lightness by 10%.

#### sunburst

> **series constraint**: the `series` array may only have 1 element, and may not coexist with other types.

```ts
interface SunburstSeries {
  type: "sunburst";
  encode: { category: string; value: string; parent?: string };  // required
  levels?: number;                     // default: show all levels
  fill?: Color | GradientFill | (Color | GradientFill)[];   // default: follows the theme color cycle; an array cycles by top-level node
  border?: Border;                     // default: not applied
  dataLabels?: DataLabelConfig;        // default: not shown; content takes "value" | "category", default "category"
}
```

#### sankey

> **series constraint**: the `series` array may only have 1 element, and may not coexist with other types.

```ts
interface SankeySeries {
  type: "sankey";
  encode: {
    source: string;                    // source-node column
    target: string;                    // target-node column
    flow: string;                      // flow column
  };
  nodeAlign?: "left" | "right" | "justify";  // default: "justify"
  fill?: Color | GradientFill                     // default: follows the theme color cycle (colors picked in node topological order)
       | (Color | GradientFill)[]                // an array cycles by node
       | Record<string, Color | GradientFill>;   // mapped by node name; unspecified nodes fall back to the theme color cycle
  border?: Border;                     // default: not applied
  dataLabels?: DataLabelConfig;        // default: not shown; content takes "value" | "category", default "value"
}
```

> **Graph constraint**: sankey is restricted to a **directed acyclic graph (DAG)**; when the source/target columns form a cycle, the checker raises `CyclicGraphError`.
>
> **Node order**: the `source` and `target` columns are deduplicated and arranged in topological order. When `fill` is an array, it cycles in this order; when the array length < node count, it wraps around and reuses; when > node count, it truncates. The object form matches by node name exactly.

---

#### Field Quick Reference

##### 5.1 Data encode Channels

| type | encode channels |
|---|---|
| bar / line / area | `x` + `y` |
| scatter | `x` + `y` (multi-series use a wide table + null padding) |
| bubble | `x` + `y` + `size` (multi-series use a wide table + null padding) |
| candlestick | Candlestick: `x` + `open` + `close` + `low` + `high`; overlay: `x` + `y` |
| pie | `category` + `value` |
| radar | `category` + `y` |
| waterfall | `x` + `y` + optional `isTotal` (bool column) |
| heatmap | `x` + `y` + `value` |
| treemap / sunburst | `category` + `value` + optional `parent` |
| sankey | `source` + `target` + `flow` |

> **Naming convention**: Cartesian coordinate systems (bar/line/area/scatter/bubble/candlestick/waterfall/heatmap) use `x` / `y` for the horizontal/vertical axes; non-Cartesian category fields are uniformly `category` (pie/radar/treemap/sunburst); sankey graph edge endpoints use `source` / `target`.

##### 5.2 Color Mechanism

| type | Color fields | Description |
|---|---|---|
| bar | `series[].fill` | Bar body fill color |
| line | `series[].lineColor` | Line color (no area) |
| area | `series[].lineColor` + `series[].areaColor` | Stroke color + area color (when the area color is omitted, it is derived from lineColor as semi-transparent) |
| radar | `series[].lineColor` + `series[].areaColor` | Polygon stroke + fill (same as area) |
| scatter | `series[].fill` / `marker.fill` | Series level is the marker default color; `marker.fill` takes precedence |
| bubble | `series[].fill` | Bubble fill color |
| candlestick | `upBars` / `downBars` (body fill+border) + each overlay series' own `lineColor`/`fill` | The candlestick body maps by up/down; overlay line/bar use their own colors |
| pie / sunburst / sankey | The single series' `fill` array, cycled by data point/node | Array length cycles and reuses |
| treemap | The single series' `fill` (single value / 1-D array / 2-D array) | Same as pie etc.; child nodes decrease from the parent along the HSL.L dimension (`L_new = max(0, L_old - 10)`) |
| heatmap | `series[].colorScheme` + `series[].colorScale` | The gradient color scale maps by value; `linear` interpolates between the endpoints, `diverging` aligns three colors at the midpoint |
| waterfall | `series[].totalBars` / `increaseBars` / `decreaseBars` | Mapped into three classes — total (total columns) / increase / decrease; does not participate in the theme color cycle |

##### 5.3 Applicability of Chart Top-Level Fields

| Top-level field | Applicable series types |
|---|---|
| `xAxis` | bar / line / area / scatter / bubble / candlestick / waterfall / heatmap |
| `yAxis` | bar / line / area / scatter / bubble / candlestick / waterfall / heatmap |
| `barWidth` / `barGap` | bar / waterfall (bar layout parameters) |
| `categoryGap` | bar / candlestick / waterfall (category spacing parameter) |
| `spokeAxis` | radar (includes spoke axis lines + spider grid + min/max) |
| `legend` | bar / line / area / scatter / bubble / candlestick / pie / radar / waterfall |
| `title` | All |
| `dataLabels` | All (candlestick: only effective for overlay series; the candlestick body itself expresses the up/down roles via upBars/downBars) |
| `fontFamily` | All |

> **Axis single-value vs array rules**: a secondary axis is always placed on the **side where the value axis is** — vertical charts use a `yAxis` array + `yAxisIndex`, horizontal charts use an `xAxis` array + `xAxisIndex`. When any series uses `xAxisIndex > 0` / `yAxisIndex > 0`, the corresponding `xAxis` / `yAxis` must be an array (length ≥ max(index) + 1).

##### 5.4 Type-Mixing Compatibility Quick Reference

```
bar / line / area / scatter / bubble may coexist with each other freely; candlestick may only coexist with bar / line / area
```

> The other 7 types each exclusively own the series array; see the first line of the corresponding section for detailed constraints.

##### 5.5 dataLabels.content Value Quick Reference

| type | Allowed values | Default |
|---|---|---|
| bar / line / area / scatter / bubble / radar / heatmap | `value` | `value` |
| candlestick (overlay series only) | `value` | `value` |
| pie | `value` / `percentage` / `category` | `value` |
| waterfall | `value` / `category` | `value` |
| treemap / sunburst | `value` / `category` | `category` |
| sankey | `value` / `category` | `value` |

> Writing a value outside this table → the checker raises `InvalidValueError`. The candlestick body itself does not support dataLabels.

---

#### Examples

**Bar chart (stacked)**

```yaml
- elementId: c1
  elementType: chart
  bounds: [50, 100, 600, 400]
  data:
    cols: [quarter, revenue, cost]
    rows:
      - [Q1, 120, 220]
      - [Q2, 132, 182]
      - [Q3, 101, 191]
      - [Q4, 134, 234]
  seriesDefaults:
    bar: {stack: value}
  series:
    - type: bar
      encode: {x: quarter, y: revenue}
      name: Revenue
      fill: "$primary"
    - type: bar
      encode: {x: quarter, y: cost}
      name: Expenses
      fill: "$accent"
```

**Line chart (multi-series differentiation)**

```yaml
- elementId: c2
  elementType: chart
  bounds: [50, 100, 600, 400]
  data:
    cols: [month, actual, target, baseline]
    rows:
      - [Jan, 72, 65, 50]
      - [Feb, 85, 70, 50]
      - [Mar, null, 78, 50]
      - [Apr, 90, 82, 50]
  yAxis: {min: 0, max: 100, gridLine: {color: "#f0f0f0"}}
  series:
    - type: line
      encode: {x: month, y: actual}
      name: Actual
      lineColor: "#5470c6"
      lineStyle: solid
      width: 3
      smooth: true
    - type: line
      encode: {x: month, y: target}
      name: Target
      lineColor: "#ee6666"
      lineStyle: dash
      smooth: true
    - type: line
      encode: {x: month, y: baseline}
      name: Baseline
      lineColor: "#999999"
      lineStyle: dot
      width: 1
      marker: false
```

**Area chart (stream stacking)**

```yaml
- elementId: c3
  elementType: chart
  bounds: [50, 80, 700, 400]
  title: Traffic Evolution by Channel
  data:
    cols: [week, web, app, partner]
    rows:
      - [W1, 200, 120, 80]
      - [W2, 240, 160, 90]
      - [W3, 260, 200, 110]
      - [W4, 280, 240, 130]
  seriesDefaults:
    area: {stack: stream}
  series:
    - type: area
      encode: {x: week, y: web}
      name: Web
      areaColor: "#5470c6"
    - type: area
      encode: {x: week, y: app}
      name: App
      areaColor: "#91cc75"
    - type: area
      encode: {x: week, y: partner}
      name: Partner
      areaColor: "#fac858"
```

**Bubble chart (multi-series grouping)**

```yaml
- elementId: c5
  elementType: chart
  bounds: [50, 80, 700, 420]
  title: User Distribution
  xAxis: {title: Age}
  yAxis: {title: "Annual income (10K)"}
  data:
    cols: [age_s, inc_s, pop_s, age_w, inc_w, pop_w, age_m, inc_m, pop_m]
    rows:
      - [22, 5, 120, 28, 12, 380, 45, 40, 180]
      - [null, null, null, 35, 25, 260, 52, 60, 90]
  seriesDefaults:
    bubble:
      sizeScale: sqrt
      sizeRange: [8, 48]
  series:
    - type: bubble
      encode: {x: age_s, y: inc_s, size: pop_s}
      name: Students
      fill: "#5470c6"
    - type: bubble
      encode: {x: age_w, y: inc_w, size: pop_w}
      name: White-collar
      fill: "#91cc75"
    - type: bubble
      encode: {x: age_m, y: inc_m, size: pop_m}
      name: Management
      fill: "#ee6666"
```

**Candlestick chart (with MA5 overlay line)**

```yaml
- elementId: c6
  elementType: chart
  bounds: [50, 80, 700, 420]
  title: Stock Price Trend
  data:
    cols: [date, open, high, low, close, ma5]
    rows:
      - ["2024-01-01", 100, 110, 95, 108, null]
      - ["2024-01-02", 108, 115, 105, 112, null]
      - ["2024-01-03", 112, 118, 109, 116, null]
      - ["2024-01-04", 116, 120, 110, 113, null]
      - ["2024-01-05", 113, 117, 108, 115, 112.8]
  yAxis: {title: Price}
  series:
    - type: candlestick
      encode: {x: date, open: open, close: close, low: low, high: high}
      upBars: {fill: "#ee6666"}
      downBars: {fill: "#5470c6"}
    - type: line
      encode: {x: date, y: ma5}
      name: MA5
      smooth: true
      width: 2
      lineColor: "#fac858"
```

**Waterfall chart**

```yaml
- elementId: c9
  elementType: chart
  bounds: [50, 80, 700, 380]
  title: Cash Flow Waterfall
  data:
    cols: [phase, amount, total]
    rows:
      - [Opening balance, 500, true]
      - [Sales revenue, 300, null]
      - [Operating expenses, -180, null]
      - [Taxes, -60, null]
      - [Closing balance, 560, true]
  series:
    - type: waterfall
      encode: {x: phase, y: amount, isTotal: total}
      totalBars: {fill: "#5470c6"}
      increaseBars: {fill: "#91cc75"}
      decreaseBars: {fill: "#ee6666"}
      dataLabels: {show: true}
```

**Heatmap**

```yaml
- elementId: c10
  elementType: chart
  bounds: [50, 80, 700, 420]
  title: User Activity Heatmap
  data:
    cols: [hour, day, count]
    rows:
      - ["00:00", Mon, 5]
      - ["00:00", Tue, 8]
      - ["06:00", Mon, 22]
      - ["12:00", Mon, 45]
  series:
    - type: heatmap
      encode: {x: hour, y: day, value: count}
      colorScheme: ["#ffffff", "#5470c6"]
      colorScale: {domain: [0, 50]}
```

**Treemap (with hierarchy)**

```yaml
- elementId: c11
  elementType: chart
  bounds: [50, 80, 700, 420]
  title: Budget Allocation
  data:
    cols: [dept, parentDept, budget]
    rows:
      - [Engineering, null, 1000]
      - [Frontend, Engineering, 400]
      - [Backend, Engineering, 600]
      - [Sales, null, 800]
  series:
    - type: treemap
      encode: {category: dept, value: budget, parent: parentDept}
      fill: ["#5470c6", "#91cc75"]
```

**Sankey diagram**

```yaml
- elementId: c13
  elementType: chart
  bounds: [50, 80, 800, 420]
  title: User Conversion Funnel
  data:
    cols: [from, to, users]
    rows:
      - [Ad campaign, Landing page, 10000]
      - [Ad campaign, Direct search, 4000]
      - [Landing page, Sign-up, 3000]
      - [Landing page, Drop-off, 7000]
      - [Sign-up, First order, 1200]
      - [Direct search, First order, 2000]
  series:
    - type: sankey
      encode: {source: from, target: to, flow: users}
      nodeAlign: justify
      fill: ["#5470c6", "#91cc75", "#fac858", "#ee6666", "#73c0de"]
```

**seriesDefaults + mixing: bar default width + line default smoothing**

```yaml
- elementId: c15
  elementType: chart
  bounds: [50, 80, 700, 420]
  data:
    cols: [month, sales, growth]
    rows:
      - [Jan, 120, 0.10]
      - [Feb, 150, 0.25]
      - [Mar, 180, 0.20]
  yAxis:
    - {title: Sales}
    - {title: Growth rate, label: {numberFormat: "0%"}}
  seriesDefaults:
    bar:
      fill: "#5470c6"
    line:
      smooth: true
      width: 2
      lineColor: "#ee6666"
  barWidth: 0.6
  series:
    - type: bar
      encode: {x: month, y: sales}
      name: Sales
    - type: line
      encode: {x: month, y: growth}
      name: Growth rate
      yAxisIndex: 1
```

**Horizontal bar chart (category axis on the y side)**

```yaml
- elementId: c16
  elementType: chart
  bounds: [50, 80, 600, 360]
  title: Headcount by Department
  data:
    cols: [dept, headcount]
    rows:
      - [Engineering, 120]
      - [Product, 45]
      - [Design, 30]
      - [Operations, 60]
  xAxis: {label: {numberFormat: "#,##0"}}
  yAxis: {label: {fontSize: 12}}
  series:
    - type: bar
      encode: {x: headcount, y: dept}
      fill: "$primary"
      dataLabels: {show: true}
```

---

## 6. Animations

The optional `animations` array can be used to orchestrate animations for elements on the current page. `animations` is a page-level field and references elements in the page's `elements` array through `elementId`. Array order determines the sequence relationships among animations, while `trigger` determines when each animation starts.

```ts
type AnimationEffect =
  | "appear" | "fade-in" | "fly-in" | "zoom-in" | "wipe-in" | "float-in" | "peek-in" | "rise-in"
  | "pulse" | "grow-shrink" | "spin" | "teeter" | "fill-color" | "transparency" | "color-pulse"
  | "disappear" | "fade-out" | "fly-out" | "zoom-out" | "wipe-out" | "float-out"
  | "motion-path";

type AnimationTrigger = "onClick" | "withPrevious" | "afterPrevious";
type AnimationDirection = "up" | "down" | "left" | "right";
type AnimationEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out";

interface Animation {
  elementId: string;                 // required; must reference an existing element on this page
  effect: AnimationEffect;           // required; animation effect
  trigger?: AnimationTrigger;        // default: "onClick"
  direction?: AnimationDirection;    // default: "up"; only used by fly/wipe/peek/float effects
  durationMs?: number;               // default: the default duration of the corresponding effect; constraint: > 0
  delayMs?: number;                  // default: 0; constraint: >= 0
  easing?: AnimationEasing;          // default: "linear"
  repeat?: number;                   // default: 1; constraint: positive integer
  path?: string;                     // required when using motion-path
  color?: string;                    // required for fill-color / color-pulse; 6-digit HEX, with optional #
  amount?: number;                   // required for transparency; target opacity; constraint: [0, 1]
}
```

**Example:**

```yaml
elements:
  - elementId: title
    elementType: text
    bounds: [60, 40, 600, 60]
    content: {fontSize: 40, text: Title}
  - elementId: photo
    elementType: image
    bounds: [60, 140, 400, 300]
    src: media/pic.png
animations:
  - elementId: title
    effect: fade-in
    trigger: onClick
  - elementId: photo
    effect: fly-in
    direction: up
    trigger: withPrevious
  - elementId: photo
    effect: pulse
    trigger: afterPrevious
```

### Effects

- Entrance: `appear` appears immediately, `fade-in` fades in, `fly-in` flies in, `zoom-in` zooms in, `wipe-in` wipes in, `float-in` fades in with a short drift (about 10% of the page height and gentler than `fly-in`), `peek-in` slides out from behind the element's own edge mask without fading in, and `rise-in` rises linearly from below the page without fading in
- Emphasis: `pulse` pulses (scales to 110% and rebounds), `grow-shrink` scales to 150%, `spin` rotates 360°, `teeter` rocks from side to side, `fill-color` changes the fill color and preserves the result, `transparency` changes the opacity and preserves the result, and `color-pulse` changes the fill color and then restores the original color
- Exit: `disappear` disappears immediately, `fade-out` fades out, `fly-out` flies out, `zoom-out` zooms out, `wipe-out` wipes out, and `float-out` fades out with a short drift
- Path: `motion-path` moves along a path

| Effect | Default duration |
|---|---|
| `fade-in`, `fade-out`, `fly-in`, `fly-out`, `zoom-in`, `zoom-out`, `wipe-in`, `wipe-out`, `float-in`, `float-out`, `peek-in` | 500ms |
| `pulse` | 600ms |
| `grow-shrink`, `spin`, `fill-color`, `transparency`, `color-pulse` | 2000ms |
| `teeter`, `rise-in` | 1000ms |
| `motion-path` | 2000ms |
| `appear`, `disappear` | Instantaneous; ignores `durationMs` |

### Parameterized Emphasis Effects

| Effect | Parameter | Visual behavior |
|---|---|---|
| `fill-color` | `color`, required | Transitions the fill from its current color to `color` and preserves the target color after the animation ends |
| `transparency` | `amount`, required | Transitions opacity from its current value to `amount` and preserves the target opacity after the animation ends; `0` is fully transparent and `1` is fully opaque |
| `color-pulse` | `color`, required | Transitions the fill color to `color`, then restores the original color without preserving the intermediate state |

```yaml
animations:
  # Highlight a process step: change the fill to amber and preserve it
  - elementId: step-2
    effect: fill-color
    color: "#F59E0B"
    trigger: onClick

  # Dim a secondary element: reduce its opacity to 30%
  - elementId: bg-decoration
    effect: transparency
    amount: 0.3
    trigger: withPrevious

  # Emphasize the current card: pulse red once, then restore the original color
  - elementId: card-current
    effect: color-pulse
    color: "#EF4444"
    trigger: afterPrevious

  # Bring body text in gently
  - elementId: body-text
    effect: float-in
    direction: up
    easing: ease-out
```

### Triggers and Groups

- `onClick` starts a new click group and plays on click
- `withPrevious` starts at the same time as the preceding animation
- `afterPrevious` starts automatically after the preceding animation ends
- If the first animation on a page uses `withPrevious` or `afterPrevious`, the group beginning with it plays automatically when the page is entered
- To make multiple elements enter together after a click, set the first animation to `onClick` and the rest to `withPrevious`
- Use `afterPrevious` for animations that should play sequentially

### direction

`direction` indicates the travel direction or wipe progression direction. For entrance effects, `up` means entering upward from below the page; for exit effects, `up` means leaving the page upward. This field only affects fly/wipe/peek/float effects and is ignored by other effects. Float effects support only `up` and `down`; `rise-in` does not use this field and always rises from below the page.

### motion-path

`path` is an SVG path string. Path coordinates are offsets relative to the element's current position, measured in page px. The path must start with `M 0 0`, contain only one subpath, and may use `L` (line), `Q` / `C` (curves), and `Z` (close). For example, `M 0 0 L 200 -100` moves the element 200px to the right and 100px upward.

The same element may define multiple animations in array order. Keep each page to 1–3 animation groups when possible, prefer simple effects such as fade, fly, and zoom, and avoid applying multiple emphasis effects to the same element in succession.
