<!-- Scope and unresolved observations from the supplied 26 October deploy-522 retest. -->
# Follow-up to the 26 October QA retest

This follow-up addresses three verified findings from the supplied report. It does not
extend that report's live coverage or repeat the entire automated suite.

## Changes

- The current-city search chip now uses the existing globe failure reporter, shared with
  startup, Settings and zoom-out navigation. Its translated warning explains that the 2D
  map and city search remain available. The busy control clears when opening fails.
- The published-design import regression uses the canonical `geometry.buildings` shape.
  It checks exact outer and courtyard ring coordinates, block membership and CID identity.
  The obsolete `blockMassing` assertion failed although canonical geometry survived import.
- The feature inventory matches the current command registry: Events, Actors, Settings'
  status log and Browse blocks replace or remove the reported stale entries. All 73
  referenced spec files remain indexed. Browser checks exercise both Activity commands,
  reopening the detected block list and the status-log command.

These changes affect navigation feedback and test coverage only. No authored editing
operation or record contract changes, so MCP tools and the vocabulary need no update.

## Observations left unresolved

- Closing the complete Designs panel resets Share exclusions; switching tabs preserves
  them. This is the currently documented lifecycle, not a new persistence requirement.
- Actual 3D rendering and the exact historical irregular-Row fixture require their own
  suitable environment or reproduction. The successful two-parcel Row is additional
  evidence, not proof about an unidentified earlier fixture.
- The supplied live run did not establish failed-review recovery, malformed-model
  rejection, a newly saved named snapshot's isolation, no-profile publication enforcement,
  or application/demolition replay of the existing published fork. Local automated tests
  cover several of these behaviors, but they do not replace those specific live checks.
- The interrupted file chooser, denied application action and dependency-download HTTP
  503s do not establish application defects. No behavior changes follow from them.

## Targeted verification

All runs completed; no complete unit or browser suite was launched.

| Check | Result |
| --- | --- |
| Headless Playwright, two new city-chip cases before the fix | Both failed on the absent visible warning at 1188 px and 500 px. |
| Headless unit batch: `proposal-import-normalizer`, `frontend-world-entry`, `frontend-map-search`, `frontend-duplicate-globals`, `no-home-paths`, `i18n-locale-coverage` | 111 passed, 5 failed across 6 files. The first five files passed all 101 checks. The locale guard passed 10 and failed 5 existing checks. |
| Headless Playwright, seven targeted cases across `world-failure`, `menu-audit-regressions`, `activity-controls`, `urban-blocks`, `search-and-commands` | All 7 passed, covering globe startup/Settings/city-chip failures and all four reconciled command mappings. |
| Feature inventory check | All 106 current commands indexed across 73 spec files; no missing, retired, duplicate or absent entries. |
| Dedicated headed Chrome, real read-only API | Visually checked the warning at desktop and 500 px, with the chip no longer busy. The map loaded 1,529 real parcels; a bounded parcel request returned HTTP 200 and 223 features. Browser closed after verification. |
| Syntax and whitespace checks | Passed for both changed runtime scripts and the final diff. |

The locale guard's failures are identical with and without these frontend changes: 59
unresolved literal keys per locale, concerning plan progress and MCP privacy copy, plus
the unlisted `bets.trade.` dynamic prefix. A diagnostic ran the guard's scanner against
both current bytes and the unchanged `HEAD` versions of the modified files and compared
the exact failure sets. The updated globe warning exists in all four dictionaries.
Those unrelated failures remain for a separate change.
