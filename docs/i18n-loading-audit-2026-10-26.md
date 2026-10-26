<!-- Verification record for selected-language loading and removal of inline multilingual dictionaries. -->
# Translation loading cleanup — 26 October 2026

## Current contract

Translated copy lives in `frontend/i18n/<language>.json`. Migrated namespaces are `language`,
`feedback`, `mcpPrivacy`, `designMemberships`, `clickStackRelations`, `parcelReport` and `pageHeader`.
Native language names, flags and locale tags remain small registry metadata. No languages were added.
English is the fallback dictionary; only English and the selected language load at startup.
A new selection loads that dictionary through the same shared request cache. Region-only changes
reuse the language dictionary. Failed requests can retry; stale completions cannot repaint a later
selection. Locale buttons carry the shared busy indicator until loading settles.

Feedback, privacy and the parcel report now use the shared runtime. The proposal-list-only fetch and
flattening path was removed. Features consume the JSON dictionaries rather than registering copy.
Plural lookup exhausts selected-language forms before English, using English rules for fallback.
The formatter consults the registry for languages outside its standalone defaults.

See [development instructions](development.md#languages-and-translation-loading) for adding languages.
Right-to-left direction and layout verification remain part of adding a right-to-left locale.

## Scope and concurrent work

Another session committed Freeform changes during this task. The final language files were rebuilt
from that committed version with only the migrated namespaces and one corrected Spanish settlement
message added, preserving the other session's latest strings. Locale definitions, city currency and
authored records did not change, so the domain glossary did not need an update.

MCP parity: this pass changes display-copy loading and locale controls only. It adds no authored
record or editing operation, so MCP schemas, discovery and editing tools need no change.

## Verification

All execution was targeted; no full unit or browser suite ran. Final coverage is 187 passing
headless unit tests across 16 files (73 unrelated header assertions skipped in the filtered run),
and nine passing headless Playwright specs across three files. Production static staging succeeded.

The final unit-file groups were:

- `i18n-loader`, `i18n-infrastructure`, `i18n-locale`, `i18n-locale-coverage`,
  `design-memberships`, `frontend-format`.
- `click-stack-relations`, `click-stack-sharing`, `parcel-coverage-report`,
  `building-count-plurals`, `ui-copy-feedback`, `source-explorer`, `lens-console-dom`,
  `frontend-duplicate-globals`.
- `feedback`; `page-header` filtered to its shared-dictionary rendering assertion.

Every unit-file name above is under `backend/test/` with suffix `.test.js`; final runs used
`npx vitest run --maxWorkers=1` with explicit paths. The feedback route tests needed local socket
access. Browser execution used explicit paths:

```sh
BASE_URL=http://localhost:8088 npx playwright test tests/i18n-startup.spec.ts tests/i18n-lazy.spec.ts tests/feedback.spec.ts
```

| Run | Type and scope | Result | Stopped |
| --- | --- | --- | --- |
| Initial characterization | Headless unit, 10 files | Incomplete; existing page-header layout assertions failed, feedback sockets were sandbox-blocked, and two feature fixtures needed real dictionaries | Yes |
| Feature iteration | Headless unit, 8 files / 128 tests | 127 passed; one inspection fixture lacked i18n; corrected | No |
| Coverage iteration | Headless unit, 4 files / 59 tests | 54 passed; scanner needed the shared-plan helper prefix and bets error-key prefix; corrected | No |
| Core validation | Headless unit, 6 files / 88 tests | Passed | No |
| Feature and global validation | Headless unit, 8 files / 84 tests | Passed | No |
| Shared page header | Headless unit, 1 file / 1 selected test | Passed; 73 unrelated assertions skipped | No |
| Feedback route | Headless unit, 1 file / 13 tests | Passed with local socket access | No |
| Dictionary reconciliation and formatter extension | Headless unit, 3 files / 43 tests | Passed; includes one new formatter-registry test | No |
| Initial browser validation | Headless Playwright, 3 files / 9 specs | 2 passed, 3 failed, 4 not run; traces showed local script connections failing with `ERR_SOCKET_NOT_CONNECTED` | Yes |
| Browser validation with replacement server | Headless Playwright, 3 files / 9 specs | All passed | No |
| Production artifacts | Two static frontend builds | Seven bundles generated; dictionaries remain separate files | No |

The existing header layout failures concern mobile stylesheet ordering and missing back-link icons
on pages outside this loading change. They were not silently treated as passing or rewritten here.

A dedicated background headed Chrome also rendered the Spanish New York map and Spanish feedback
form. Its resolved backend was the explicitly supplied production API; `/source-system` returned
HTTP 200 with schema `source-catalogue/v1`. The feedback page requested only English and Spanish and
offered all registry locales, including both English regions. The preview listener's working
directory was verified as this checkout. Browser specs mock feedback writes; no live report was sent.

Across the affected translation and feature scripts, source bytes fell from 122,808 to 47,924
(73.1 KiB removed from JavaScript across those pages). This is a source-size comparison, not a
compressed initial-download measurement. The text now lives in selected-language JSON files.
