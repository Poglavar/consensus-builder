# Parcel discovery, adapters and app admission

`scripts/run-valhalla-parcel-research.py --with-adapters` connects the stages in one resumable job. Up to three researchers search independently; one reviewer classifies their evidence; one adapter worker and the admission writer run serially between discovery batches.

1. Search municipal, regional, national and general web sources in English and the local language. Inspect official viewers, service metadata and downloads. Preserve actual queries, URLs, request outcomes and the exact frozen WUP city identity.
2. Probe promising cadastral polygon sources across the city. A candidate needs first-party cadastral purpose and geographic-scope evidence, at least three non-overlapping probe areas, positive parcel results in at least two areas and four distinct safe IDs overall. The reviewer must explain the geographic distribution; counts alone do not prove broad coverage. Sale listings, individual developments, buildings and planning overlays are not useful city cadastral sources. Partial coverage remains explicitly partial.
3. Classify each search as **candidate**, **blocked**, **rejected** or **already-supported**. A blocked source needs a concrete endpoint, evidenced blocker and retry action. An exhausted search is rejected, without asserting that the city has no cadastre. Already-supported requires actual matching app and catalog bindings.
4. For a candidate, build or adapt the production adapter and focused tests, then run the existing nine-gate qualifier with independent metric and coordinate-alignment verification. Missing adapter code is implementation work. It is not a source limitation. Preserve boundaries unchanged and retain only safe IDs and geometry.
5. Passing evidence goes automatically to the existing admission writer, restricted to that city. It verifies the exact source contract, updates the catalog and city configuration, and rebuilds both coverage reports. `integrated` means verified in this working tree. Production release and deployment remain separate.

Example, using a prepared finite queue and ignored state directories:

```sh
python3 scripts/run-valhalla-parcel-research.py --run --with-adapters \
  --workers 3 --stop-after-queue \
  --queue tmp/city-discovery/pending-queue.json \
  --state-dir tmp/city-discovery-state \
  --research-model gpt-5.6-luna --review-model gpt-6-sol
```

Use `--discovery-only` instead when only search and explicit triage are wanted. Neither mode deploys or commits. Adapter and admission writes require a dedicated worktree with the normal qualification dependencies and WUP population input available.

Version-2 review receipts live beside the queue under `root-review-receipts/`. Previous receipts are archived before reassessment. Valid old research packets are reused; old `held` reviews remain **unclassified** until the reviewer makes an explicit new decision. Supplemental coverage probes may fill gaps without rewriting the original packet.

`state.json` exposes `discoveryCounts`, including the four decisions, unclassified history and qualification outcomes. Candidate attempts and admission bridge artifacts live under the ignored state directory. Input and artifact hashes are rechecked on resume. A failed city remains recorded and makes the final run incomplete. Other candidates continue when independent before/after workspace hashes prove the failure left no code or app-data changes. Changed or unverifiable work pauses adapter mutations in `adapterStageBlocked`; discovery may continue. Inspect and resolve that failure before clearing the block. Saved failures and partial writes are preserved for review.

Admission activates a newly qualified source only for its admitted city bindings. This policy decision is recorded separately from the unchanged candidate and its qualification hash. Existing catalog sources marked as opt-in remain opt-in.
