# Shared preview replacement validation — 2026-10-24

The temporary MCP preview URL expires after 24 hours (or when its in-memory host restarts).
That expiry does not remove published designs, published agreements or drafts already saved
on a device. The Digbeth preview discussed here expires at 2026-10-25T00:02:57.669Z.

## Reproduced failures and fixes

1. Shared imports wrote directly to proposal storage while map mutations used private snapshots.
   Holding an older map mutation open, importing the real three revised Digbeth roads, then
   releasing the mutation deleted those three local records. Choosing “Unapply existing &
   continue” then reproduced the reported anonymous missing-member error exactly.
   Imports now use the same mutation queue; a shared package imports in one transaction.
   Every other public-design import caller awaits that transaction too.
2. Missing/withdrawn plan members now produce individual failures with their local identifier,
   title and specific reason. Shared-route reporting can recover a missing record's title from
   the fetched design content, rather than collapsing the entire plan into “Shared designs”.
3. After fixing import, the full agreement exposed order-dependent snapped polygon calculations.
   MCP enumerated the three roads Spine/Garden/North; browser replay used Spine/North/Garden.
   Pairwise union and subtraction generated different vertices and output hashes. Both corridor
   arrangement and carving earlier formations now order clipping operands geometrically, largest
   first with a geometry tie-breaker. Local record identifiers do not decide geometry.

This enforces the existing set-based corridor contract; it does not relax agreement hash checks.
The exact existing Digbeth private artifact now validates unchanged. Elsewhere, derived piece
identities/hashes that previously depended on incidental enumeration order can change on replay.
Published objects remain immutable; no compatibility reader or migration was introduced.

## Real browser verification

Used a dedicated headed background Chrome against the local checkout on port 8097 and the public
API, with actual cadastral source data and the exact deployed private artifact:

- Original public agreement: `bafkreig2o7mfofimfnct7fe4xml4cg6p27mvzkrfpn2rnf47r4xqm52kre`.
- Private revised agreement: `bafkreiftb6dxgqdi3j7kjku6cmkvbrhrhnezuehkabcfadaqsxknpxd2vu`.
- Demonstrated the lost-record race on the deployed version, then verified imports queue behind
  the held background mutation locally and conflict replacement retains all members.
- Final full preview: 17 applied designs, two rendered crossroads, 30 agreement outputs, no
  failed designs, agreement panel showing “Matches the map”.
- Reloaded and reopened the saved private agreement: the same counts and “Matches the map”.
- Closed the browser. No designs or agreements were published during verification.

The local no-cache server's process cwd was verified against this worktree. An ignored local
launcher at `/tmp/digbeth-preview.html` on port 8097 carries the exact tested fragment, avoiding
dependence on the expiring MCP redirect. It is a local review artifact, not application source.

## Targeted test runs

All unit runs were headless Vitest with `--maxWorkers=1`; all browser runs were headless
Playwright Chromium with one worker. No full suite was run and no run was stopped.

| Type | Scope | Result |
| --- | --- | --- |
| Headless unit | `design-sync`, `shared-plan-import`, `proposal-manager-transaction-boundary` (3 files) | 78 passed |
| Headless unit | `click-stack-panel`, `frontend-map-search`, `parcel-set-proposals`, `frontend-proposal-list-navigation`, `mcp-preview-integrity` (5 files) | 99 passed, 1 stale localization assertion failed |
| Headless unit | `parcel-set-proposals` (1 file), after replacing the retired key assertion with current module keys | 7 passed |
| Headless Playwright | `shared-plan-conflicts.spec.ts`, desktop and mobile | Desktop passed; mobile reached the final reload, then timed out under high host load |
| Headless unit | New `parcel-arrangement-crossroads` regression (1 file), before the geometry fix | 1 failed as expected: reordered roads produced different geometry |
| Headless unit | `parcel-arrangement-crossroads`, `parcel-arrangement`, `parcel-arrangement-artifact-neck`, `mcp-ground` (4 files) | 82 passed, 1 assertion assumed the old clip operand order |
| Headless unit | `parcel-arrangement` (1 file), after updating that expected error operand | 66 passed |
| Headless unit | `parcel-arrangement-crossroads`, `parcel-arrangement`, `clip-failure-proposals`, `mcp-ground` (4 files) | 111 passed, 2 failed: optional test-runtime module lookup and obsolete whole-parcel merge test |
| Headless unit | `clip-failure-proposals`, `parcel-arrangement-crossroads` (2 files), after using the existing module resolver and removing the test for the already-retired merge implementation | 37 passed |
| Headless Playwright | `shared-plan-conflicts.spec.ts --grep '390px'` (1 mobile case), with scoped longer navigation allowance | Passed in 25.2 seconds |

Final passing coverage comprises 297 distinct unit tests in 13 files and both desktop/mobile
conflict cases. The new browser regression holds a background mutation open, opens a private
preview, chooses replacement, then verifies saved state after reload and absence of publication
requests. Geometry regression checks every permutation of the real three road ribbons, cached
intersection inputs and renamed local records.

## Independent-plan replacement follow-up

A later report supplied a different public `/designs/…` package containing 17 independently
authored designs, including layout `bafkreid5b4bzjxygagbddnkuowlq2vxkkf7tfh6l6isw6g4k5vh7hlieca`.
It opened cleanly on an empty device. Opening it over the original Digbeth agreement and choosing
“Unapply existing & continue” reproduced all 11 reported failures, including the exact 90% layout
coverage, 59% park coverage and partial square cuts into the old layout's output pieces.

The conflict policy released the 13 old building/public-space designs but excluded the old layout
and three old streets. The private replay therefore combined both plans' ground. Its refusal
correctly rolled back; the defect was the incomplete set of conflicts offered for replacement.

Confirmed shared-plan replacement now includes applied roads, layouts and content overlapping an
incoming layout's authored plots. The conflict preview and mutation use the same option on the
existing geometric-rival rule. Disjoint/bordering/parked records are excluded; a building-only
share retains its host layout, and ordinary layout editing and road crossings keep their existing
semantics. The working-composition/map-share contract is documented in the vocabulary.

Real headed background Chrome validation against the public API confirmed:

- The warning names the old layout and all three old streets before confirmation.
- After confirmation, exactly the 17 incoming designs are applied; all 17 old designs remain saved
  but unapplied. No coverage failures remain.
- Reloading the actual shared-design route preserves those same 17 applied CIDs, with no conflict
  prompt or failed-design list. The immutable source is `GB-HMLR-BROWSER-v1-64708982`.
- The browser was closed. The local review launcher is `/tmp/digbeth-shared-plan.html` on port 8097;
  it opens the public design CIDs through the local app and explicit public API override.

Additional targeted runs, all completed without stopping:

| Type | Scope | Result |
| --- | --- | --- |
| Headless unit | `proposal-ground-conflicts`, `proposal-manager-transaction-boundary`, `shared-plan-import`, `apply-shared-ground-gate` (4 files, one worker) | 83 passed |
| Headless unit | `proposal-manager-transaction-boundary` after adding the preview/commit agreement regression (1 file, one worker) | 18 passed; 84 distinct final passing tests across the four files |
| Headless Playwright | `shared-layout-replacement.spec.ts`, 390px and 1280px (2 cases, Chromium, one worker) | Both passed in 14.6 seconds; old ground is released, an unrelated park stays, all records remain saved, and reload preserves the replacement |
