# Shared market agreement review

The San Francisco infill market exposed four problems in the agreement reader: a false stale-ground warning, an irrelevant missing-area warning, a cropped preview, and wording that confused chain execution with legal land transfer.

The source parcel is a one-component MultiPolygon. The live fabric displays that component as a Polygon, but the published agreement commits to the source MultiPolygon. The agreement projection now retains the source representation for an unchanged whole parcel after checking the coordinates. Changed geometry still fails the current-ground check. This deliberately changes commitments previously made by the browser from flattened source parcels: recreate affected experimental agreements; there is no alternate hash reader.

Import reconstructs local geometry and piece identifiers while retaining published output areas, provenance and roles. Unchanged whole parcels carry their published input holders into the ledger. Opening an agreement from a market refreshes an existing local copy through the shared-link path. Comparing an agreement frames its input land in the visible map area.

The owner registry can omit area even when the agreement's land has a measured area. The approval card shows missing-area warnings only for a rule that actually counts area. It does not modify the published rights snapshot or substitute measurements into the voting rule.

Market previews retain the complete image aspect ratio, and the divider follows the image's dimensions after loading or resizing. The initial position exposes more of the proposed result. Binding execution is described as on-chain settlement; legal registration and construction are separate.

Validation covers unchanged and genuinely changed parcel geometry, exact published output terms, preserved holdings, reopening cached agreements, approval rules with missing areas, map framing, divider resizing, and rendered portrait-image edges on desktop and phone layouts.

Targeted validation on 2026-10-25 (all runs completed; no full suites):

| Type | Files or cases | Result |
| --- | --- | --- |
| Headless unit | `agreement-ground`, `agreement-sync`, `agreement-panel` | 83 passed |
| Headless unit | `proposal-approval-regimes` | 20 passed; rerun after replacing the test harness, 20 passed |
| Headless unit | `bets-startup-route`, `i18n-locale-coverage` | 21 passed |
| Headless unit | `map-before-after` | 9 passed |
| Headless unit | `proposal-before-after` | 20 passed |
| Headless unit | `frontend-proposal-list-navigation` | 16 passed |
| Headless Playwright | Five bet-dialog cases in `before-after.spec.ts` | First run: 4 passed, mobile pixel sample covered by the sheet footer. Corrected scroll sampling and image-load resize handling: 5 passed. |

The real San Francisco market was also opened in a dedicated headed browser against the public API: source parcels loaded, the agreement matched, its comparison showed the building footprint, its holding was retained in the ledger, and the Solana devnet account read returned Active/Pending with its funded escrow. The ignored local browser RPC configuration uses public devnet because its configured provider failed from localhost.

The reviewed public agreement predates the optional consultation field now emitted by the current publisher. Its stored published CID remains the identity used for reads and decisions; reserializing it with the current publisher adds that field. This separate contract change is not handled by a compatibility serializer here.
