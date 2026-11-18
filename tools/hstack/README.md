# HStack

Personal agent plugin monorepo — one set of skills, three platforms.

Works as a native plugin on **Claude Code**, **OpenAI Codex**, and **Cursor** without any build step. Each platform reads its own manifest and discovers the shared `plugins/hstack/skills/` directory.

> **Source of truth:** this repo is published from [`tools/hstack`](https://github.com/leehanchung/SMILE-factory/tree/main/tools/hstack) in the SMILE-factory monorepo. Every merge there that touches `tools/hstack/` is synced here by CI, and the sync overwrites anything committed here directly. Make changes in the monorepo.

## Skills

| Skill | Description |
|-------|-------------|
| `concept-infographic` | Source-grounded visual explanations of paper mechanisms, mathematics, and conceptual relationships, with adaptive layouts, checked equations, and a bundled illustrated example |
| `copy-editing` | Professional copy editing, grammar, style guide, AI writing pattern detection, and verbosity diagnosis |
| `data-ai-tech-strategy` | Tech strategy and engineering principles for Data/AI/ML organizations |
| `executive-coaching` | Executive coaching frameworks: GROW model, NVC, active listening, burnout prevention, co-founder dynamics, CTO transition |
| `manning-tech-book-writing` | Manning Publications style, chapter structure, and writing standards |
| `ml-paper-writing` | Publication-ready ML/AI research papers for NeurIPS, ICML, ICLR, ACL, AAAI, COLM — full writing process, citation verification, LaTeX, conference checklists |
| `open-kimi-ppt` | Create, edit, replicate, and export presentations via Moonshot AI's PPTD format — delivers a self-contained `.pptd` project plus a locally exported `.pptx`. Fully offline; needs only Node.js 18+ (vendored from [jinwyp/open-ppt-skill](https://github.com/jinwyp/open-ppt-skill), MIT) |
| `tech-writing` | Strategic tech blog posts and industry analysis — short-form (800-1,500 words) and long-form (2,000-4,000 words) with concision rules and AI pattern avoidance |

For example, ask `concept-infographic` to explain a paper subsection, Bradley–Terry loss with a numerical example, or Conway's law with corresponding team and system diagrams. It produces a standalone infographic plus a source/verification brief. Raster rendering requires an available image-generation tool; a host without one can prepare the brief and production prompt. Use `open-kimi-ppt` when the requested output is a slide deck or PPTD/PPTX project.

## Repository Structure

```
hstack/
├── .claude-plugin/
│   └── marketplace.json      # Claude Code marketplace catalog
├── .cursor-plugin/
│   └── plugin.json           # Cursor manifest
├── .agents/plugins/
│   └── marketplace.json      # OpenAI Codex marketplace catalog
├── plugins/hstack/           # Shared plugin payload
│   ├── .claude-plugin/
│   │   └── plugin.json       # Claude Code manifest
│   ├── .codex-plugin/
│   │   └── plugin.json       # OpenAI Codex manifest
│   ├── skills/               # Shared skills
│   │   └── <skill-name>/
│   │       ├── SKILL.md      # Entry point with frontmatter
│   │       └── references/   # Supporting materials
│   ├── agents/               # Custom agent definitions
│   └── commands/             # Slash commands
├── rules/                    # Cursor .mdc rules (auto-attach by file type)
│   └── <skill-name>.mdc
├── LICENSE
└── README.md
```

## How Each Platform Discovers Skills

| Platform | Manifest | Skills | Extras |
|----------|----------|--------|--------|
| **Claude Code** | `.claude-plugin/marketplace.json` -> `plugins/hstack/.claude-plugin/plugin.json` | `plugins/hstack/skills/*/SKILL.md` | `plugins/hstack/agents/`, `plugins/hstack/commands/` |
| **OpenAI Codex** | `.agents/plugins/marketplace.json` -> `plugins/hstack/.codex-plugin/plugin.json` | `plugins/hstack/skills/*/SKILL.md` | `interface` branding |
| **Cursor** | `.cursor-plugin/plugin.json` | `plugins/hstack/skills/*/SKILL.md` | `rules/*.mdc` with glob triggers |

All three platforms use the same `SKILL.md` frontmatter format:

```yaml
---
name: skill-name
description: When and how to use this skill
allowed-tools: "Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch"
---
```

- `name` + `description` — required by all platforms
- `allowed-tools` — used by Codex to scope tool access; ignored by Claude and Cursor

## Installation

### Claude Code

```bash
claude plugin marketplace add leehanchung/hstack
claude plugin install hstack
# Skills appear as /hstack:skill-name
```

For local testing from a checkout:

```bash
claude plugin marketplace add /path/to/hstack --scope local
claude plugin install hstack --scope local
```

For one-off session testing without installing:

```bash
claude --plugin-dir /path/to/hstack/plugins/hstack
```

### OpenAI Codex

```bash
codex plugin marketplace add leehanchung/hstack
```

For local testing from a checkout:

```bash
codex plugin marketplace add /path/to/hstack
```

In the Codex app, add the GitHub marketplace source `leehanchung/hstack`, then enable the HStack plugin. Codex reads `.agents/plugins/marketplace.json`, resolves `./plugins/hstack`, and loads `plugins/hstack/.codex-plugin/plugin.json`.

### Cursor

Symlink or copy into your Cursor plugins directory. Rules in `rules/` auto-attach to matching file types (e.g., `.tex` files trigger `ml-paper-writing`).

## Adding a New Skill

1. Create `plugins/hstack/skills/<skill-name>/SKILL.md` with frontmatter
2. Add reference files in `plugins/hstack/skills/<skill-name>/references/`
3. Create `rules/<skill-name>.mdc` for Cursor glob-based auto-attachment
4. Update the skill table in this README

## License

MIT

The `open-kimi-ppt` skill is vendored from [jinwyp/open-ppt-skill](https://github.com/jinwyp/open-ppt-skill)
and remains under its own MIT license. It ships its own offline editor mirror (~20 MB)
because the upstream npm package was unpublished; provenance, local modifications, and
the upstream license are recorded in
[`plugins/hstack/skills/open-kimi-ppt/ATTRIBUTION.md`](plugins/hstack/skills/open-kimi-ppt/ATTRIBUTION.md).
Verify a checkout with `plugins/hstack/skills/open-kimi-ppt/tests/selftest.sh`.
