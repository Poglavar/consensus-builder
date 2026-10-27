# October 27 QA findings: follow-up

The external release report was assessed against release `90479e964` and the
current worktree. Its bounded verdict is appropriate: runner adapters and sparse
source mirrors do not establish a complete supported-suite pass. This follow-up
does not combine those adapted results with local test counts.

## Confirmed diagnostics defect

The import UI keyed its private diagnostics handle by plan CID, while named-plan
saving keyed it by JavaScript object reference. The same imported content and
equivalent clones could therefore acquire multiple observed handles.

Named-plan saving now validates and computes its CID inside the observed action,
then uses that CID as the diagnostics key. The canonical CID is used only for
local correlation; exported entries still contain a random opaque handle. A
regression exercises the actual import UI and save modules with real valid plan
content and real CID calculation: import, save and a reordered equivalent clone
reuse a handle; a plan with the same title but a changed saved view gets a
different handle. Neither title nor CID appears in diagnostic exports.
Validation and hash failures remain observable failures and send no request.

The native UI fixture now supplies `Element.prepend` and an in-memory
`PersistentStorage` implementation. Its mutation mock actually persists imported
plans. This repairs the three fixture failures without changing application
storage behavior or removing their failure/cancellation assertions.

This changes diagnostics correlation only, not authored-plan identity or editing
operations. No vocabulary or MCP schema change is required.

## Coverage indexes

The feature index now covers `proposals.agreements` and removes the retired
`proposals.planStats`, `proposals.grainScore` and `proposals.clearLocal` commands.
Their browser spec files remain available; no suite was deleted.

The control contract matches current semantic controls after button markup
changes and includes the additional agreement inspection/property-tab variants.
Existing coverage obligations and the two guarded, permanently inactive road
placeholders are retained. The checkers cover 103 commands and 905 source sites;
matching indexes do not themselves claim that every operation passed a browser
test.

## Dependency findings and additional fixture repair

See [dependency-security.md](dependency-security.md) for the compatible patches,
the native-free Solana BigInt replacement, and the nine unresolved upstream Zod 3
audit findings. The audit is not clean and no advisory was suppressed.

Targeted checks also exposed an older Solana market test fixture. It used the
former parimutuel account and omitted the sponsor/indexed agreement now required
by the LMSR reader. The fixture now uses current agreement and LMSR bytes and
checks paired account batching, missing sponsors, identity, ownership, stake mint
and canonical terms. No market production behavior was changed.

## Local verification

These are targeted checks using the installed supported runners, not a full suite:

- Headless Vitest: 125 unique passing cases in 17 files. The 14 dependency/payment/
  oracle/Solana/MCP files account for 111; the two named-plan files add eight; the
  geometry-identity file adds six.
- Native Node: 68 unique passing cases. Diagnostics core/UI account for 25,
  diagnostics HTTP/CLI for six, and the three control harness files for 37.
- Headless Playwright: 13 passing cases in `plan-file.spec.ts` and
  `named-plans.spec.ts`, including desktop/narrow sharing, import failure,
  cancellation, repeatable downloads, model bytes, localization and diagnostics
  privacy. Publication requests use in-memory HTTP mocks.
- Both feature/control index checkers and `git diff --check` pass.
- The npm frozen-install dry run accepts the manifest and lockfile.

Initial diagnostic runs are not extra passes: a 13-file headless unit run hit
sandbox listener restrictions (24 fixture failures, 73 passes); the permitted
14-file rerun had 105 passes and five failures. Those were two stale market
fixtures, two MCP timeouts under local contention, and one new test calling a
Solana layout without its explicit byte offset. After fixture correction, the
market file passed eight cases; the isolated MCP file passed 11; the security
file passed 13 with explicit offsets. The 125-case total counts each final case
once. Diagnostics fixture refinements were rerun to the final 25 native passes;
the named-plan unit files were rerun after the final observation-boundary change.
No run was a full suite, and none was stopped for expanding beyond its scope.

No production diagnostic submission, public publication, wallet transaction or
deployment was performed for this follow-up. Database and chain suites were not
run. The external report's other adapted passes, stress measurements and
infrastructure failures are retained as qualified evidence, not recertified here.
