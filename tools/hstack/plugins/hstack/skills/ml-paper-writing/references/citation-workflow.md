# Citation Management & Hallucination Prevention

Complete workflow for managing citations programmatically and preventing AI-generated citation hallucinations.

---

## Contents

- [Why Citation Verification Matters](#why-citation-verification-matters)
- [Citation APIs Overview](#citation-apis-overview)
- [Verified Citation Workflow](#verified-citation-workflow)
- [Python Implementation](#python-implementation)
- [BibTeX Management](#bibtex-management)
- [Common Citation Formats](#common-citation-formats)

---

## Why Citation Verification Matters

### The Hallucination Problem

- **~40% error rate** in AI-generated citations (Enago Academy research)
- Common errors: fabricated titles, wrong venues/years, non-existent papers

### Solution

**Never generate citations from memory—always verify programmatically.**

---

## Citation APIs Overview

| API | Coverage | Rate Limits | Best For |
|-----|----------|-------------|----------|
| **Semantic Scholar** | 214M papers | 1 RPS (free key) | ML/AI papers |
| **CrossRef** | 140M+ DOIs | Polite pool | DOI lookup, BibTeX |
| **arXiv** | Preprints | 3-second delays | ML preprints |
| **OpenAlex** | 240M+ works | 100K/day | Open alternative |

```
Need ML paper search? → Semantic Scholar
Have DOI, need BibTeX? → CrossRef content negotiation
Looking for preprint? → arXiv API
```

---

## Verified Citation Workflow

### 5-Step Process

```
1. SEARCH → Query Semantic Scholar with specific keywords
     ↓
2. VERIFY → Confirm paper exists in 2+ sources
     ↓
3. RETRIEVE → Get BibTeX via DOI content negotiation
     ↓
4. VALIDATE → Confirm the claim appears in source
     ↓
5. ADD → Add verified entry to .bib file
```

### Step 1: Search Semantic Scholar

```python
from semanticscholar import SemanticScholar

sch = SemanticScholar()
results = sch.search_paper("transformer attention mechanism", limit=10)

for paper in results:
    print(f"Title: {paper.title}")
    print(f"Year: {paper.year}")
    print(f"DOI: {paper.externalIds.get('DOI', 'N/A')}")
    print(f"arXiv: {paper.externalIds.get('ArXiv', 'N/A')}")
```

### Step 2: Verify Existence

Confirm paper exists in at least two sources:

```python
import requests

def verify_paper(doi=None, arxiv_id=None):
    sources_found = []

    # Check Semantic Scholar
    sch = SemanticScholar()
    if doi:
        paper = sch.get_paper(f"DOI:{doi}")
        if paper:
            sources_found.append("Semantic Scholar")

    # Check CrossRef
    if doi:
        resp = requests.get(f"https://api.crossref.org/works/{doi}")
        if resp.status_code == 200:
            sources_found.append("CrossRef")

    # Check arXiv
    if arxiv_id:
        resp = requests.get(f"http://export.arxiv.org/api/query?id_list={arxiv_id}")
        if "<entry>" in resp.text:
            sources_found.append("arXiv")

    return len(sources_found) >= 2, sources_found
```

### Step 3: Retrieve BibTeX via DOI

```python
import requests

def doi_to_bibtex(doi: str) -> str:
    """Get verified BibTeX from DOI via CrossRef content negotiation."""
    response = requests.get(
        f"https://doi.org/{doi}",
        headers={"Accept": "application/x-bibtex"},
        allow_redirects=True
    )
    response.raise_for_status()
    return response.text

# Example
bibtex = doi_to_bibtex("10.48550/arXiv.1706.03762")
print(bibtex)
```

### Step 4: Validate Claims

Before citing for a specific claim, verify the claim exists in the paper:

```python
def get_paper_abstract(doi):
    sch = SemanticScholar()
    paper = sch.get_paper(f"DOI:{doi}")
    return paper.abstract if paper else None
```

### Step 5: Handle Failures

If you cannot verify a citation at ANY step:

```latex
% Option 1: Explicit placeholder
\cite{PLACEHOLDER_smith2023_verify}  % TODO: Could not verify

% Option 2: Note in text
... as shown in prior work [CITATION NEEDED].
```

**Always inform the scientist:**
> "I could not verify the following citations and have marked them as placeholders."

---

## Python Implementation

### Complete Citation Manager

```python
import requests
import time
from typing import Optional, List, Dict, Tuple
from dataclasses import dataclass

try:
    from semanticscholar import SemanticScholar
except ImportError:
    print("Install: pip install semanticscholar")
    SemanticScholar = None

@dataclass
class Paper:
    title: str
    authors: List[str]
    year: int
    doi: Optional[str]
    arxiv_id: Optional[str]
    venue: Optional[str]
    citation_count: int
    abstract: Optional[str]

class CitationManager:
    def __init__(self, api_key: Optional[str] = None):
        self.sch = SemanticScholar(api_key=api_key) if SemanticScholar else None
        self.verified_papers: Dict[str, Paper] = {}

    def search(self, query: str, limit: int = 10) -> List[Paper]:
        if not self.sch:
            raise RuntimeError("Semantic Scholar not available")

        results = self.sch.search_paper(query, limit=limit)
        papers = []

        for r in results:
            paper = Paper(
                title=r.title,
                authors=[a.name for a in (r.authors or [])],
                year=r.year or 0,
                doi=r.externalIds.get('DOI') if r.externalIds else None,
                arxiv_id=r.externalIds.get('ArXiv') if r.externalIds else None,
                venue=r.venue,
                citation_count=r.citationCount or 0,
                abstract=r.abstract
            )
            papers.append(paper)

        return papers

    def get_bibtex(self, paper: Paper) -> Optional[str]:
        if paper.doi:
            try:
                resp = requests.get(
                    f"https://doi.org/{paper.doi}",
                    headers={"Accept": "application/x-bibtex"},
                    timeout=10,
                    allow_redirects=True
                )
                if resp.status_code == 200:
                    return resp.text
            except:
                pass
        return self._generate_bibtex(paper)

    def _generate_bibtex(self, paper: Paper) -> str:
        first_author = paper.authors[0].split()[-1] if paper.authors else "unknown"
        first_word = paper.title.split()[0].lower().replace(',', '')
        key = f"{first_author.lower()}_{paper.year}_{first_word}"
        authors = " and ".join(paper.authors) if paper.authors else "Unknown"

        return f"""@article{{{key},
  title = {{{paper.title}}},
  author = {{{authors}}},
  year = {{{paper.year}}},
  {'doi = {' + paper.doi + '},' if paper.doi else ''}
  {'eprint = {' + paper.arxiv_id + '},' if paper.arxiv_id else ''}
}}"""

    def cite(self, query: str) -> Optional[str]:
        papers = self.search(query, limit=5)
        if not papers:
            return None
        paper = papers[0]
        return self.get_bibtex(paper)
```

### Quick Functions

```python
def quick_cite(query: str) -> str:
    cm = CitationManager()
    return cm.cite(query)

def batch_cite(queries: List[str], output_file: str = "references.bib"):
    cm = CitationManager()
    bibtex_entries = []

    for query in queries:
        print(f"Processing: {query}")
        bibtex = cm.cite(query)
        if bibtex:
            bibtex_entries.append(bibtex)
        time.sleep(1)

    with open(output_file, 'w') as f:
        f.write("\n\n".join(bibtex_entries))
```

---

## BibTeX Management

### BibLaTeX Setup

```latex
\usepackage[backend=biber, style=numeric, sorting=none]{biblatex}
\addbibresource{references.bib}

% In document
\cite{vaswani_2017_attention}

% At end
\printbibliography
```

### Citation Commands

```latex
\cite{key}       % Numeric: [1]
\citep{key}      % Parenthetical: (Author, 2020)
\citet{key}      % Textual: Author (2020)
\citeauthor{key} % Just author name
\citeyear{key}   % Just year
```

### Consistent Citation Keys

Format: `author_year_firstword`

```
vaswani_2017_attention
devlin_2019_bert
brown_2020_language
```

---

## Common Citation Formats

### Conference Paper

```bibtex
@inproceedings{vaswani_2017_attention,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and others},
  booktitle = {Advances in Neural Information Processing Systems},
  volume = {30},
  year = {2017}
}
```

### Journal Article

```bibtex
@article{hochreiter_1997_long,
  title = {Long Short-Term Memory},
  author = {Hochreiter, Sepp and Schmidhuber, J{\"u}rgen},
  journal = {Neural Computation},
  volume = {9},
  number = {8},
  pages = {1735--1780},
  year = {1997}
}
```

### arXiv Preprint

```bibtex
@misc{brown_2020_language,
  title = {Language Models are Few-Shot Learners},
  author = {Brown, Tom and Mann, Benjamin and others},
  year = {2020},
  eprint = {2005.14165},
  archiveprefix = {arXiv},
  primaryclass = {cs.CL}
}
```

---

## Summary: Citation Rules

| Situation | Action |
|-----------|--------|
| Found paper, got DOI, fetched BibTeX | Use the citation |
| Found paper, no DOI | Use arXiv BibTeX or manual entry |
| Paper exists but can't fetch BibTeX | Mark placeholder, inform scientist |
| Uncertain if paper exists | Mark `[CITATION NEEDED]` |
| "I think there's a paper about X" | **NEVER cite** - search first |

---

## API Resources

- Semantic Scholar: https://api.semanticscholar.org/api-docs/
- CrossRef: https://www.crossref.org/documentation/retrieve-metadata/rest-api/
- arXiv: https://info.arxiv.org/help/api/basics.html
- OpenAlex: https://docs.openalex.org/

**Python Libraries:**
- `pip install semanticscholar`
- `pip install arxiv`
- `pip install habanero` (CrossRef)
