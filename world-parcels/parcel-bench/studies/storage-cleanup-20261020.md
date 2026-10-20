# ParcelBench output cleanup — 2026-10-20

Removed **7,390 ignored output files** from `output/`: 7,339 `.npz` arrays/caches and 51 `.pt`
checkpoints. The cleanup reclaimed **30,443,876,352 bytes (30.444 GB)** of allocated disk space;
**10,732,556,288 bytes (10.733 GB)** remain in the output tree. This receipt records storage
availability, not a change to the interpretation of any historical result.

The retired arrays came from the 2026-10-13 imagery smoke/study and reconstruction GPU-support
outputs, plus older training and evaluation runs: cache, curve, integration-v2, n1600 watershed,
round2, selection-v2 imagery/longer/resolution, selection-v3 donors/margin, selection-v4
normalization, split, transfer, and v0/v0b. The retired checkpoints were the older best/resume
weights from these run families. Their predictions and scores can be regenerated where their
inputs, manifests, code, and checkpoints still exist; deleted checkpoints themselves cannot be
recreated without retraining. The compressed per-file inventory records every removed relative
path and byte count in [`storage-cleanup-20261020.files.json.gz`](storage-cleanup-20261020.files.json.gz).

Preserved material includes the annotation imagery bundle and preview review store, the heuristic
demo bundle, the current v5 settlement runs and comparison, and the visible-boundary and
visible-divisions study outputs. A cleanup-time manifest verified **70,063 preserved files** by
file identity, length, and modification time. No reports or tracked manifests were rewritten;
historical result descriptions remain as originally recorded. Re-running a study whose arrays were
retired requires regenerating those artifacts before reproducing its file-level receipts.

The audit totals and expected reclaimed space are recorded in `/tmp/parcel-bench-cleanup-20261020.json`;
the committed compressed inventory is the durable list of deleted files.
