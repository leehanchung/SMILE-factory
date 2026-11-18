---
name: new-skill
description: Scaffold a new skill in this monorepo
---

Create a new skill in this monorepo. Follow these steps:

1. Ask for: skill name (kebab-case), one-line description, and relevant file-type globs (if any)
2. Create the directory structure:
   ```
   plugins/hstack/skills/<name>/
   ├── SKILL.md
   └── references/
   ```
3. Write `plugins/hstack/skills/<name>/SKILL.md` with proper frontmatter:
   ```yaml
   ---
   name: <name>
   description: <description>
   allowed-tools: "Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch"
   ---
   ```
4. Create `rules/<name>.mdc` with Cursor frontmatter (include globs if provided)
5. Update the skill table in `README.md`
6. Remind the user to populate the SKILL.md body and add reference files

$ARGUMENTS
