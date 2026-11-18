---
name: copy-editing
description: Use when copy editing, proofreading, polishing, or removing AI-sounding prose.
allowed-tools: "Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch"
---

# Copy Editing

Use for proofreading, copy editing, line editing, and prose polish. Preserve intent unless the user asks for a rewrite.

## Workflow

1. Identify audience, document type, and edit depth.
2. Apply the lightest sufficient edit: mechanics, clarity, or heavy line editing.
3. For standard/heavy edits, scan for AI-writing patterns.
4. Return edited prose plus the few highest-impact changes.

## Always Check

Check correctness, clarity, density, consistency, and voice. Cut repeated points, padded transitions, vague examples, weak verbs, and over-polished generic phrasing.

## AI-Writing Audit

Load `references/avoid-ai-writing.md` when text sounds LLM-assisted, when the user asks for AI-pattern detection, or for standard/heavy edits. If many flags span several pattern categories, recommend a rewrite rather than patching.

## References

Load `references/avoid-ai-writing.md`, `references/grammar_guide.md`, `references/style_comparisons.md`, or `references/common_errors.md` only when the task needs that depth.
