# Methodology

## Question and controls

The study isolates exposure to successful **with-skill trajectories** from generic exposure
to successful agent trajectories. Both LoRA arms use the same base model, seed, optimizer,
update budget, assistant-only objective, and task/source matching. The no-skill arm is the
active SFT control; unchanged Qwen3-8B controls for regressions caused by either SFT arm.

## Typed-event parsing

Canonical trajectory archives contain provider-specific event shapes. `corpus.py` converts
OpenAI, Gemini, and Bedrock records into one ordered message schema while preserving tool
call IDs, tool results, and assistant actions. It drops provider boilerplate, verifier/oracle
material, and private or encrypted reasoning. Parser fixtures audit role counts, tool counts,
and forbidden content before a corpus is eligible for training.

## Skill-text exclusion

Task-visible inputs are subtracted from each task's skills to derive skill-unique fingerprints.
The final v7 policy removes exact skill chunks and skill-reference lines with a
condition-blind line/span redactor. It preserves surrounding assistant actions and masks
redaction placeholders from the loss. All 87 task groups retain at least one unique
fingerprint; selected rows contain zero residual exact skill-path or known-chunk hits. This
audit guarantees verbatim detection only up to the recorded 239-character floor and does not
guarantee paraphrase detection.

## Assistant-only sequences

Qwen's native chat template renders conversations. Labels are `-100` for system, user,
tool-result, padding, and redaction-placeholder tokens; only assistant output contributes to
loss. Long conversations are segmented only at completed assistant/tool interaction
boundaries. Oversized tool context is omitted deterministically rather than splitting a tool
unit. Cross-example packing is disabled.

## Independent splits and matching

The independent unit is `task_id`, not a row or trajectory. A deterministic seed-17 split
assigns task groups to train, validation, and audit, stratified by domain and difficulty;
recorded split overlap is zero. Conditions are then matched on domain, difficulty, source
model, harness, tool-turn bin, total-context-token bin, and assistant-loss-token bin. The
final train split has 238 row pairs and exactly 604,737 supervised tokens per condition.

## Overlap audit

The evaluation manifest was fixed before scoring. Training versus evaluation overlap checks
normalized exact instruction hashes, token 5-gram Jaccard, BM25 retrieval, exact tool names,
and canonical JSON schemas. Across 3,372 evaluation items, exact instruction, schema, and
5-gram matches were zero; maximum token 5-gram Jaccard was 0.005848. The separate v2 overlap
manifest is authoritative; the normalized paired table uses zero only as a join-safe field.

## Evaluation and statistics

BFCL v4 contains seven non-live single-turn categories and four multi-turn categories (2,190
paired items). Preservation includes 541 IFEval prompts, a deterministic 500-question MMLU
sample scored without chain of thought, and 120 direct-response prompts rendered both with no
tools and irrelevant tools. Pairing is by `(benchmark, task_id)` and incomplete pairs are
never imputed. Confidence intervals for differences use 10,000 task-paired bootstrap
replicates with Python's deterministic `random.Random(17)` resampling; arm intervals use
Wilson scores. No mixed-effects model was fit.
