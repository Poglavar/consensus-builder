<!-- Scope and operation of the experimental 2025 Zagreb GUP proposal translation. -->
# Zagreb GUP 2025 as native proposals

Status (2026-10-22): merged into `colosseum-worlds-fair` as a record of the idea. It publishes through
named plans (`plans/plan-store.js`), which the design/agreement rework removes, so it is expected to
stop working when that rework lands; port it to the rework's restatement path rather than repair it.

This branch starts at `colosseum-worlds-fair` commit `83b1c31f`. It translates current
cached GUP massing into the existing Consensus Builder urban-rule proposal format.
It does not change the GUP solver or introduce another planning language.

The user requested a reasonably close citywide spatial restatement, with locations
skipped and flagged when the current proposal model cannot express the spatial mandate.
The user explicitly accepted approximate massing with non-spatial limits retained as
notes, and requested that uncovered model gaps, including dwelling caps, be listed.

## Meaning and limits

A represented proposal is **one cached above-ground massing option on one current
cadastral parcel**. Uniform prisms use an optional maximum, or a range when the source
specifies a minimum number of storeys. Nested stepped floors use the existing native
multi-volume building proposal: lower outer rings stop at their ceilings while inner
cores continue upward. Summed floor area and volume preserve the cached profile.
These adjoining components are parts of one mass, not separate buildings. Native plan
statistics count components and estimate apartments; neither is the GUP's building or
dwelling count. Each component uses an average storey height for area measurement;
the source's actual floor elevations remain in the provenance. It does not represent
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
- Non-nested overhanging floors, underground floors, missing floor geometry and
  footprints that the applicable native representation cannot preserve.
- Preservation or mandatory-frontage regimes that an imported maximum cannot enforce.
- Geometric/scalar discrepancies, including a rendered prism exceeding source GBP.

Every intersecting current parcel is audited, including parcels absent from the cache.
Skipping a shape does not erase its independently supported cached numeric estimate:
`newBuildCapacityM2` and `representedCapacityM2` remain distinct. Missing/unsuccessful
source capacity stays unknown. An evidenced source zero is counted separately and
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
floor-area/volume preservation for stepped forms, scalar strict mode, overhang/hole refusals, independent stock,
unknown-versus-zero accounting and inclusion of uncached source parcels.

Official text and map source: [City of Zagreb GUP 2025](https://www.zagreb.hr/izmjene-i-dopune-generalnogurbanistickog-plana-gr/187664).
The supplied local Markdown hash is pinned for each export. Cached source calculations
retain their own version and timestamp; the export does not certify that all legal
conditions were resolved or that neighbouring maxima can be realised simultaneously.

## First local export, 19 October 2026

The complete mapped cohort contains 194,676 current parcels. The local v44 cache
supports 10,622 represented proposals in 71 native draft plans; 184,054 parcels are
skipped with reasons, not assigned zero capacity. Of the represented proposals,
10,505 use adjoining stepped volumes. The source inputs are identical to the earlier
117-prism diagnostic; 10,505 representations were gained and none lost. Independent
cached numeric new-build quantities survive for 12,894 parcels.

Every exported proposal passed native serialization and floor-area/volume measurement.
Maximum differences from cached geometry were 0.092% for floor area and 0.967% for
volume. These figures measure translation fidelity, not legal accuracy. Local import
read back all 10,622 records; repeating it inserted zero proposals and verified all
10,622 existing records across the same 71 plans. See
[the coverage review](coverage-2026-10-19.json) for counts, source hashes and targeted
headless unit test run history. Large per-parcel audits remain local ignored output.

## Gaps uncovered

- **Maximum dwelling counts:** source `maxUnits` and `max_units` survive as notes; the
  native apartment estimate does not enforce them. Minimum plot area per dwelling
  likewise needs its own constraint.
- **Independent scalar budgets:** minimum/maximum KISN, maximum GBP and minimum
  natural terrain remain notes. The imported example can match their source massing,
  but editing or varying its geometry does not revalidate those budgets. Natural
  terrain is not established merely by leaving an area without buildings.
- **Mandatory form and preservation:** a maximum envelope does not require retention
  of existing fabric, a continuous frontage or a minimum mandatory built form. These
  regimes are skipped conservatively; generic smaller massing is not a substitute.
- **Relations with neighbours:** an imported outline does not encode the conditional
  right to attach to a boundary, required party-wall treatment or how a changed
  neighbour affects setbacks. A cached boundary-touching shape is not proof of that
  legal entitlement.
- **Alternative designs and interdependent limits:** this export preserves one cached
  option, not the complete permitted design space. Adjacent parcel maxima are not
  proven jointly realisable. Most stepped proposals are fixed native geometry, not
  executable urban rules.
- **Floor representation:** nested setbacks can be decomposed into adjoining native
  volumes, but exact per-floor elevations remain source notes. Overhangs, underground
  forms and unsupported editable footprint topology are skipped. Component counts
  do not establish a permitted number of buildings.
- **Applicability and procedures:** detailed-plan referrals, reconstruction/additions,
  exceptions, proxy contexts and unresolved legal conditions need separate evidence
  and workflows. Geometry alone cannot establish permission.
- **Source coverage:** missing cache rows, failed candidate searches and inconsistent
  source geometry/quantities leave flagged gaps. This is not a proposal-model
  limitation in every case, nor evidence of a prohibition. The separate Sesvete GUP
  and ground without cadastral coverage are outside the represented parcel cohort.
