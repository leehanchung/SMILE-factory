# HStack — Agent Plugin Monorepo

Personal monorepo of agent skills, commands, and rules for Claude Code, OpenAI Codex, and Cursor.

## Repository Layout

```
hstack/
├── .claude-plugin/marketplace.json # Claude Code marketplace catalog
├── .cursor-plugin/plugin.json   # Cursor manifest
├── .agents/plugins/marketplace.json # OpenAI Codex marketplace catalog
├── plugins/hstack/              # Shared plugin payload
│   ├── .claude-plugin/plugin.json # Claude Code manifest
│   ├── .codex-plugin/plugin.json # OpenAI Codex manifest
│   ├── skills/                  # Shared skill definitions
│   │   └── <name>/
│   │       ├── SKILL.md         # Entry point (frontmatter + instructions)
│   │       └── references/      # Supporting materials
│   ├── agents/                  # Agent persona definitions
│   └── commands/                # Slash commands
├── rules/                       # Cursor .mdc rules (glob-triggered)
├── LICENSE                      # MIT — Han Lee
└── README.md
```

## Conventions

### Skills

Every skill lives in `plugins/hstack/skills/<skill-name>/` with a `SKILL.md` at the root. Frontmatter must include:

```yaml
---
name: skill-name            # Must match directory name
description: ...            # Used for discovery and triggering across all platforms
allowed-tools: "..."        # Codex tool scoping (ignored by Claude/Cursor)
---
```

Supporting files go in `references/`. Scripts go in `scripts/`. Keep `SKILL.md` body under 500 lines — use references for overflow.

### Naming

- Directories: `kebab-case`
- Skill names: must match their parent directory name exactly
- References: `kebab-case.md` (prefer hyphens over underscores)

### Adding a New Skill

1. `mkdir -p plugins/hstack/skills/<name>/references`
2. Create `plugins/hstack/skills/<name>/SKILL.md` with required frontmatter
3. Create `rules/<name>.mdc` for Cursor auto-attachment (optional but recommended)
4. Update the skill table in `README.md`

### Cursor Rules

Each `.mdc` file in `rules/` mirrors a skill. Include `globs:` for file-type auto-attachment when applicable (e.g., `**/*.tex` for paper-writing skills). Set `alwaysApply: false` unless the rule should load on every prompt.

### Agents

Agent definitions in `plugins/hstack/agents/` are platform-aware markdown files that define personas or workflows. Use descriptive filenames like `paper-reviewer.md` or `strategy-advisor.md`.

### Commands

Slash commands in `plugins/hstack/commands/` are markdown files. The filename becomes the command name.

## Development Workflow

- No build step — all platforms read markdown directly
- Test locally with `claude plugin marketplace add /path/to/hstack --scope local && claude plugin install hstack --scope local` (Claude Code), `codex plugin marketplace add /path/to/hstack` (Codex), or symlink into Cursor plugins
- Keep platform manifests in sync when shared payload structure changes

## Platform Manifest Locations

| Platform | Manifest | Agent Instructions |
|----------|----------|--------------------|
| Claude Code | `.claude-plugin/marketplace.json` -> `plugins/hstack/.claude-plugin/plugin.json` | `CLAUDE.md` (this file) |
| OpenAI Codex | `.agents/plugins/marketplace.json` -> `plugins/hstack/.codex-plugin/plugin.json` | `AGENTS.md` |
| Cursor | `.cursor-plugin/plugin.json` | `.cursor/rules/*.mdc` |

## Source of Truth and Publishing

- Edit hstack in SMILE-factory at `tools/hstack/`. `github.com/leehanchung/hstack` is a published mirror: `.github/workflows/hstack-publish.yml` copies this directory into it on every push to `main` that touches `tools/hstack/`, and anything committed to the mirror directly is overwritten.
- Leave the `version` fields at `MAJOR.MINOR.0`. The publish job sets the patch number on all four manifests (`.claude-plugin/marketplace.json`, `.cursor-plugin/plugin.json`, `plugins/hstack/.claude-plugin/plugin.json`, `plugins/hstack/.codex-plugin/plugin.json`) so installed copies see every publish as an update. Bump MAJOR or MINOR here, in all four files at once, when you want to.
- `.github/workflows/hstack-publish.yml` also checks on PRs that the four manifests parse and agree on name and version.

## Do Not

- Put anything other than the expected manifest JSON inside `.claude-plugin/`, `plugins/hstack/.claude-plugin/`, `plugins/hstack/.codex-plugin/`, or `.cursor-plugin/`
- Duplicate skill content across platforms — write it once in `plugins/hstack/skills/`, generate platform adapters
- Add secrets, API keys, or `.env` files to this repo
