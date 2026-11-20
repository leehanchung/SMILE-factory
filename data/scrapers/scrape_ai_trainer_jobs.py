#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "requests>=2.34.2",
#     "beautifulsoup4>=4.15.0",
#     "lxml>=6.1.3",
# ]
# ///
# Copyright 2023 Hanchung Lee
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
AI Trainer / Data Annotation Job Scraper
=========================================
Scrapes job postings for AI trainer, AI tutor, and data annotation roles
for LLM training from multiple online job boards and company career pages.

Each discovered job posting is saved as an individual Markdown file in
the `job_postings/` directory (sibling to this script).

Usage (from data/scrapers/):
    uv run scrape_ai_trainer_jobs.py [--output-dir DIR] [--format md|json]

Requirements:
    Declared inline (PEP 723 `# /// script` block above); `uv run` installs
    them into an ephemeral environment. Lower bounds exclude releases with
    known CVEs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import quote_plus, urljoin

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SEARCH_QUERIES = [
    "AI trainer data annotation LLM",
    "AI tutor data annotation LLM",
    "AI trainer RLHF",
    "LLM data annotator remote",
    "AI model trainer",
    "data annotation AI training",
    "AI trainer prompt evaluation",
    "RLHF specialist",
    "AI training data labeling",
]

TARGET_COMPANIES = [
    "xAI",
    "SuperAnnotate",
    "YO IT Consulting",
    "Prolific Academic",
    "Prolific",
    "Embedding VC",
    "Human Signal",
    "HumanSignal",
    "Data Annotation",
    "DataAnnotation",
    "Juji",
    "Handshake",
    "Mercor",
    "Collide Capital",
    "CloudDevs",
    "Recruiting from Scratch",
    "BUKI",
    "Outlier",
    "Scale AI",
    "Remotasks",
    "Mindrift",
    "Gloz",
    "Alignerr",
    "Appen",
    "LXT",
    "Toloka",
    "Anuttacon",
    "Welocalize",
    "RWS",
    "RWS TrainAI",
    "OpenTrain AI",
    "Labelbox",
    "Sama",
    "Cloudfactory",
    "Braintrust",
    "Second Talent",
]

# Direct career page URLs for target companies
CAREER_PAGES = {
    "xAI": [
        "https://x.ai/careers/open-roles",
        "https://job-boards.greenhouse.io/xai",
    ],
    "SuperAnnotate": [
        "https://www.superannotate.com/careers",
        "https://jobs.lever.co/superannotate",
    ],
    "Prolific": [
        "https://www.prolific.com/careers",
        "https://job-boards.greenhouse.io/prolific",
    ],
    "HumanSignal": [
        "https://humansignal.com/careers/",
        "https://job-boards.greenhouse.io/humansignal",
    ],
    "DataAnnotation": [
        "https://www.dataannotation.tech/",
    ],
    "Juji": [
        "https://juji.io/career/",
    ],
    "Mercor": [
        "https://www.mercor.com/careers/",
    ],
    "Outlier": [
        "https://outlier.ai/",
    ],
    "Scale AI": [
        "https://scale.com/careers",
    ],
    "Mindrift": [
        "https://mindrift.ai/apply",
    ],
    "Toloka": [
        "https://toloka.ai/careers",
    ],
    "LXT": [
        "https://www.lxt.ai/jobs/",
    ],
    "Anuttacon": [
        "https://weworkremotely.com/remote-jobs/anuttacon-ai-trainer-llm",
    ],
    "RWS TrainAI": [
        "https://jobs.lever.co/rws",
    ],
    "Handshake": [
        "https://joinhandshake.com/fellowship-program/",
    ],
}

# Job board search URL templates
JOB_BOARDS = {
    "Indeed": "https://www.indeed.com/jobs?q={query}&l=Remote",
    "ZipRecruiter": "https://www.ziprecruiter.com/jobs-search?search={query}&location=Remote",
    "Glassdoor": "https://www.glassdoor.com/Job/remote-{slug}-jobs-SRCH_IL.0,6_IS11047_KO7,{end}.htm",
    "LinkedIn": "https://www.linkedin.com/jobs/search/?keywords={query}&location=Remote",
    "WeWorkRemotely": "https://weworkremotely.com/remote-jobs/search?term={query}",
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data Model
# ---------------------------------------------------------------------------


@dataclass
class JobPosting:
    """Represents a single job posting."""

    title: str
    company: str
    location: str = "Remote"
    url: str = ""
    source: str = ""  # e.g. "Indeed", "xAI Careers"
    description: str = ""
    compensation: str = ""
    job_type: str = ""  # full-time, part-time, contract, freelance
    date_posted: str = ""
    date_scraped: str = field(
        default_factory=lambda: datetime.now().strftime("%Y-%m-%d")
    )
    date_first_seen: str = ""  # set by history tracker on first discovery
    date_last_seen: str = ""   # updated each run
    status: str = "active"     # active, expired, unknown
    requirements: list[str] = field(default_factory=list)
    responsibilities: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    job_category: str = "Annotation/Contract"  # "Annotation/Contract" or "Corporate/In-House"

    @property
    def dedup_key(self) -> str:
        """Stable key for dedup and history tracking."""
        if self.url:
            return self.url
        return f"{self.company}|{self.title}".lower()

    @property
    def slug(self) -> str:
        """URL-safe slug for filenames."""
        raw = f"{self.company}_{self.title}".lower()
        raw = re.sub(r"[^a-z0-9]+", "_", raw)
        raw = raw.strip("_")[:80]
        # append short hash for uniqueness
        h = hashlib.md5(self.url.encode() if self.url else raw.encode()).hexdigest()[:6]
        return f"{raw}_{h}"


# ---------------------------------------------------------------------------
# Scrapers
# ---------------------------------------------------------------------------


class BaseScraper:
    """Base class with shared HTTP helpers."""

    session: requests.Session

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update(HEADERS)

    def get(self, url: str, **kwargs) -> Optional[BeautifulSoup]:
        try:
            resp = self.session.get(url, timeout=30, **kwargs)
            resp.raise_for_status()
            return BeautifulSoup(resp.text, "lxml")
        except Exception as exc:
            log.warning("GET %s failed: %s", url, exc)
            return None

    def get_text(self, url: str, **kwargs) -> Optional[str]:
        try:
            resp = self.session.get(url, timeout=30, **kwargs)
            resp.raise_for_status()
            return resp.text
        except Exception as exc:
            log.warning("GET %s failed: %s", url, exc)
            return None


class IndeedScraper(BaseScraper):
    """Scrape Indeed search results."""

    name = "Indeed"

    def search(self, query: str, max_pages: int = 3) -> list[JobPosting]:
        jobs: list[JobPosting] = []
        for page in range(max_pages):
            url = (
                f"https://www.indeed.com/jobs?q={quote_plus(query)}"
                f"&l=Remote&start={page * 10}"
            )
            soup = self.get(url)
            if not soup:
                break

            cards = soup.select("div.job_seen_beacon, div.jobsearch-ResultsList > div")
            for card in cards:
                title_el = card.select_one("h2.jobTitle a, h2 a")
                company_el = card.select_one(
                    "span[data-testid='company-name'], span.companyName"
                )
                location_el = card.select_one(
                    "div[data-testid='text-location'], div.companyLocation"
                )
                if not title_el:
                    continue
                title = title_el.get_text(strip=True)
                href = title_el.get("href", "")
                if href and not href.startswith("http"):
                    href = urljoin("https://www.indeed.com", href)
                jobs.append(
                    JobPosting(
                        title=title,
                        company=company_el.get_text(strip=True) if company_el else "",
                        location=(
                            location_el.get_text(strip=True) if location_el else "Remote"
                        ),
                        url=href,
                        source="Indeed",
                        tags=["AI trainer", "data annotation", "LLM"],
                    )
                )
            time.sleep(2)  # polite delay
        return jobs


class GreenhouseScraper(BaseScraper):
    """Scrape Greenhouse job boards (used by xAI, Prolific, HumanSignal, etc.)."""

    name = "Greenhouse"

    def scrape_board(self, board_url: str, company: str) -> list[JobPosting]:
        jobs: list[JobPosting] = []
        soup = self.get(board_url)
        if not soup:
            return jobs

        # Greenhouse board pages list jobs in sections
        openings = soup.select("div.opening a, tr.job-post a, a[data-mapped='true']")
        if not openings:
            # Try JSON API endpoint
            json_url = board_url.rstrip("/") + ".json" if "greenhouse" in board_url else None
            if json_url:
                text = self.get_text(json_url)
                if text:
                    try:
                        data = json.loads(text)
                        if isinstance(data, dict) and "jobs" in data:
                            for j in data["jobs"]:
                                title = j.get("title", "")
                                if self._is_relevant(title):
                                    jobs.append(
                                        JobPosting(
                                            title=title,
                                            company=company,
                                            location=j.get("location", {}).get(
                                                "name", "Remote"
                                            ),
                                            url=j.get("absolute_url", board_url),
                                            source=f"{company} Careers (Greenhouse)",
                                            tags=["AI trainer", "data annotation"],
                                        )
                                    )
                    except json.JSONDecodeError:
                        pass
            return jobs

        for link in openings:
            title = link.get_text(strip=True)
            href = link.get("href", "")
            if href and not href.startswith("http"):
                href = urljoin(board_url, href)
            if self._is_relevant(title):
                jobs.append(
                    JobPosting(
                        title=title,
                        company=company,
                        url=href,
                        source=f"{company} Careers (Greenhouse)",
                        tags=["AI trainer", "data annotation"],
                    )
                )
        return jobs

    @staticmethod
    def _is_relevant(title: str) -> bool:
        title_lower = title.lower()
        keywords = [
            "ai trainer",
            "ai tutor",
            "data annot",
            "rlhf",
            "llm",
            "data label",
            "model trainer",
            "annotation",
            "evaluator",
            "human feedback",
            "prompt",
            "content review",
            "tutor",
        ]
        return any(kw in title_lower for kw in keywords)


class LeverScraper(BaseScraper):
    """Scrape Lever job boards (used by SuperAnnotate, RWS, etc.)."""

    name = "Lever"

    def scrape_board(self, board_url: str, company: str) -> list[JobPosting]:
        jobs: list[JobPosting] = []
        soup = self.get(board_url)
        if not soup:
            return jobs

        postings = soup.select("div.posting a.posting-title, a.posting-btn-submit")
        if not postings:
            postings = soup.select("a[href*='/jobs/']")

        for link in postings:
            title = link.get_text(strip=True)
            href = link.get("href", "")
            if href and not href.startswith("http"):
                href = urljoin(board_url, href)
            if GreenhouseScraper._is_relevant(title):
                jobs.append(
                    JobPosting(
                        title=title,
                        company=company,
                        url=href,
                        source=f"{company} Careers (Lever)",
                        tags=["AI trainer", "data annotation"],
                    )
                )
        return jobs


class GenericCareerPageScraper(BaseScraper):
    """Scrape generic career pages by looking for job-related links."""

    name = "GenericCareer"

    def scrape(self, url: str, company: str) -> list[JobPosting]:
        jobs: list[JobPosting] = []
        soup = self.get(url)
        if not soup:
            return jobs

        # Find all links that might be job postings
        for link in soup.find_all("a", href=True):
            text = link.get_text(strip=True)
            href = link["href"]
            if not href.startswith("http"):
                href = urljoin(url, href)
            if GreenhouseScraper._is_relevant(text):
                jobs.append(
                    JobPosting(
                        title=text,
                        company=company,
                        url=href,
                        source=f"{company} Careers",
                        tags=["AI trainer", "data annotation"],
                    )
                )
        return jobs


class ZipRecruiterScraper(BaseScraper):
    """Scrape ZipRecruiter search results."""

    name = "ZipRecruiter"

    def search(self, query: str) -> list[JobPosting]:
        jobs: list[JobPosting] = []
        url = f"https://www.ziprecruiter.com/jobs-search?search={quote_plus(query)}&location=Remote"
        soup = self.get(url)
        if not soup:
            return jobs

        cards = soup.select("article.job_result, div.job_content")
        for card in cards:
            title_el = card.select_one("h2 a, a.job_link")
            company_el = card.select_one("a.t_org_link, span.t_org_link")
            if not title_el:
                continue
            href = title_el.get("href", "")
            if href and not href.startswith("http"):
                href = urljoin("https://www.ziprecruiter.com", href)
            jobs.append(
                JobPosting(
                    title=title_el.get_text(strip=True),
                    company=company_el.get_text(strip=True) if company_el else "",
                    url=href,
                    source="ZipRecruiter",
                    tags=["AI trainer", "data annotation", "LLM"],
                )
            )
        return jobs


class WeWorkRemotelyScraper(BaseScraper):
    """Scrape WeWorkRemotely."""

    name = "WeWorkRemotely"

    def search(self, query: str) -> list[JobPosting]:
        jobs: list[JobPosting] = []
        url = f"https://weworkremotely.com/remote-jobs/search?term={quote_plus(query)}"
        soup = self.get(url)
        if not soup:
            return jobs

        for li in soup.select("li.feature, li.new"):
            link = li.select_one("a[href*='/remote-jobs/']")
            if not link:
                continue
            title_el = link.select_one("span.title")
            company_el = link.select_one("span.company")
            title = title_el.get_text(strip=True) if title_el else link.get_text(strip=True)
            href = link.get("href", "")
            if href and not href.startswith("http"):
                href = urljoin("https://weworkremotely.com", href)
            jobs.append(
                JobPosting(
                    title=title,
                    company=company_el.get_text(strip=True) if company_el else "",
                    url=href,
                    source="WeWorkRemotely",
                    location="Remote",
                    tags=["AI trainer", "data annotation", "LLM"],
                )
            )
        return jobs


# ---------------------------------------------------------------------------
# Markdown Generator
# ---------------------------------------------------------------------------


def job_to_markdown(job: JobPosting) -> str:
    """Convert a JobPosting to a Markdown document."""
    lines = [
        f"# {job.title}",
        "",
        f"**Company:** {job.company}",
        f"**Location:** {job.location}",
        f"**Source:** {job.source}",
    ]

    # --- Date / freshness block ---
    if job.date_posted:
        lines.append(f"**Date Posted:** {job.date_posted}")
    lines.append(f"**First Seen:** {job.date_first_seen or job.date_scraped}")
    lines.append(f"**Last Verified:** {job.date_last_seen or job.date_scraped}")
    status_label = {
        "new": "🆕 New",
        "active": "✅ Active",
        "possibly_expired": "⚠️ Possibly Expired",
    }.get(job.status, job.status or "unknown")
    lines.append(f"**Status:** {status_label}")

    if job.job_type:
        lines.append(f"**Job Type:** {job.job_type}")
    if job.job_category and job.job_category != "Annotation/Contract":
        lines.append(f"**Category:** {job.job_category}")
    if job.compensation:
        lines.append(f"**Compensation:** {job.compensation}")
    if job.url:
        lines.append(f"**Apply:** [{job.url}]({job.url})")

    lines.append("")

    if job.description:
        lines.extend(["## Description", "", job.description, ""])

    if job.responsibilities:
        lines.extend(["## Responsibilities", ""])
        for r in job.responsibilities:
            lines.append(f"- {r}")
        lines.append("")

    if job.requirements:
        lines.extend(["## Requirements", ""])
        for r in job.requirements:
            lines.append(f"- {r}")
        lines.append("")

    if job.tags:
        lines.extend(["## Tags", "", ", ".join(f"`{t}`" for t in job.tags), ""])

    lines.extend([
        "---",
        f"*First seen {job.date_first_seen or job.date_scraped} "
        f"| Last verified {job.date_last_seen or job.date_scraped} "
        f"| AI Trainer Job Scraper*",
    ])

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main Orchestrator
# ---------------------------------------------------------------------------


HISTORY_FILE = "scrape_history.json"


def load_history(output_dir: Path) -> dict:
    """
    Load the scrape history ledger.

    Format:
    {
        "<dedup_key>": {
            "slug": "...",
            "title": "...",
            "company": "...",
            "date_first_seen": "YYYY-MM-DD",
            "date_last_seen": "YYYY-MM-DD",
            "status": "active",
            "run_count": 3
        },
        ...
    }
    """
    path = output_dir / HISTORY_FILE
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            log.warning("Could not load history: %s", exc)
    return {}


def save_history(history: dict, output_dir: Path) -> None:
    """Persist the scrape history ledger."""
    path = output_dir / HISTORY_FILE
    path.write_text(json.dumps(history, indent=2, ensure_ascii=False), encoding="utf-8")
    log.info("History saved: %s (%d entries)", path.name, len(history))


def deduplicate(jobs: list[JobPosting]) -> list[JobPosting]:
    """Remove duplicate postings based on dedup_key."""
    seen: set[str] = set()
    unique: list[JobPosting] = []
    for j in jobs:
        key = j.dedup_key
        if key not in seen:
            seen.add(key)
            unique.append(j)
    return unique


def reconcile_with_history(
    jobs: list[JobPosting], output_dir: Path
) -> tuple[list[JobPosting], dict]:
    """
    Merge new scrape results with the history ledger.

    - New jobs get date_first_seen = today.
    - Returning jobs get date_last_seen updated.
    - Jobs in history but NOT in current run get status='possibly_expired'
      (after being absent for 2+ consecutive runs).

    Returns (merged_jobs, updated_history).
    """
    today = datetime.now().strftime("%Y-%m-%d")
    history = load_history(output_dir)

    current_keys: set[str] = set()
    merged: list[JobPosting] = []

    for job in jobs:
        key = job.dedup_key
        current_keys.add(key)

        if key in history:
            # Returning job — update last_seen
            entry = history[key]
            job.date_first_seen = entry["date_first_seen"]
            job.date_last_seen = today
            job.status = "active"
            entry["date_last_seen"] = today
            entry["status"] = "active"
            entry["run_count"] = entry.get("run_count", 0) + 1
        else:
            # Brand-new job
            job.date_first_seen = today
            job.date_last_seen = today
            job.status = "new"
            history[key] = {
                "slug": job.slug,
                "title": job.title,
                "company": job.company,
                "date_first_seen": today,
                "date_last_seen": today,
                "status": "new",
                "run_count": 1,
            }

        merged.append(job)

    # Mark jobs absent from this run
    for key, entry in history.items():
        if key not in current_keys:
            if entry.get("status") != "possibly_expired":
                entry["status"] = "possibly_expired"
                entry["absent_since"] = today
                log.info(
                    "Marked possibly expired: %s — %s",
                    entry.get("company", "?"),
                    entry.get("title", "?"),
                )

    return merged, history


def run_scrapers() -> list[JobPosting]:
    """Run all scrapers and aggregate results."""
    all_jobs: list[JobPosting] = []

    # 1. Indeed
    log.info("=== Scraping Indeed ===")
    indeed = IndeedScraper()
    for q in SEARCH_QUERIES[:4]:  # top queries
        log.info("  Query: %s", q)
        all_jobs.extend(indeed.search(q, max_pages=2))
        time.sleep(1)

    # 2. ZipRecruiter
    log.info("=== Scraping ZipRecruiter ===")
    zr = ZipRecruiterScraper()
    for q in SEARCH_QUERIES[:3]:
        log.info("  Query: %s", q)
        all_jobs.extend(zr.search(q))
        time.sleep(1)

    # 3. WeWorkRemotely
    log.info("=== Scraping WeWorkRemotely ===")
    wwr = WeWorkRemotelyScraper()
    for q in ["AI trainer", "data annotation", "LLM trainer"]:
        log.info("  Query: %s", q)
        all_jobs.extend(wwr.search(q))
        time.sleep(1)

    # 4. Greenhouse boards (xAI, Prolific, HumanSignal)
    log.info("=== Scraping Greenhouse Boards ===")
    gh = GreenhouseScraper()
    for company, urls in CAREER_PAGES.items():
        for u in urls:
            if "greenhouse" in u:
                log.info("  %s: %s", company, u)
                all_jobs.extend(gh.scrape_board(u, company))
                time.sleep(1)

    # 5. Lever boards (SuperAnnotate, RWS)
    log.info("=== Scraping Lever Boards ===")
    lever = LeverScraper()
    for company, urls in CAREER_PAGES.items():
        for u in urls:
            if "lever" in u:
                log.info("  %s: %s", company, u)
                all_jobs.extend(lever.scrape_board(u, company))
                time.sleep(1)

    # 6. Generic career pages
    log.info("=== Scraping Generic Career Pages ===")
    generic = GenericCareerPageScraper()
    for company, urls in CAREER_PAGES.items():
        for u in urls:
            if "greenhouse" not in u and "lever" not in u:
                log.info("  %s: %s", company, u)
                all_jobs.extend(generic.scrape(u, company))
                time.sleep(1)

    log.info("Total raw results: %d", len(all_jobs))
    return all_jobs


def save_jobs(
    jobs: list[JobPosting], output_dir: Path, fmt: str = "md"
) -> None:
    """Write each job posting to its own file, with history tracking."""
    output_dir.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")
    now_ts = datetime.now().strftime("%Y-%m-%d %H:%M")

    # --- Reconcile with history for date tracking ---
    jobs, history = reconcile_with_history(jobs, output_dir)

    new_count = sum(1 for j in jobs if j.status == "new")
    active_count = sum(1 for j in jobs if j.status == "active")

    for job in jobs:
        if fmt == "md":
            content = job_to_markdown(job)
            filepath = output_dir / f"{job.slug}.md"
        else:
            content = json.dumps(asdict(job), indent=2)
            filepath = output_dir / f"{job.slug}.json"

        filepath.write_text(content, encoding="utf-8")
        log.info("Saved: %s", filepath.name)

    # --- Save history ledger ---
    save_history(history, output_dir)

    # --- Build INDEX grouped by company, with date info ---
    companies: dict[str, list[JobPosting]] = {}
    for job in jobs:
        companies.setdefault(job.company, []).append(job)

    index_lines = [
        "# AI Trainer / Data Annotation Job Postings",
        "",
        f"*Last run: {now_ts}*",
        f"*Total postings: {len(jobs)}  |  New this run: {new_count}  "
        f"|  Returning: {active_count}*",
        "",
        "> **How updates work:** Each run compares against `scrape_history.json`.",
        "> New postings are marked 🆕, returning ones get their *Last Verified*",
        "> date bumped. Postings absent from a run are flagged ⚠️ Possibly Expired.",
        "> Re-running the script adds new finds without losing old ones.",
        "",
    ]

    for company in sorted(companies.keys()):
        postings = companies[company]
        index_lines.append(f"### {company} ({len(postings)} postings)")
        index_lines.append("")
        for job in postings:
            fname = f"{job.slug}.md" if fmt == "md" else f"{job.slug}.json"
            status_icon = {"new": "🆕", "active": "✅"}.get(job.status, "")
            first = job.date_first_seen or job.date_scraped
            last = job.date_last_seen or job.date_scraped
            index_lines.append(
                f"- {status_icon} [{job.title}]({fname}) — "
                f"first seen {first}, last verified {last}"
            )
        index_lines.append("")

    index_lines.extend(["---", f"*Generated by AI Trainer Job Scraper — {now_ts}*"])
    (output_dir / "INDEX.md").write_text("\n".join(index_lines), encoding="utf-8")
    log.info("Index saved: INDEX.md")


def main():
    parser = argparse.ArgumentParser(
        description="Scrape AI Trainer / Data Annotation job postings"
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).parent / "job_postings",
        help="Directory to save job posting files (default: ./job_postings/ next to this script)",
    )
    parser.add_argument(
        "--format",
        choices=["md", "json"],
        default="md",
        help="Output format (default: md)",
    )
    parser.add_argument(
        "--skip-scrape",
        action="store_true",
        help="Skip live scraping; only generate from pre-collected data",
    )
    args = parser.parse_args()

    # Try to load expanded job data from job_data.py
    try:
        from job_data import get_all_jobs
        expanded_jobs = get_all_jobs()
        log.info("Loaded %d jobs from expanded job_data.py", len(expanded_jobs))
    except ImportError:
        expanded_jobs = []
        log.warning("job_data.py not found — using built-in pre-collected data only")

    if args.skip_scrape:
        log.info("Skipping live scrape — generating from pre-collected data")
        jobs = get_precollected_jobs()
    else:
        log.info("Starting live scrape...")
        try:
            jobs = run_scrapers()
        except Exception as exc:
            log.error("Live scrape failed: %s — falling back to pre-collected data", exc)
            jobs = get_precollected_jobs()

        # Merge with pre-collected to ensure completeness
        precollected = get_precollected_jobs()
        jobs.extend(precollected)

    # Merge expanded data
    jobs.extend(expanded_jobs)

    jobs = deduplicate(jobs)
    log.info("Unique postings after dedup: %d", len(jobs))

    save_jobs(jobs, args.output_dir, args.format)
    log.info("Done! %d postings saved to %s", len(jobs), args.output_dir)


# ---------------------------------------------------------------------------
# Pre-collected Job Data (from manual research — April 2026)
# ---------------------------------------------------------------------------


def get_precollected_jobs() -> list[JobPosting]:
    """
    Return a curated list of verified job postings found via web research.
    This ensures results even when live scraping is blocked by anti-bot measures.
    """
    return [
        # --- xAI ---
        JobPosting(
            title="AI Tutor (Full-Time)",
            company="xAI",
            location="Remote",
            url="https://job-boards.greenhouse.io/xai/jobs/4595198007",
            source="xAI Careers (Greenhouse)",
            description=(
                "As an AI Tutor, you will play an essential role in advancing xAI's "
                "mission by supporting the training and refinement of Grok. AI Tutors "
                "teach AI models about how people interact and react, as well as how "
                "people approach issues and discussions."
            ),
            compensation="$14–$96/hr depending on specialization",
            job_type="Full-Time",
            responsibilities=[
                "Labeling and annotating data in text, voice, and video formats",
                "Supporting AI model training through high-quality annotations",
                "Evaluating and providing expert reasoning using proprietary labeling tools",
                "Working closely with technical teams to refine AI tasks",
            ],
            requirements=[
                "Strong analytical and critical thinking skills",
                "Excellent written communication",
                "Comfort with recording audio/video sessions",
                "Domain expertise is a plus",
            ],
            tags=["AI tutor", "Grok", "xAI", "RLHF", "data annotation"],
        ),
        JobPosting(
            title="AI Tutor - Crypto",
            company="xAI",
            location="Remote",
            url="https://job-boards.greenhouse.io/xai/jobs/5040344007",
            source="xAI Careers (Greenhouse)",
            description=(
                "As a Crypto Expert, you will be vital in enhancing xAI's frontier AI "
                "models by supplying high-quality annotations, evaluations, and expert "
                "reasoning using proprietary labeling tools, focusing on cryptocurrency "
                "and digital asset markets."
            ),
            compensation="Competitive hourly rate",
            job_type="Contract / Full-Time",
            responsibilities=[
                "Provide expert annotations on crypto and digital asset topics",
                "Evaluate model outputs for accuracy in financial/crypto domains",
                "Work with technical teams on refining crypto-related AI tasks",
            ],
            requirements=[
                "Deep knowledge of cryptocurrency and digital asset markets",
                "Experience with blockchain technology",
                "Strong analytical skills",
            ],
            tags=["AI tutor", "crypto", "xAI", "Grok", "data annotation"],
        ),
        JobPosting(
            title="Video Games Tutor",
            company="xAI",
            location="Remote",
            url="https://job-boards.greenhouse.io/xai/jobs/4879839007",
            source="xAI Careers (Greenhouse)",
            description=(
                "As an AI Tutor specialized in video games, you will contribute to "
                "xAI's mission by training and refining Grok to excel in video game "
                "concepts, mechanics, and generation."
            ),
            job_type="Contract / Full-Time",
            responsibilities=[
                "Train Grok on video game concepts, mechanics, and generation",
                "Curate and annotate high-quality gaming data",
                "Evaluate AI-generated game content for quality and engagement",
            ],
            requirements=[
                "Deep knowledge of video games across genres",
                "Understanding of game design principles",
                "Strong written communication skills",
            ],
            tags=["AI tutor", "video games", "xAI", "Grok"],
        ),
        JobPosting(
            title="Multilingual Audio Tutor",
            company="xAI",
            location="Remote",
            url="https://job-boards.greenhouse.io/xai/jobs/4879853007",
            source="xAI Careers (Greenhouse)",
            description=(
                "As an AI Tutor specialized in multilingual audio capabilities, you "
                "will train and refine Grok to excel in voice interactions, speech "
                "recognition, and auditory experiences across diverse languages, "
                "accents, and cultural contexts."
            ),
            job_type="Contract / Full-Time",
            responsibilities=[
                "Curate and annotate high-quality audio data across languages",
                "Evaluate speech recognition outputs",
                "Train models on voice interaction patterns",
            ],
            requirements=[
                "Fluency in multiple languages",
                "Experience with audio/speech technologies",
                "Cultural sensitivity and awareness",
            ],
            tags=["AI tutor", "multilingual", "audio", "xAI", "Grok"],
        ),
        JobPosting(
            title="AI Tutor - English (Foreign Accents)",
            company="xAI",
            location="Remote",
            url="https://job-boards.greenhouse.io/xai/jobs/5098929007",
            source="xAI Careers (Greenhouse)",
            description=(
                "AI Tutor role focused on English language with foreign accents, "
                "contributing to Grok's ability to understand diverse English speakers."
            ),
            job_type="Contract / Full-Time",
            tags=["AI tutor", "English", "accents", "xAI", "Grok", "speech"],
        ),
        JobPosting(
            title="AI Legal and Compliance Tutor",
            company="xAI",
            location="Remote",
            url="https://x.ai/careers/open-roles",
            source="xAI Careers",
            description=(
                "xAI is hiring legal pros—JD holders and compliance specialists—to "
                "generate, annotate, and evaluate complex legal data to train Grok's "
                "language models."
            ),
            compensation="Competitive",
            job_type="Contract / Full-Time",
            responsibilities=[
                "Generate and annotate legal training data",
                "Evaluate AI outputs for legal accuracy",
                "Support compliance-related AI training",
            ],
            requirements=[
                "JD or equivalent legal qualification",
                "Experience in legal compliance",
                "Strong analytical writing skills",
            ],
            tags=["AI tutor", "legal", "compliance", "xAI", "Grok"],
        ),
        JobPosting(
            title="Data Annotator",
            company="xAI",
            location="Remote",
            url="https://jobs.weekday.works/xai-data-annotator",
            source="xAI Careers (Weekday)",
            description=(
                "As a Data Annotator at xAI, you will be responsible for annotating "
                "diverse data sets to help train and improve machine learning models."
            ),
            job_type="Contract",
            responsibilities=[
                "Annotate diverse datasets for ML model training",
                "Follow detailed annotation guidelines",
                "Ensure high quality and consistency in labeled data",
            ],
            tags=["data annotation", "xAI", "machine learning"],
        ),
        # --- SuperAnnotate ---
        JobPosting(
            title="AI Data Trainer",
            company="SuperAnnotate",
            location="Remote",
            url="https://www.superannotate.com/careers",
            source="SuperAnnotate Careers",
            description=(
                "Generate engaging and informative content for various topics and fields. "
                "Create detailed prompts and responses to guide AI learning. Evaluate and "
                "rank AI responses to enhance model accuracy. Test AI models for potential "
                "inaccuracies or biases."
            ),
            compensation="Project-based competitive compensation",
            job_type="Freelance / Contract",
            responsibilities=[
                "Create detailed prompts in various topics to guide AI learning",
                "Evaluate and rank AI responses to enhance model accuracy",
                "Test AI models for potential inaccuracies or biases",
                "Generate engaging content for AI training",
            ],
            requirements=[
                "Strong writing skills and domain expertise",
                "Ability to evaluate AI outputs critically",
                "Enthusiasm for integrating expertise into AI development",
            ],
            tags=["AI trainer", "data annotation", "SuperAnnotate", "RLHF"],
        ),
        # --- YO IT Consulting ---
        JobPosting(
            title="AI Trainer/Data Annotator - Remote",
            company="YO IT Consulting",
            location="Remote",
            url="https://www.indeed.com/viewjob?jk=03e62b9e11b929ba",
            source="Indeed",
            description=(
                "YO IT Consulting is collaborating with a leading AI lab to contract "
                "detail-oriented generalists for a data annotation project. Contractors "
                "will support AI systems development by categorizing and labeling diverse "
                "datasets using predefined taxonomies."
            ),
            compensation="Weekly payments via Stripe or Wise",
            job_type="Contract (Independent Contractor)",
            responsibilities=[
                "Synthesize information from large volumes of data",
                "Annotate and categorize text, images, and other data",
                "Apply predefined rubrics and taxonomies to produce structured outputs",
                "Flag inconsistencies or errors in datasets",
                "Contribute to AI system improvement through consistent annotation work",
            ],
            requirements=[
                "Ability to synthesize complex/high-volume information",
                "Strong critical reasoning and reading comprehension",
                "Written communication skills",
                "Prior experience applying rubrics/taxonomies preferred",
            ],
            tags=["AI trainer", "data annotation", "YO IT Consulting", "contract"],
        ),
        JobPosting(
            title="AI Trainer - Remote",
            company="YO IT Consulting",
            location="Remote",
            url="https://www.glassdoor.com/job-listing/ai-trainer-remote-yo-it-consulting-JV_KO0,17_KE18,34.htm?jl=1010044412091",
            source="Glassdoor",
            description=(
                "Remote AI Trainer position with YO IT Consulting supporting AI lab "
                "data annotation projects. Approximately 20 hours per week."
            ),
            job_type="Contract (Part-Time, ~20 hrs/week)",
            tags=["AI trainer", "YO IT Consulting", "remote", "part-time"],
        ),
        JobPosting(
            title="Legal Expert - AI Trainer",
            company="YO IT Consulting",
            location="Remote",
            url="https://www.usaremotejobs.app/job/yo-it-consulting-legal-expert-ai-trainer",
            source="USA Remote Jobs",
            description=(
                "Legal expert role as AI Trainer at YO IT Consulting, focusing on "
                "legal domain data annotation for AI training."
            ),
            job_type="Contract",
            requirements=[
                "Legal domain expertise",
                "Strong analytical skills",
                "Experience with structured data annotation",
            ],
            tags=["AI trainer", "legal", "YO IT Consulting", "domain expert"],
        ),
        # --- Prolific ---
        JobPosting(
            title="AI Data Annotation Participant",
            company="Prolific",
            location="Remote (Global)",
            url="https://www.prolific.com/data-annotation",
            source="Prolific Platform",
            description=(
                "Prolific connects users with paid academic and industry studies for "
                "AI training, human feedback, and data collection. Tasks include "
                "reviewing, labeling, and providing feedback on AI outputs—rating "
                "chatbot responses, identifying objects in AI-generated images, etc."
            ),
            compensation="Starting from $8/£6 per hour (fair pay guaranteed)",
            job_type="Freelance / Study-based",
            responsibilities=[
                "Rate how natural chatbot responses sound",
                "Identify objects in AI-generated images",
                "Review and label AI outputs",
                "Provide structured feedback on model performance",
            ],
            requirements=[
                "Create a Prolific account",
                "Pass AI Task Assessment for specialized studies",
                "Reliable internet connection",
            ],
            tags=["AI annotation", "Prolific", "research", "human feedback"],
        ),
        # --- HumanSignal ---
        JobPosting(
            title="Data Annotator - Architectural Floor Plans",
            company="HumanSignal",
            location="Remote",
            url="https://humansignal.com/careers/",
            source="HumanSignal Careers",
            description=(
                "Annotate architectural floor plans using Label Studio Enterprise "
                "platform for AI model training. Contribute to technology transforming "
                "how spaces are designed and visualized."
            ),
            job_type="Contract",
            responsibilities=[
                "Annotate architectural floor plans using Label Studio",
                "Follow detailed annotation guidelines",
                "Ensure quality standards in labeled data",
            ],
            requirements=[
                "Attention to detail",
                "Understanding of architectural drawings (preferred)",
                "Experience with annotation tools (preferred)",
            ],
            tags=["data annotation", "HumanSignal", "Label Studio", "architecture"],
        ),
        JobPosting(
            title="Content Review & Evaluation Specialist",
            company="HumanSignal",
            location="Remote",
            url="https://job-boards.greenhouse.io/humansignal",
            source="HumanSignal Careers (Greenhouse)",
            description=(
                "Evaluate educational content for AI development projects. "
                "Review and assess content quality for model training."
            ),
            job_type="Contract / Full-Time",
            tags=["content review", "HumanSignal", "AI evaluation", "education"],
        ),
        # --- DataAnnotation.tech ---
        # NOTE: single landing page — use #<track> fragments for unique dedup keys
        JobPosting(
            title="AI Training - Coding Expert",
            company="DataAnnotation",
            location="Remote",
            url="https://www.dataannotation.tech/#coding",
            source="DataAnnotation.tech",
            description=(
                "Train AI models by providing high-quality coding annotations, "
                "evaluations, and feedback. 100K+ experts earning $20-60+/hr in "
                "flexible remote work."
            ),
            compensation="$20–$60+/hr (specialists up to $100+/hr)",
            job_type="Freelance / Contract",
            responsibilities=[
                "Rank AI-generated code outputs",
                "Assess correctness of code solutions",
                "Provide structured feedback for LLM evaluation",
                "Create coding prompts and solutions",
            ],
            requirements=[
                "Strong coding skills in one or more languages",
                "Critical thinking ability",
                "Attention to detail",
            ],
            tags=["AI trainer", "coding", "DataAnnotation", "RLHF", "LLM"],
        ),
        JobPosting(
            title="AI Training - STEM Expert",
            company="DataAnnotation",
            location="Remote",
            url="https://www.dataannotation.tech/#stem",
            source="DataAnnotation.tech",
            description=(
                "Train AI models in STEM domains (science, technology, engineering, "
                "math). Evaluate and rank AI responses for accuracy."
            ),
            compensation="$20–$60+/hr",
            job_type="Freelance / Contract",
            tags=["AI trainer", "STEM", "DataAnnotation", "RLHF"],
        ),
        JobPosting(
            title="AI Training - Writing Expert",
            company="DataAnnotation",
            location="Remote",
            url="https://www.dataannotation.tech/#writing",
            source="DataAnnotation.tech",
            description=(
                "Train AI models in writing and language tasks. Evaluate and rank "
                "AI-generated text for quality, coherence, and accuracy."
            ),
            compensation="$20–$60+/hr",
            job_type="Freelance / Contract",
            tags=["AI trainer", "writing", "DataAnnotation", "RLHF"],
        ),
        JobPosting(
            title="FT/PT Remote AI Prompt Engineering & Evaluation",
            company="DataAnnotation",
            location="Remote",
            url="https://weworkremotely.com/remote-jobs/dataannotation-tech-ft-pt-remote-ai-prompt-engineering-evaluation-will-train",
            source="WeWorkRemotely",
            description=(
                "Full-time or part-time remote AI prompt engineering and evaluation "
                "role. Will train — no prior AI experience required."
            ),
            job_type="Full-Time / Part-Time",
            tags=["AI trainer", "prompt engineering", "DataAnnotation", "evaluation"],
        ),
        # --- Juji ---
        JobPosting(
            title="AI Trainer",
            company="Juji",
            location="San Jose, CA / Remote",
            url="https://juji.io/career/",
            source="Juji Careers",
            description=(
                "Teach AI assistants natural language understanding and communication "
                "skills. Ideal candidates are open-minded, multi-talented individuals "
                "who are sensitive to the nuances of interpersonal communication and "
                "adept at writing conversations."
            ),
            job_type="Full-Time",
            responsibilities=[
                "Teach AI assistants natural language understanding",
                "Write conversational training data",
                "Work with customers and new technologies",
                "Improve AI communication quality",
            ],
            requirements=[
                "Sensitivity to nuances of interpersonal communication",
                "Adept at writing conversations",
                "Comfortable working with customers and new technologies",
            ],
            tags=["AI trainer", "NLU", "Juji", "chatbot", "conversational AI"],
        ),
        # --- Handshake ---
        JobPosting(
            title="AI Training Fellow - Handshake AI Program",
            company="Handshake",
            location="Remote",
            url="https://joinhandshake.com/fellowship-program/",
            source="Handshake AI Fellowship",
            description=(
                "Paid, remote AI training work for experts and generalists. "
                "Connects students, graduates, and domain experts with remote AI "
                "training jobs for leading AI labs."
            ),
            compensation="$22–$30/hr generalist; $30–$150/hr Master's/PhD; $175–$300+/hr specialists",
            job_type="Fellowship / Contract",
            responsibilities=[
                "Provide domain expertise for AI model training",
                "Evaluate and annotate AI outputs",
                "Contribute to RLHF and alignment tasks",
            ],
            requirements=[
                "Students, graduates, or domain experts",
                "Subject expertise in STEM, humanities, law, or medicine",
            ],
            tags=["AI trainer", "fellowship", "Handshake", "RLHF", "academic"],
        ),
        # --- Mercor ---
        JobPosting(
            title="AI Model Specialist",
            company="Mercor",
            location="Remote",
            url="https://www.mercor.com/careers/",
            source="Mercor Careers",
            description=(
                "Mercor connects top AI labs (OpenAI, Google, Meta, Microsoft) with "
                "professionals and experts who work as contractors to label or generate "
                "data for AI model training."
            ),
            compensation="$16/hr entry; $70/hr expert; $70–$200+/hr engineering",
            job_type="Contract",
            responsibilities=[
                "Label and generate training data for AI models",
                "Provide domain-specific annotations",
                "Work with leading AI labs on model improvement",
            ],
            tags=["AI trainer", "data labeling", "Mercor", "contract"],
        ),
        # --- Collide Capital ---
        JobPosting(
            title="Data Entry Agent AI Trainer ($40-$50/hour)",
            company="LinkedIn (via Collide Capital)",
            location="Remote",
            url="https://jobs.collidecap.com/companies/linkedin-3-496a6401-d340-42f0-8d7a-d62312522866/jobs/68369524-data-entry-agent-ai-trainer-40-50-hour",
            source="Collide Capital Job Board",
            description=(
                "AI Trainer position focused on data entry agent training, posted "
                "through the Collide Capital job board network."
            ),
            compensation="$40–$50/hour",
            job_type="Contract",
            tags=["AI trainer", "data entry", "LinkedIn", "Collide Capital"],
        ),
        # --- CloudDevs ---
        JobPosting(
            title="AI (LLM) Fullstack Engineer",
            company="CloudDevs",
            location="Remote (LATAM preferred)",
            url="https://weworkremotely.com/remote-jobs/clouddevs-ai-llm-fullstack-engineer-3",
            source="WeWorkRemotely",
            description=(
                "CloudDevs is helping world-class, venture-backed AI startups find "
                "talented AI full-stack developers for LLM-related projects."
            ),
            job_type="Full-Time",
            tags=["AI engineer", "LLM", "CloudDevs", "full-stack"],
        ),
        # --- BUKI ---
        JobPosting(
            title="AI / Python Programming Tutor",
            company="BUKI",
            location="Las Vegas, NV / Remote",
            url="https://www.talent.com/view?id=194a9f348729",
            source="Talent.com",
            description=(
                "BUKI is an international marketplace for private teachers. Tutor "
                "position for Python programming and AI-related subjects."
            ),
            compensation="Varies ($70–$100/hr typical)",
            job_type="Freelance",
            tags=["AI tutor", "Python", "BUKI", "teaching"],
        ),
        JobPosting(
            title="Information Technology Tutor",
            company="BUKI",
            location="San Diego, CA / Remote",
            url="https://www.talent.com/view?id=3b0fa03d1d6b",
            source="Talent.com",
            description=(
                "IT tutor position through BUKI's international marketplace. "
                "Set your own price and schedule for private or group classes."
            ),
            job_type="Freelance",
            tags=["IT tutor", "BUKI", "teaching", "technology"],
        ),
        # --- Outlier (Scale AI) ---
        JobPosting(
            title="AI Trainer - Generalist",
            company="Outlier (Scale AI)",
            location="Remote",
            url="https://outlier.ai/",
            source="Outlier AI",
            description=(
                "Train the next generation of AI as a freelancer. Outlier connects "
                "experts with leading AI companies to provide human feedback that "
                "improves LLMs. 700K+ contributors working as AI trainers."
            ),
            compensation="$14–$30/hr generalist; higher for advanced degrees",
            job_type="Freelance / Contract",
            responsibilities=[
                "Evaluate LLM responses for quality and accuracy",
                "Provide human feedback (RLHF)",
                "Annotate and label data for model training",
                "Review AI-generated content",
            ],
            requirements=[
                "No AI experience needed",
                "Strong analytical skills",
                "Advanced degrees earn higher rates",
            ],
            tags=["AI trainer", "Outlier", "Scale AI", "RLHF", "LLM", "freelance"],
        ),
        JobPosting(
            title="AI Trainer - Coding Specialist",
            company="Outlier (Scale AI)",
            location="Remote",
            url="https://outlier.ai/",
            source="Outlier AI",
            description=(
                "Specialist coding track for AI training. Evaluate and annotate "
                "code-related AI outputs. Higher pay for coding expertise."
            ),
            compensation="$25–$50/hr",
            job_type="Freelance / Contract",
            tags=["AI trainer", "coding", "Outlier", "Scale AI", "specialist"],
        ),
        # --- Mindrift ---
        JobPosting(
            title="Freelance English Writer - AI Trainer",
            company="Mindrift",
            location="Remote (Global)",
            url="https://mindrift.ai/apply",
            source="Mindrift",
            description=(
                "Join 10,000+ experts earning $15–$100+/hr training AI models. "
                "Mindrift connects skilled contributors with AI training projects "
                "from leading tech companies. Part of Toloka."
            ),
            compensation="$15–$100+/hr",
            job_type="Freelance",
            responsibilities=[
                "Review and evaluate AI model outputs",
                "Provide structured human feedback",
                "Align AI responses with quality standards",
                "Contribute domain expertise to specialized projects",
            ],
            requirements=[
                "Strong English writing skills",
                "Analytical and critical thinking",
                "No AI experience required",
            ],
            tags=["AI trainer", "writing", "Mindrift", "Toloka", "freelance"],
        ),
        JobPosting(
            title="AI Trainer - Domain Expert (Coding/Finance/Law/Medicine)",
            company="Mindrift",
            location="Remote (Global)",
            url="https://mindrift.ai/apply",
            source="Mindrift",
            description=(
                "Specialized domain projects for experts in coding, finance, law, "
                "medicine, and linguistics. Higher pay for domain expertise."
            ),
            compensation="$40–$100+/hr for domain experts",
            job_type="Freelance",
            tags=["AI trainer", "domain expert", "Mindrift", "specialist"],
        ),
        # --- Toloka ---
        JobPosting(
            title="AI Trainer - Freelance Data Annotator",
            company="Toloka",
            location="Remote (Global)",
            url="https://toloka.ai/annotator_apply",
            source="Toloka",
            description=(
                "Toloka is a global crowdsourcing platform for data annotation, "
                "content evaluation, and AI training. Beginner-friendly with small "
                "task-based work for ML model training and evaluation."
            ),
            job_type="Freelance / Crowdsource",
            responsibilities=[
                "Complete data annotation microtasks",
                "Label text, images, and audio data",
                "Evaluate AI model outputs",
                "Participate in content moderation tasks",
            ],
            tags=["AI trainer", "data annotation", "Toloka", "crowdsource"],
        ),
        # --- LXT ---
        JobPosting(
            title="AI Data Annotation Specialist",
            company="LXT",
            location="Remote",
            url="https://www.lxt.ai/jobs/",
            source="LXT Careers",
            description=(
                "LXT is a global AI data annotation and training company focused on "
                "language, speech, and localization projects. Flexible part-time "
                "opportunities from home."
            ),
            compensation="Average ~$65.77/hr (varies by project)",
            job_type="Part-Time / Contract",
            responsibilities=[
                "Annotate and label linguistic data",
                "Transcribe and validate speech data",
                "Support language model training projects",
            ],
            tags=["data annotation", "LXT", "language", "speech", "localization"],
        ),
        # --- Anuttacon ---
        JobPosting(
            title="AI Trainer, LLM",
            company="Anuttacon",
            location="Remote",
            url="https://weworkremotely.com/remote-jobs/anuttacon-ai-trainer-llm",
            source="WeWorkRemotely",
            description=(
                "Anuttacon is an independent research lab pursuing humanistic general "
                "intelligence. Remote AI Trainer role for LLM training and evaluation."
            ),
            job_type="Contract / Remote",
            tags=["AI trainer", "LLM", "Anuttacon", "research"],
        ),
        JobPosting(
            title="Humanized AI Trainer",
            company="Anuttacon",
            location="Remote (Global)",
            url="https://nodesk.co/remote-jobs/anuttacon-humanized-ai-trainer/",
            source="NoDesk",
            description=(
                "100% remote Humanized AI Trainer role with no geographical restrictions. "
                "Focus on making AI more human-like in its interactions."
            ),
            job_type="Contract / Remote",
            tags=["AI trainer", "humanized AI", "Anuttacon", "remote"],
        ),
        # --- Welocalize ---
        JobPosting(
            title="Search Quality Rater / AI Trainer",
            company="Welocalize",
            location="Remote",
            url="https://www.welocalize.com/",
            source="Welocalize Careers",
            description=(
                "Welocalize provides AI training, data annotation, and linguistic "
                "evaluation work. Known for language-focused AI projects including "
                "search evaluation, translation quality assessment, and multilingual "
                "AI model training."
            ),
            job_type="Contract / Part-Time",
            responsibilities=[
                "Rate search quality results",
                "Evaluate advertisement quality",
                "Assess translation quality",
                "Support multilingual AI training",
            ],
            tags=["AI trainer", "search quality", "Welocalize", "multilingual"],
        ),
        # --- RWS TrainAI ---
        JobPosting(
            title="AI Data Specialist - TrainAI Community",
            company="RWS TrainAI",
            location="Remote (Global)",
            url="https://www.rws.com/artificial-intelligence/train-ai-data-services/trainai-community/",
            source="RWS TrainAI",
            description=(
                "Join the TrainAI community as an Online Rater, Data Collector, "
                "Data Annotator, Search Engine Evaluator, Ad Evaluator, or other "
                "project-specific AI training roles."
            ),
            compensation="$4–$20/hr depending on location and project",
            job_type="Freelance / Contract",
            responsibilities=[
                "Online content rating",
                "Data collection and annotation",
                "Search engine evaluation",
                "Ad quality evaluation",
            ],
            tags=["AI trainer", "data annotation", "RWS", "TrainAI", "evaluation"],
        ),
        # --- Appen ---
        JobPosting(
            title="AI Training Data Contributor",
            company="Appen",
            location="Remote (Global)",
            url="https://appen.com/",
            source="Appen",
            description=(
                "Appen is one of the longest-running AI data annotation companies. "
                "Offers both entry-level crowdwork tasks and specialized projects "
                "for AI model training."
            ),
            job_type="Freelance / Contract",
            tags=["AI trainer", "data annotation", "Appen", "crowdsource"],
        ),
        # --- Alignerr ---
        JobPosting(
            title="AI Alignment Specialist",
            company="Alignerr (Labelbox)",
            location="Remote",
            url="https://alignerr.com/",
            source="Alignerr",
            description=(
                "Alignerr specializes in cognitive labeling, decision evaluation, "
                "and ethical AI alignment tasks. Backed by Labelbox."
            ),
            job_type="Contract / Freelance",
            tags=["AI alignment", "Alignerr", "Labelbox", "ethical AI", "RLHF"],
        ),
        # --- Gloz ---
        JobPosting(
            title="AI Training - Language Specialist",
            company="Gloz",
            location="Remote",
            url="https://gloz.ai/",
            source="Gloz",
            description=(
                "Gloz is an AI training platform focused on language-based data "
                "annotation and LLM evaluation. Tasks include text review, response "
                "assessment, and human feedback for AI models."
            ),
            job_type="Freelance",
            tags=["AI trainer", "language", "Gloz", "LLM evaluation"],
        ),
        # --- OpenTrain AI ---
        JobPosting(
            title="Freelance AI Trainer / Data Labeler",
            company="OpenTrain AI",
            location="Remote (Global)",
            url="https://www.opentrain.ai/become-freelancer/",
            source="OpenTrain AI",
            description=(
                "Global network of pre-vetted AI Trainers and Data Labelers for "
                "LLM evaluation, RLHF, red teaming, and data labeling."
            ),
            job_type="Freelance",
            responsibilities=[
                "LLM evaluation and feedback",
                "RLHF annotation tasks",
                "Red teaming and safety evaluation",
                "Data labeling across domains",
            ],
            tags=["AI trainer", "data labeler", "OpenTrain AI", "RLHF", "red teaming"],
        ),
        # --- Embedding VC ---
        JobPosting(
            title="AI Video Generation Specialist",
            company="Embedding VC",
            location="Remote",
            url="https://wellfound.com/company/embedding-vc/jobs",
            source="Wellfound (AngelList)",
            description=(
                "Embedding VC portfolio company roles in AI video generation and "
                "related technical domains. 36 jobs listed as of April 2026."
            ),
            job_type="Full-Time / Contract",
            tags=["AI", "video generation", "Embedding VC", "startup"],
        ),
        # --- Recruiting from Scratch ---
        JobPosting(
            title="AI/ML Data Annotation Specialist",
            company="Recruiting from Scratch",
            location="Remote",
            url="https://www.recruitingfromscratch.com/",
            source="Recruiting from Scratch",
            description=(
                "Recruiting from Scratch places candidates in AI/ML data annotation "
                "and training roles at startups and tech companies."
            ),
            job_type="Full-Time / Contract",
            tags=["AI trainer", "data annotation", "staffing", "Recruiting from Scratch"],
        ),
        # --- Scale AI (direct) ---
        JobPosting(
            title="Data Operations - AI Training",
            company="Scale AI",
            location="San Francisco, CA / Remote",
            url="https://scale.com/careers",
            source="Scale AI Careers",
            description=(
                "Scale AI provides data infrastructure for AI companies. Data "
                "operations roles support RLHF, LLM evaluation, and enterprise "
                "AI applications."
            ),
            job_type="Full-Time",
            tags=["data operations", "Scale AI", "RLHF", "LLM", "enterprise"],
        ),
        # --- Braintrust ---
        JobPosting(
            title="Human Data Annotator for AI Training",
            company="Braintrust",
            location="Remote",
            url="https://www.usebraintrust.com/human-data",
            source="Braintrust",
            description=(
                "Braintrust provides human data annotators for AI training at scale. "
                "Connect with projects requiring annotation, labeling, and evaluation."
            ),
            job_type="Freelance / Contract",
            tags=["data annotation", "Braintrust", "AI training", "human feedback"],
        ),
        # --- Remotasks (Scale AI) ---
        JobPosting(
            title="AI Data Annotator - Computer Vision & NLP",
            company="Remotasks (Scale AI)",
            location="Remote (Global)",
            url="https://www.remotasks.com/",
            source="Remotasks",
            description=(
                "Remotasks focuses on computer vision, autonomous vehicles, and NLP "
                "annotation tasks. Part of Scale AI's ecosystem."
            ),
            compensation="$3–$20+/hr depending on task complexity",
            job_type="Freelance / Crowdsource",
            tags=["data annotation", "Remotasks", "Scale AI", "computer vision", "NLP"],
        ),
        # --- SME Careers (SuperAnnotate-affiliated) ---
        JobPosting(
            title="Subject Matter Expert - AI Training",
            company="SME Careers (SuperAnnotate)",
            location="Remote",
            url="https://sme.careers/",
            source="SME Careers",
            description=(
                "Expert career path for AI training through SuperAnnotate-affiliated "
                "SME Careers platform. Domain experts provide high-quality training "
                "data across specialized fields."
            ),
            job_type="Freelance / Contract",
            tags=["SME", "AI trainer", "domain expert", "SuperAnnotate"],
        ),
    ]


if __name__ == "__main__":
    main()
