# Adding an immutable run

1. Choose the canonical experiment EID and create `runs/<EID>/`; never reuse another run's
   directory or overwrite recorded evidence.
2. Add `config.resolved.yaml`, `provenance.json`, `manifest.yaml`, and a run README. Pin every
   model, dataset, benchmark, and source revision; record seeds, deviations, and tracker URLs.
3. Put compact normalized rows in `data/`, reviewable summaries in `metrics/`, and the final
   self-contained report in `report/index.html`. Do not commit weights, adapters, Parquet
   corpora, caches, or raw trajectories.
4. Describe each external object in `artifacts/manifest.json` with a full resolvable location,
   role, byte size, checksum/etag, provider version, and loading recipe. Capture an independent
   metadata-only verification snapshot. Generate `checksums.sha256` after all run files settle;
   it covers every committed file in the run except itself.
5. Add the run to `runs/index.json` and run `make check`, `make reproduce-analysis RUN=<EID>`,
   `make report RUN=<EID>`, and `make verify-artifacts RUN=<EID>`.
6. A new run may use a different acceptance comparator, but its tolerance and target values
   must be fixed in the run record before comparison. Never loosen an existing run's bar.
