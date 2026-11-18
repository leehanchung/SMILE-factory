# Formatting Requirements by Venue

## Universal Requirements

### Document Format
- **File type:** PDF only (never Word)
- **Fonts:** Type-1 fonts only (check with `pdffonts` on Linux)
- **Page size:** US Letter (final) or A4 (initial)
- **Encoding:** UTF-8 for special characters

### Two-Column Layout
- Total width: ~6.75 inches
- Column gap: ~0.25 inches
- Left margin: ~0.75 inches
- Top margin: ~1 inch
- Body font: 10pt Times or similar serif
- Line spacing: 11pt vertical

### Title
- Centered, 14pt bold
- Capitalize first letter of content words
- Between two 1pt horizontal rules
- Math allowed (sparingly), no custom macros or images

### Abstract
- Indented 0.25 inches from both margins
- 10pt font, 11pt line spacing
- One paragraph, 4-6 sentences
- Headed "Abstract" in centered, bold, 11pt

### Section Headings
- **Section:** Numbered, flush left, 11pt bold, content words capitalized
- **Subsection:** Numbered, flush left, 10pt bold, content words capitalized
- **Subsubsection:** Numbered, flush left, 10pt small caps
- Maximum three levels of headings

### Figures
- Centered, legible
- Caption below figure, 9pt
- At least 0.5pt line thickness
- No text on gray backgrounds
- Label all components
- Include axis labels and legends for graphs

### Tables
- Centered, legible
- Caption above table, 9pt
- Topmost row specifies column contents
- Can float to top/bottom of columns

### Footnotes
- 9pt font at column bottom
- Preceded by 0.8-inch horizontal rule
- Complete sentences
- Number sequentially

### References
- APA format
- Hanging indent (10pt after first line)
- Alphabetical by first author surname
- Include page numbers when possible
- Use "et al." for citations with 3+ authors
- Multiple citations: chronological order, semicolon separated

## Venue-Specific Requirements

### ICML

**Page Limits:**
- Submission: 8 pages main body
- Camera-ready: 9 pages main body
- References and appendices: unlimited
- File size: 50MB submission, 20MB camera-ready

**Anonymization:**
- Double-blind review
- No author information anywhere
- No acknowledgments or grant numbers
- Self-cite in third person
- No identifying URLs

**Style Files:**
- Use `icml20XX.sty` template
- Add `[accepted]` option for camera-ready
- Running head on all pages except first

**Camera-Ready:**
- Author info 0.3 inches below title rules
- 10pt bold author names, centered
- Superscript numbers for affiliations
- Equal contribution marked with asterisk
- Update footnote to proceedings info

### NeurIPS

**Page Limits:**
- Submission: 9 pages main body
- Camera-ready: 10 pages main body  
- References and appendices: unlimited

**Anonymization:**
- Double-blind review
- Same rules as ICML

**Style Files:**
- Use `neurips_20XX.sty` template
- Checklist required (in supplementary or appendix)

**Checklist:**
- Answer all questions
- Include in paper or supplementary
- Covers claims, limitations, theory, experiments, broader impact

### ACL/EMNLP/NAACL

**Page Limits:**
- Long papers: 8 pages + references
- Short papers: 4 pages + references
- Camera-ready: +1 page

**Anonymization:**
- Double-blind (ACL, EMNLP)
- Same rules as ICML

**Style Files:**
- Use ACL style files
- Separate templates for long/short

**Special Requirements:**
- Limitations section required (does not count toward page limit)
- Ethics statement may be required
- Reproducibility checklist

### ICLR

**Page Limits:**
- Submission: 9 pages main body
- Camera-ready: typically +1 page
- References and appendices: unlimited

**Review Process:**
- Open peer review on OpenReview
- Double-blind submission
- Author responses visible

**Style Files:**
- Use official ICLR template

## LaTeX Tips

### Ensuring Type-1 Fonts
```bash
# Check fonts
pdffonts paper.pdf

# If using dvips
dvips -Ppdf -tletter -G0 -o paper.ps paper.dvi
ps2pdf paper.ps

# Preferred: use pdflatex directly
pdflatex paper.tex
```

### Common Packages
```latex
\usepackage{graphicx}    % Figures
\usepackage{amsmath}     % Math
\usepackage{amssymb}     % Math symbols
\usepackage{booktabs}    % Professional tables
\usepackage{hyperref}    % Links (may need nohyperref option)
\usepackage{microtype}   % Better typography
\usepackage{natbib}      % Citations
```

### Figure Formats
- Vector (`.pdf`, `.eps`) for plots and diagrams
- Lossless raster (`.png`) for screenshots, sharp lines
- JPEG (`.jpg`) for photographs only

### Table Formatting
```latex
\usepackage{booktabs}
\begin{table}[t]
\centering
\caption{Results on benchmark tasks.}
\begin{tabular}{lcc}
\toprule
Method & Acc & F1 \\
\midrule
Baseline & 78.2 & 75.1 \\
Ours & \textbf{84.5} & \textbf{82.3} \\
\bottomrule
\end{tabular}
\end{table}
```

### Math Notation
```latex
% Vectors (bold lowercase)
\mathbf{x}, \mathbf{h}

% Matrices (bold uppercase)
\mathbf{W}, \mathbf{A}

% Sets (calligraphic)
\mathcal{D}, \mathcal{V}

% Real numbers
\mathbb{R}^d

% Expectations
\mathbb{E}_{x \sim p}[f(x)]
```

## Common Formatting Mistakes

### Auto-Reject Issues
- Over page limit (main body)
- Author-identifying information in submission
- Wrong template/format
- Word document instead of PDF
- Type-3 fonts in PDF

### Quality Issues
- Figures illegible when printed
- Missing axis labels or legends
- Tables without captions
- References incomplete (missing venues, pages)
- Inconsistent notation
- Broken hyperlinks
- Orphan section headings

### Accessibility Issues
- Red-green color schemes (colorblind readers)
- Figures that rely solely on color
- Images without alt-text (where supported)
- Tiny fonts in figures
- Low contrast text

## Submission Checklist (Format)

Before submitting:

- [ ] PDF format, Type-1 fonts only (`pdffonts` check)
- [ ] Page limit met (count main body carefully)
- [ ] No author information (blind review)
- [ ] No acknowledgments or grant numbers
- [ ] Self-citations in third person
- [ ] Template matches venue and year
- [ ] All figures have captions below
- [ ] All tables have captions above
- [ ] References complete with page numbers
- [ ] No URLs revealing identity
- [ ] Appendices in same PDF (not separate file)
- [ ] File size under limit
- [ ] Supplementary material anonymized
