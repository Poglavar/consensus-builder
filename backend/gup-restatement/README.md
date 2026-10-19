<!-- Scope and operation of the experimental 2025 Zagreb GUP proposal translation. -->
# Zagreb GUP 2025 as native proposals

This branch starts at `colosseum-worlds-fair` commit `83b1c31f`. It translates current
cached GUP massing into the existing Consensus Builder urban-rule proposal format.
It does not change the GUP solver or introduce another planning language.

The user requested a reasonably close citywide spatial restatement, with locations
skipped and flagged when the current proposal model cannot express the mandate.

## Meaning and limits

A represented proposal is **one cached above-ground massing option on one current
cadastral parcel**. Its footprint is fixed; its height is an optional maximum, or
a range when the source specifies a minimum number of storeys. It does not represent
all alternative placements or establish legal permission. Source applicability
uncertainty remains a visible flag; a successful geometric check is not a legal verdict.

The ordinary mode restates massing. Original coefficients, unit caps and other scalar
rules remain source notes in `gupRestatement`, visible in the description. They are
not enforced by the current CB geometry model. `--strict-scalars` skips these sites
as well. Above-ground volume and a dwelling-count permission are different things.

Refusals include:

- No current source result, unsuccessful candidate searches and geometry failures.
- Changed parcel identity/geometry, empirical existing-stock estimates, reconstruction,
  additions and detailed-plan/procedure referrals.
- Stepped or recessed floors, underground floors, nonuniform floor heights, courtyard
  holes and multipart footprints that the native editor cannot preserve.
- Preservation or mandatory-frontage regimes that an imported maximum cannot enforce.
- Geometric/scalar discrepancies, including a rendered prism exceeding source GBP.

Every intersecting current parcel is audited, including parcels absent from the cache.
Skipped capacity stays unknown. An evidenced source zero is counted separately and
creates no demolition proposal. Existing-stock quantities survive every refusal.

The mapped scope is the union of current `consensus.urban_rule` geometries for 2025:
Zagreb's GUP, not the entire administrative City or the separate Sesvete GUP. The
scope feature remains unresolved until overlaid with audited cadastral ground;
land without cadastral coverage is not silently represented. Summed parcel areas
are not certified as an overlap-free ground tessellation.

## Build and review

From the repository root, with existing backend dependencies and a local `.env`:

```sh
node backend/scripts/build-gup-restatement.mjs --build \
  --gup-text ../cadastre-data/government_plans/GUPGZ.md
```

No arguments prints help. Optional arguments are `--env-file`, `--out`,
`--batch-size` (1–2000) and `--strict-scalars`. No solver is run. Source tables
are read only; a connection-local temporary scope avoids repeating a citywide union.

The ignored output defaults to `tmp/gup-2025-restatement/`:

- `manifest.json`: complete cohort, represented/skipped/proven-zero counts, areas,
  per-zone counts, refusal explanations, source fingerprints and text hash.
- `scope.geojson`: mapped source scope, explicitly unresolved by default.
- `pages/*.ndjson.gz`: one `{audit, proposal}` record per parcel, with geometry,
  reasons, source uncertainty and independent existing stock. Null proposal means skipped.
- `proposals.json`: only canonical native proposal records.
- `checkpoint.json`: verified page hashes and the next stable numeric source key.

Rerunning resumes completed pages. Changed source fingerprints or options require a
new output directory. Each page is atomically replaced; source fingerprints are
checked again before publishing a completed manifest. Summary aggregation is streamed.

## Local native plans

After reviewing the export:

```sh
node backend/scripts/build-gup-restatement.mjs --apply
```

Apply is restricted to a local database, requires unchanged source inputs, and inserts
canonical proposal records as drafts. It reads every record back through the normal
serializer before committing. Source-content IDs make a repeated apply a no-op;
conflicting existing content causes a rollback. The existing named-plan store pins
member hashes. Plans are split to fit the existing native link-length limit.
`local-plans.json` records the paths to open in the CB frontend. Nothing is pushed,
deployed, minted, accepted or applied to a browser's parcel fabric automatically.

## Verification

Targeted headless unit tests:

```sh
cd backend
./node_modules/.bin/vitest run test/gup-restatement.test.js --pool=threads --maxWorkers=1
```

Tests cover the native serializer, existing massing-to-example machinery, native
floor-area measurement, scalar strict mode, step/hole refusals, independent stock,
unknown-versus-zero accounting and inclusion of uncached source parcels.

Official text and map source: [City of Zagreb GUP 2025](https://www.zagreb.hr/izmjene-i-dopune-generalnogurbanistickog-plana-gr/187664).
The supplied local Markdown hash is pinned for each export. Cached source calculations
retain their own version and timestamp; the export does not certify that all legal
conditions were resolved or that neighbouring maxima can be realised simultaneously.
