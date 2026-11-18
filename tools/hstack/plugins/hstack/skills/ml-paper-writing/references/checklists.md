# Conference Paper Checklists

Mandatory checklist requirements for major ML/AI conferences. Missing checklists results in desk rejection.

---

## Contents

- [NeurIPS Paper Checklist](#neurips-paper-checklist)
- [ICML Requirements](#icml-requirements)
- [ICLR Requirements](#iclr-requirements)
- [ACL Requirements](#acl-requirements)
- [Universal Pre-Submission Checklist](#universal-pre-submission-checklist)
- [Quick Reference: Page Limits](#quick-reference-page-limits)

---

## NeurIPS Paper Checklist

### Mandatory Components

All NeurIPS submissions must include a completed paper checklist. Papers lacking this face **automatic desk rejection**. The checklist appears after references, outside the page limit.

### 16 Required Checklist Items

#### 1. Claims Alignment
- [ ] Abstract claims match actual results
- [ ] Introduction doesn't overclaim
- [ ] Contributions are specific and falsifiable

#### 2. Limitations Discussion
- [ ] Dedicated Limitations section
- [ ] Honest assessment of scope
- [ ] Conditions where method may fail

#### 3. Theory & Proofs
- [ ] All assumptions stated formally
- [ ] Complete proofs provided (main text or appendix)
- [ ] Proof sketches for intuition

#### 4. Reproducibility
- [ ] Clear reproducibility statement
- [ ] Code availability information
- [ ] Model checkpoints if applicable

#### 5. Data & Code Access
- [ ] Exact commands to run experiments
- [ ] Environment specifications
- [ ] Data access instructions

#### 6. Experimental Details
- [ ] Train/val/test split details
- [ ] All hyperparameters used
- [ ] Hyperparameter selection method

#### 7. Statistical Significance
- [ ] Error bars or confidence intervals
- [ ] Number of runs/seeds
- [ ] Calculation method (std dev vs std error)

#### 8. Compute Resources
- [ ] GPU type and count
- [ ] Training time per run
- [ ] Total compute used

#### 9. Ethics Code Compliance
- [ ] Read NeurIPS Code of Ethics
- [ ] Confirm compliance
- [ ] Note any deviations

#### 10. Broader Impacts
- [ ] Potential negative applications
- [ ] Fairness considerations
- [ ] Privacy implications

#### 11. Safeguards
- [ ] Release strategy for sensitive models
- [ ] Usage guidelines if needed
- [ ] Access controls if appropriate

#### 12. License Respect
- [ ] Dataset licenses cited
- [ ] Code licenses respected
- [ ] Version numbers included

#### 13. Asset Documentation
- [ ] Datasheet or model card (if new)
- [ ] Training data documentation
- [ ] Known limitations

#### 14. Human Subjects
- [ ] Task instructions
- [ ] Compensation details
- [ ] Time estimates

#### 15. IRB Approvals
- [ ] IRB approval obtained
- [ ] Risk assessment completed
- [ ] Anonymized at submission

#### 16. LLM Declaration
- [ ] LLM used as core methodology component
- [ ] How LLM was used
- [ ] (Writing assistance doesn't require disclosure)

**Response Format**: Select "yes," "no," or "N/A" with optional 1-2 sentence justifications.

---

## ICML Requirements

### Broader Impact Statement

ICML requires a Broader Impact Statement after conclusion, before references. Does NOT count toward page limit.

**Required elements:**
- Potential positive impacts
- Potential negative impacts
- Mitigation strategies
- Who may be affected

### ICML Reproducibility Checklist

- [ ] Data splits clearly specified
- [ ] Hyperparameters listed
- [ ] Search ranges documented
- [ ] Selection method explained
- [ ] Compute resources specified
- [ ] Code availability stated

### Statistical Reporting

- [ ] Error bars on all figures
- [ ] Standard deviation vs standard error specified
- [ ] Number of runs stated
- [ ] Significance tests if comparing methods

### Anonymization

- [ ] No author names
- [ ] No acknowledgments
- [ ] No grant numbers
- [ ] Prior work cited in third person
- [ ] No identifiable repository URLs

---

## ICLR Requirements

### LLM Disclosure Policy

> "If LLMs played a significant role in research ideation and/or writing to the extent that they could be regarded as a contributor, authors must describe their precise role in a separate appendix section."

**When disclosure is required:**
- LLM used for significant research ideation
- LLM used for substantial writing
- LLM could be considered a contributor

**When disclosure is NOT required:**
- Grammar checking
- Minor editing assistance
- Code completion tools

### ICLR Specific Requirements

#### Reproducibility Statement (Recommended)
- Supporting materials
- Code availability
- Data availability
- Model checkpoints

#### Ethics Statement (Optional)
Address potential concerns in ≤1 page. Does not count toward page limit.

#### Reciprocal Reviewing
- Authors on 3+ papers must serve as reviewers for ≥6 papers
- Each submission needs ≥1 author registered to review ≥3 papers

---

## ACL Requirements

### Limitations Section (Mandatory)

ACL specifically requires a Limitations section. Does NOT count toward page limit.

**What to include:**
- Strong assumptions made
- Scope limitations
- When method may fail
- Generalization concerns

### ACL Specific Checklist

#### Responsible NLP
- [ ] Bias considerations addressed
- [ ] Fairness evaluated if applicable
- [ ] Dual-use concerns discussed

#### Multilingual Considerations (if applicable)
- [ ] Language diversity addressed
- [ ] Non-English languages included
- [ ] Translation quality verified

#### Human Evaluation (if applicable)
- [ ] Annotator details provided
- [ ] Agreement metrics reported
- [ ] Compensation documented

---

## Universal Pre-Submission Checklist

### Paper Content

- [ ] Abstract ≤ word limit (usually 250-300 words)
- [ ] Main content within page limit
- [ ] References complete and verified
- [ ] Limitations section included
- [ ] All figures/tables have captions
- [ ] Captions are self-contained

### Formatting

- [ ] Correct template used (venue + year specific)
- [ ] Margins not modified
- [ ] Font sizes not modified
- [ ] Double-blind requirements met
- [ ] Page numbers correct

### Technical

- [ ] All claims supported by evidence
- [ ] Error bars included
- [ ] Baselines appropriate
- [ ] Hyperparameters documented
- [ ] Compute resources stated

### Reproducibility

- [ ] Code will be available (or justification)
- [ ] Data will be available (or justification)
- [ ] Environment documented
- [ ] Commands to reproduce provided

### Ethics

- [ ] Broader impacts considered
- [ ] Limitations honestly stated
- [ ] Licenses respected
- [ ] IRB obtained if needed

### Final Checks

- [ ] PDF compiles without errors
- [ ] All figures render correctly
- [ ] All citations resolve
- [ ] Supplementary material organized
- [ ] Conference checklist completed

---

## Quick Reference: Page Limits

| Conference | Main Content | References | Appendix |
|------------|-------------|------------|----------|
| NeurIPS 2025 | 9 pages | Unlimited | Unlimited |
| ICML 2026 | 8 pages (+1 camera) | Unlimited | Unlimited |
| ICLR 2026 | 9 pages (+1 camera) | Unlimited | Unlimited |
| ACL 2025 | 8 pages (long) | Unlimited | Unlimited |
| AAAI 2026 | 7 pages (+1 camera) | Unlimited | Unlimited |
| COLM 2025 | 9 pages (+1 camera) | Unlimited | Unlimited |

---

## Reviewer Scoring (NeurIPS 6-point scale)

| Score | Label | Description |
|-------|-------|-------------|
| 6 | Strong Accept | Groundbreaking, flawless; top 2-3% |
| 5 | Accept | Technically solid, high impact |
| 4 | Borderline Accept | Solid, limited evaluation |
| 3 | Borderline Reject | Weaknesses outweigh |
| 2 | Reject | Technical flaws |
| 1 | Strong Reject | Known results or ethics issues |
