# Borongaj plan replacement

The new Borongaj Commons plan applies all 51 designs in a fresh browser: 32 buildings,
12 roads, four parks, two squares and one lake. Re-deriving that complete applied set also
succeeds. The failure depends on the prior composition.

Read-only inspection of the affected production tab's design list and captured console logs
identified the earlier 12-member Borongaj Forest Campus plan among its applied designs. Opening
that earlier plan in a disposable profile and then choosing the Commons plan reproduced the
exact seven failures, including the square's three partial parcel shares and building coverage
of 79%, 88%, 89%, 38%, 88% and 94%. The failed replacement rolled back to the old 12-member set.
The affected user's applied composition was not changed during inspection.

## Cause and current behavior

The conflict detector released the prior buildings and structures but omitted both old roads.
It considered corridors replaceable ground only when the incoming member was a parcel layout.
Commons contains buildings and surface designs without a separate layout design, so old road
cuts remained in the live fabric. Those road parcels correctly cannot host incoming buildings
or structures; the coverage and partial-cut guards refused the unsupported takes.

Shared-plan conflict validation and confirmed replacement now use the same occupied-ground
rule. A building or surface design can conflict with an applied corridor occupying its authored
footprint; an incoming layout can also replace occupied layouts. Host layouts for buildings,
disjoint/bordering roads, parked records and compatible road junctions remain. The existing
coverage checks and atomic rollback remain intact. Published geometry and CIDs are unchanged.

The read-only-tab banner is a separate persistence condition. The same geometry operation runs
there, but its successful local change goes to recovery rather than overwriting the primary
tab's saved composition. It did not cause these seven geometry failures.

## Verification

- Read-only audit by `gpt-6-luna` identified the secondary-tab persistence boundary and relevant
  regressions; the audit made no edits and ran no tests or browser.
- Targeted headless Vitest: 115 tests passed across proposal-ground conflicts, shared-ground
  apply gating and open-ground application. Added building/park/square/lake corridor conflicts,
  retaining disjoint, boundary-touching and parked roads, host layouts and compatible crossings.
- Targeted headed Playwright: four cases passed in shared-layout-replacement.spec.ts. Desktop
  and mobile replace an old road with building/park designs without a layout; the mobile case
  uses an actual secondary tab and confirms that its primary composition remains unchanged.
  The two existing layout-replacement cases also passed, including reload persistence.
- Exact real-data repetition after the fix: the conflict dialog included both old roads, all
  51 Commons members applied, no old member remained applied, and runtime collections held
  32 building features, four parks, two squares and one lake. Inspected the resulting 3D capture.
  Closed both owned diagnostic browser sessions after verification.

No full suite or deployment was run for this fix.
