# Valhalla parcel research handoff

This handoff preserves the population-ranked research checkpoint and the rules for continuing it independently of a laptop session.

The city release is commit `627c17e1732857610bcbb696a7973481739a8ebf`: 193 configured cities and 165 providers, including Orlando, Dublin, Riga, Tallinn, Vilnius and Jundiaí. Production subsequently serves the descendant `f38401a202c87050a4ca91dc6005060000ba465d`, frontend build `deploy-425`. The parcel release passed 382 headless checks across 16 files. Additional concurrent app checks passed 29 of 30; the remaining control-coverage assertion concerns an already disabled urban-block browse button introduced before this release.

## Research checkpoint

There are 890 completed investigations, 872 reviewed investigations and 102 reviewed geometry discoveries in the population-ranked pipeline. These counts differ from the broader coverage report and from the runtime catalog. The 1101–1200 cohort has 95 complete packets, 81 reviewed and 14 awaiting review. Those remaining WUP codes are 25, 780, 3976, 4121, 4148, 5699, 6034, 7534, 7651, 8558, 8993, 9965, 10619 and 11147.

The immutable 1201–1300 roster is in `overnight-next-1201-1300-2026-10-09/`. Its SHA-256 is `3bfad4448253fa7dc9d049e4849601b990ba45bd19611da6de139b7730ad0dbd`. It has 97 eligible cities and three reviewed prior-attempt skips. Four paired packets are complete: Haldwani (9127), West Valley City (5646), Yuhu (10624) and Yanji (11162). None is integrated. West Valley City has one public polygon awaiting qualification. The next fresh investigation is rank 1205, Morogoro (3354); 93 eligible investigations remain.

Morogoro's interrupted discovery found the first-party e-Ardhi public JavaScript advertising `https://eardhi.lands.go.tz/map/geoserver/taspro`. Anonymous WFS 2.0 capabilities returned HTTP 200 and listed `taspro:regularization_parcel_mapper`, `taspro:regularization_scheme_parcels` and `taspro:tpfirstparcel_mapper`; WMS also listed `use_plot`. These observations were not saved as a completed packet, and no geometry read or exact settlement query occurred. Re-fetch the capabilities, parse schema with proper XML namespaces, request only safe IDs and geometry, and verify the Morogoro scope rather than treating advertised layer names as proof of city coverage.

The official bulk population source has 12,138 unique 2025 settlements. Its compressed-file SHA-256 is `e9c9b41e374d776a9983e39bab54755405cecc263134db68ee706049294cd114`. The ignored copy is `tmp/overnight-cities-2026-10-09/WUP2025-DB-DEGURBA-Cities-Population-Surface-Data.csv.gz`. After each cohort, create the next 100-rank range with `scripts/build-overnight-city-queue.mjs --start-rank … --end-rank …`; resolve identity holds with explicit evidence, preserve the roster, and exclude genuine prior attempts. Queue membership alone is not an attempt.

## Evidence and admission rules

- Keep every WUP identity, population, rank and locator coordinate unchanged. A settlement centroid is neither a municipal boundary nor a parcel-presence gate.
- Execute and save English and native-language searches. Inspect first-party viewer configuration, scripts, network/API endpoints, WFS/OGC/ArcGIS services and public downloads. Retry advertised HTTP and HTTPS routes where appropriate. Login screens, timeouts, unavailable viewers and zero parcels at one point do not establish absence.
- Separate institutional record custody (`registryFound: true` or `null`), public geometry discovery, runtime qualification, integration and release. Title, licence and vintage information are disclosures, not geometry eligibility gates. Do not claim complete city or country coverage from bounded samples.
- Retrieve full unchanged source polygons and safe native parcel identifiers only. Never retain owners, addresses, accounts or valuations. Request only the minimum geometry/ID fields. Keep at most three full durable sample polygons per city; temporary qualification caches belong under ignored `tmp/`.
- Qualification requires fresh exact ID reads, stable complete manifests and forced pagination, thirteen aligned bounded cells, independent metric full-polygon validity/duplicates/overlap/operation checks, full-parcel proposal binding and a headed pointer/Details check. Preserve a positive discovery as held if any admission check remains unverified. Do not repair, simplify, union or clip source parcels.
- Researchers own only their assigned paired city/review packets, bounded samples and ignored scratch. The serial reviewer owns registry, catalog, city configuration and generated reports. Inspect sibling edits before shared mutations. No automatic commits, pushes, deploys, emails or TODO updates are authorized by this job.

## Followthrough with positive geometry

West Valley City should first qualify the existing `us-ut-salt-lake-city-parcels` statewide provider with its Salt Lake filter and canonical IDs; compare the county-specific discovered geometry before introducing a duplicate provider. The saved county sample has native PARCEL_ID `21182290100000`, OBJECTID `187133`.

Macapá has public geometry but remains held. The opt-in ArcGIS `identical-join-rows`/`distinct-ids` protocol was implemented and tested; complete fresh adapter qualification is still required. Its source is MapServer layer 27 at `hml.egl.eng.br`, native EPSG:31982 and integer `idlote` identity. Read `macapa-distinct-manifest-and-raw-row-protocol-proof.json` and the subsequent protocol tests. Repeated raw rows may collapse only when their full native geometry is exactly identical; count/manifest drift, conflicting geometry and incomplete reads fail explicitly.

Finland and Norway have public native polygons but remain held because bounded retrieval protocols are not qualified. Finland's FES explicit-geometry request was rejected despite positive metadata/hits; Norway's large exact resource-ID read failed while bbox could retrieve it. Continue protocol discovery rather than reporting absent data. Iceland remains unenabled pending its own evidence and qualification.

Balia WUP code 11147 has immutable point `[26.3173952,85.9061124]`, in the Bisfi/Madhubani area of Bihar. Do not use the similarly named Begusarai place roughly 97 km away as source scope. Partial paused evidence is in ignored `tmp/india-uhp-qualification-2026-10-09/paused-city-partial-evidence.json`.

## Operation

The isolated server branch is `parcel-research-valhalla`, in a checkout named `consensus-builder-parcel-research-valhalla`. The installed Codex CLI is authenticated; a bounded `gpt-5.6-luna` preflight read the 97-city queue and fetched the official UN page with HTTP 200. Research workers use that model with low reasoning; the reviewer uses `gpt-6-sol` with high reasoning. The CLI runs noninteractively with workspace writes and public network access enabled.

Start the runner from its checkout through the installed `agents/bin/run-job` wrapper, naming the job `parcel-research-20261009`. The Linux wrapper uses detached nohup, so it survives SSH disconnection and laptop closure; it does not restart automatically after a server reboot. Resume with the same runner and existing checkpoint files. Its singleton lock prevents duplicate work. Verify the actual PID as well as wrapper status: a stale log alone can make the wrapper report running.

Runtime state and per-turn JSONL logs live under ignored `tmp/valhalla-parcel-research/`. From the server checkout, use `python3 scripts/run-valhalla-parcel-research.py --status` to read state and confirm the actual runner process, and `--stop` to stop that runner and its owned Codex process groups. Invoke these through `ssh valhalla` from the laptop. Use `run-job log parcel-research-20261009 20` for the wrapper log. The wrapper's Linux `stop` command signals only its Bash wrapper and can leave child processes alive; use the runner's stop command instead. Checkpointed research stays on Valhalla for the next explicit integration/commit/deploy request.
