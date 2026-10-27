# Panel controls cleanup

Layers and Settings actions were already native buttons, but a blanket `.map-sheet .btn`
rule changed them into left-aligned, full-width rows. Removed that rule so their appearance,
padding, typography, focus, and touch size come from the shared button primitive.

Related action groups now use `cb-actions--grid`: two equal columns, one column below 360 px.
Standalone actions keep their natural width. Added explicit `type="button"` to the remaining
action buttons in both sheets. Updated the block-action state selector to follow its semantic
container instead of depending on the retired layout class.

The audit also removed duplicate button typography/sizing in parcel and road panels, Lists,
design actions, plan-statistics actions, and parcel estimation; removed the estimation toggle's
custom selected colors; and removed the global `.btn-group .btn` full-width rule. The How it works
action no longer forces a whole row. Agreement editor tabs now use `cb-tab` and its standard
selected/focus appearance instead of their own copy of the tab styling.

Retained intentional layout: paired/triple action grids, footer ordering, explicit `btn-block`
actions, icon/close controls, floating map tools, and mobile touch-target rules. Panel padding,
placement, scrolling, and content typography remain panel responsibilities.

## Verification

- Targeted headless unit run: 3 files, 17 passed / 4 failed. Three failures were the existing
  `designs-panel.test.js` harness expecting the retired two-tab implementation rather than
  `ListsPanel`; both that test and `list-ui.js` were unchanged from HEAD. One grain-score wiring
  assertion rejected the new stylesheet cache-busting query; updated it to accept versioned URLs.
- Targeted headless unit rerun: `ui-vocabulary.test.js` and `grain-score-wiring.test.js`,
  2 files / 18 passed.
- Targeted headless unit check: `parcels-zoom-gating.test.js`, 1 file / 3 passed.
- Targeted headless Playwright run: 3 tests across `settings-sections.spec.ts` and the first
  agreement-dialog workflow. Both desktop and phone Settings cases passed. The agreement case
  failed before opening the editor because its selector expects the former proposal-details
  Add to agreement button. It did not reach the changed tabs.
- Direct headed-browser check opened the real agreement editor without saving: shared tab classes,
  selected underline/color, switching to Rules, and 44 px phone tab targets were verified.
- Direct headed-browser checks at desktop, 390 px and 320 px: centered button text, equal paired
  widths, single-column narrow layout, and no button/panel horizontal overflow. Screenshots of
  Settings, Layers, and the agreement editor were inspected. No test run was stopped; no full
  suite was run.
- Syntax checks passed for `map-controls.js` and `agreement-dialog.js`; `git diff --check` passed.

The preview frontend on 5092 and API on 4092 were verified against this checkout. The final link
explicitly selects Arlington and its backend. No production publication or server write is needed
for this visual change.

MCP parity: presentation, native action types, and an equivalent DOM selector changed; no editable
data, operation, validation, or authoring schema changed. Existing human/MCP editing capabilities
remain the same. No domain-glossary change is needed.

`index.html` also contains concurrent work and is intentionally left uncommitted. Its action-group
markup and stylesheet/script version updates are part of the tested working-tree result.
