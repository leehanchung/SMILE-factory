# Run exp_01ky0ztpc9eqn9g67e30pjt5k9

**Outcome: inconclusive.** No positive short-horizon BFCL transfer was detected for the
with-skill LoRA versus the matched no-skill LoRA. The point effect was -0.8676 percentage
points and its paired 95% interval [-1.9178, +0.1826] includes zero. Both adapters were below
the unchanged base model on paired BFCL. This is a one-seed pilot at 604,737 supervised tokens
per arm (12.0947% of the planned cap), so it does not establish a null effect.

Toolathlon is **unavailable**, not failed: all seven official admissions returned busy before
preprocessing, model execution, or verification. Long-horizon transfer is therefore
unmeasured.

- [Completed HTML report](report/index.html)
- [Resolved configuration](config.resolved.yaml)
- [Run provenance](provenance.json)
- [Exact reproduction result](reproduction.json)
- [SHA-256 integrity manifest](checksums.sha256)
- [Primary metrics](metrics/final_metrics.json)
- [Paired analysis](metrics/full_paired_analysis.json)
- [Normalized paired rows](data/normalized_paired_rows.jsonl)
- [External artifact manifest](artifacts/manifest.json)
- [Metadata verification snapshot](artifacts/verified_snapshot.json)

Reproduce from the project root:

```bash
make reproduce-analysis RUN=exp_01ky0ztpc9eqn9g67e30pjt5k9
make report RUN=exp_01ky0ztpc9eqn9g67e30pjt5k9
make verify-artifacts RUN=exp_01ky0ztpc9eqn9g67e30pjt5k9
```
