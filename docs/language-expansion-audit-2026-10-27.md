<!-- Scope, translation accounting and verification of Arabic, French and Portuguese UI support. -->
# Arabic, French and Portuguese — 27 October 2026

## Current behavior

The interface supports Modern Standard Arabic (`ar`, formatting locale `ar-EG`), French (`fr-FR`)
and European Portuguese (`pt-PT`) alongside the original four languages. Every locale picker is
populated from the shared registry. English-only startup still requests only the English dictionary.
A selected new language requests English and that language, then reuses loaded dictionaries.

Arabic sets document reading direction to RTL; leaving Arabic restores LTR. Arabic uses Arabic
numerals and the Gregorian calendar. Currency remains attached to the city or authored amount.
Map coordinates, numeric scale controls, code and technical addresses retain their own direction.
Popups, shared controls, forms, report tables, headers and navigation follow the selected reading
direction. Locale codes in buttons are isolated with `bdi`. The report's sticky first column follows
the reading edge. Arabic uses system fonts; no new font package is downloaded.

All 6,890 English entries have translated counterparts. Arabic has 7,165 entries, including 275
additional forms so all 72 plural groups have zero, one, two, few, many and other variants.
Parameters, exact placeholder spellings, markup and technical URLs are preserved. A translation
may use a repeated parameter fewer times when its grammar uses a pronoun; the complete set of
parameters remains required. No legacy reader, migration or parallel translation loader was added.
Standalone pages version the changed locale runtime and styles to refresh previously cached assets.

## Saved plans and MCP parity

`PlanRecord` accepts all seven UI languages in a saved map view. Both its JSON Schema and the MCP
saved-view input schema are generated from that shared validator. Targeted tests compare the UI
registry with the schema, discover the plan resource through a real in-process MCP client, and
call `ugt_draft_plan` successfully with Arabic, French and Portuguese saved views. There is no new
MCP tool. Deploy the API and MCP shared-validator change before releasing the frontend; an older
API would reject a saved plan using a newly supported language. No database migration is needed.

The glossary's locale definition now includes reading direction. Other domain definitions and
record identities are unchanged. User-authored content and basemap/source labels retain their
source language; the dictionaries translate the interface and its configured city catalog.

## Translation generation and accounting

The user explicitly approved sending the English UI copy to the configured Codex subscription
runner. The shared `agents/lib/llm-cost` runner stripped API keys, used the configured default
`gpt-6.1-sol` at low reasoning, and recorded every consuming request as subscription usage.
There was no metered API fallback. A small 24-entry Arabic sample was reviewed first. The
configured cheap tier was unavailable on subscription authentication and produced no token usage.

Translation proceeded in resumable chunks. Exact repeated source strings were shared; plural
contexts remained separate. Two French responses were rejected by local validation and retried.
The final French response schema required a value for every numbered input, preventing omissions.
No dictionary was installed before complete coverage. Checkpoints and per-chunk receipts remain
under ignored `tmp/i18n-2026-10-27/`; the shared usage ledger also includes rejected model outputs.

English source SHA-256: `44b45d75043864d08042b47d6bf89742e2b2c50d3022033f287b8bc190a3f4c0`.

| Language | Entries | Consuming calls | Input tokens | Cached input tokens | Output tokens | Metered spend | Metered equivalent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 7,165 | 18 | 377,164 | 110,848 | 75,980 | $0 | $1.5252 |
| French | 6,890 | 22 | 599,237 | 19,072 | 89,149 | $0 | $2.0919 |
| Portuguese | 6,890 | 16 | 348,439 | 92,288 | 65,643 | $0 | $1.3625 |

The equivalent column is a consumption reference from the shared accounting layer, not money
charged. Subscription limits still apply. Dictionary source sizes are 634,456 / 518,429 / 504,380
bytes for Arabic / French / Portuguese; locally gzipped sizes are 141,588 / 130,386 / 126,617 bytes.
These are file-size measurements, not observed production transfer sizes. Unselected dictionaries
are absent from the verified startup request lists.

## Verification record

No full unit or browser suite ran. Final focused checks passed: 119 headless unit tests across
nine files (four older copy-ratchet assertions skipped in the filtered style run), 13 headless
Playwright specs across three files, and production static staging.

The eight-file final headless unit run used explicit paths:

```sh
cd backend
npx vitest run --maxWorkers=1 test/i18n-loader.test.js test/i18n-locale.test.js test/i18n-infrastructure.test.js test/i18n-locale-coverage.test.js test/i18n-new-locales.test.js test/plan-record-schema.test.js test/plan-file.test.js test/frontend-format.test.js
npx vitest run --maxWorkers=1 test/i18n-style.test.js -t 'translations are complete|uses the ellipsis'
```

The final headless browser run used:

```sh
cd e2e
BASE_URL=http://localhost:8088 npx playwright test tests/i18n-new-locales.spec.ts tests/i18n-startup.spec.ts tests/i18n-lazy.spec.ts
```

| Run | Type and scope | Result | Stopped |
| --- | --- | --- | --- |
| Initial locale characterization | Headless unit, 2 files / 23 tests | 21 passed; 2 old expectations still treated Arabic as unsupported and listed only five locale choices; updated | No |
| Locale and loader iteration | Headless unit, 2 files / 31 tests | All passed | No |
| Shared style and layout characterization | Headless unit, 4 files / 293 tests | 287 passed; 6 existing CSS/mobile failures in unchanged source files | No |
| Saved-plan and locale parity | Headless unit, 4 files / 49 tests | All passed | No |
| Portuguese browser filter probe | Headless Playwright, one file with anchored name filter | No specs matched; no tests executed; corrected after listing | No |
| Portuguese browser check | Headless Playwright, 1 spec | Passed | No |
| Final language and shared-plan checks | Headless unit, 8 files / 112 tests | All passed | No |
| Copy-completeness and title-case characterization | Headless unit, 1 file / 8 selected tests | 7 passed; 1 existing title-case ceiling failed; 3 skipped | No |
| Final copy completeness and ellipsis checks | Headless unit, 1 file / 7 selected tests | All passed; 4 older assertions skipped | No |
| Final browser checks | Headless Playwright, 3 files / 13 specs | All passed | No |
| Production artifact | Static frontend staging | Seven bundles and all seven separate dictionaries generated successfully | No |

The six existing style/layout failures concern ID specificity and `!important` in
`mobile-sheets.css`, a literal in `activity-feed.css`, the 3D stack's conflicting bottom position,
and two stale mobile/3D source-contract assertions. Their source files are unchanged from the
starting commit. The title-case check finds 31 labels against a ceiling of 30, both before and after
this task when legitimate language names are recognized as proper nouns. New language names do
not increase that count. No baselines were raised and these failures are not reported as passing.

A dedicated background headed Chrome also rendered all three map languages and the Arabic feedback
form at 390 × 844. Screenshots were inspected, the form had no horizontal overflow, and its eight
locale options were present. Each full map preview URL explicitly supplied backend, city, location
and language; the browser resolved the intended production read-only API and `/source-system`
returned HTTP 200 with `source-catalogue/v1`. The listener's working directory was verified as this
checkout. No live feedback, publication or wallet operation was sent. Translation jobs finished
with exit code zero, and the dedicated browser was closed after verification.


## Follow-up: style and mobile failures resolved

The follow-up fixes the CSS/mobile and shared-header failures recorded here and in the
[loading audit](i18n-loading-audit-2026-10-26.md). Phone sheet geometry now belongs to the shared
controller once attached; older panel geometry stops competing with it. The shared stylesheet has
zero `!important` declarations and zero IDs in `:is()`. The 3D stack uses the shared frame position
rather than overriding its bottom edge. Activity tabs use the existing local stacking token.
Short context sheets still fit their contents; navigation lists retain a scrolling viewport.

Every supporting page loads tokens, primitives and page chrome first. Feedback, sources and
privacy use an inline SVG back arrow outside the translated span, so translation does not erase
it and no icon font is needed. RTL reverses the arrow; switching to French restores LTR. The
privacy page title now carries the same Consensus Builder suffix as the other pages.

The mobile source assertions now describe content-fitting sheets and the existing 3D close
delegate. A characterization test verifies that closing clears both isolation and selection;
no selection behavior was changed. The 3D browser fixture now includes the utility stylesheet and
loads the stack/sheet styles in the same order as the app.

English “Open designs” now uses sentence case. The copy auditor previously treated punctuation
and placeholder differences as case conflicts; it now preserves punctuation and exact parameter
identity. Reusable duplicate copies must match exactly in English and every translation, since
identical English can represent distinct meanings or grammatical genders. Five new headless unit
tests distinguish real regressions from those cases. The case-conflict ceiling tightens from 57
to 16 and the reusable-copy ceiling from 289 to 227. These count changes reflect the corrected
measurement, not removal of that many strings. Title-case remains at its existing ceiling of 30.
No baseline increased.

MCP parity: this follow-up changes presentation, copy and audit coverage only. Human editing
operations and their shared MCP authoring primitives are unchanged; no schema change is needed.
No domain definition or record contract changed.

### Follow-up verification

No full suite ran. The final targeted headless unit run passed all 480 tests across nine files:

```sh
cd backend
npx vitest run --maxWorkers=1 test/design-tokens.test.js test/css-conflicting-selectors.test.js test/mobile-layout-contract.test.js test/i18n-style.test.js test/page-header.test.js test/page-chrome.test.js test/design-audit.test.js test/mobile-dock-sheet.test.js test/frontend-static-build.test.js
```

The targeted headless Playwright runs passed all 16 specs across three files:

```sh
cd e2e
BASE_URL=http://localhost:8088 npx playwright test tests/three-stack-sizing.spec.ts --project=chromium
BASE_URL=http://localhost:8088 npx playwright test tests/mobile-site-audit.spec.ts --grep 'primary mobile sheets|source and approval forms|every supporting page|road and cross-section|watched-area and site|forms remain usable' --project=chromium
BASE_URL=http://localhost:8088 npx playwright test tests/i18n-new-locales.spec.ts --grep 'Arabic feedback' --project=chromium
```

| Run | Type and scope | Result | Stopped |
| --- | --- | --- | --- |
| Failure reproduction | Headless unit, 5 files / 359 tests | 326 passed; 33 failed | No |
| CSS and audit iteration | Headless unit, 7 files / 381 tests | 361 passed; 20 failed; remaining stylesheet-order and changed-selector assertions corrected | No |
| Header-order iteration | Headless unit, 7 files / 381 tests | 369 passed; 12 failed; differently indented guide links corrected | No |
| Header, copy and build check | Headless unit, 5 files / 189 tests | 188 passed; privacy-page title branding failed and was corrected | No |
| Final targeted validation | Headless unit, 9 files / 480 tests | All passed | No |
| Final token reuse check | Headless unit, 2 files / 247 tests | All passed | No |
| Stack sizing startup attempt | Headless Playwright, 1 file / 8 intended specs | Sandbox could not reach preview; startup timed out, zero specs executed | No |
| Stack sizing | Headless Playwright, 1 file / 8 specs | All passed with local browser access | No |
| Mobile surfaces | Headless Playwright, 1 file / 7 selected specs | All passed | No |
| Translated arrow | Headless Playwright, 1 file / 1 selected spec | Passed | No |

A dedicated background headed Chrome rendered the Arabic Layers sheet at 390 × 844: it spanned
exactly 390 px, its bottom stayed above the dock, the resize handle was present, and there was no
horizontal overflow. The Arabic feedback header retained a visible right-pointing back arrow;
a real switch to French retained the arrow and restored its left-pointing direction. Screenshots
were inspected. The listener was verified as this checkout, the browser resolved the explicitly
supplied production read-only backend, `/source-system` returned `source-catalogue/v1` with HTTP 200,
and a building read at the New York preview location returned HTTP 200 with 274 GeoJSON features.
No live write, feedback submission or publication was sent.
