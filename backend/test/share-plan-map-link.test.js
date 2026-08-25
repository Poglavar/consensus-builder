// The share panel and the map are two views of one plan, and they were only wired one way: rows
// pointed at the map, the map pointed nowhere. Finding one row among several hundred meant scrolling
// and reading titles, and the map itself said nothing about which proposals were already on the
// server and which existed only on this machine.
//
// Both directions are source-level wiring — a Leaflet click handler and a Leaflet style — so they
// are read from source. What CAN be executed (the i18n, the key derivation) is executed.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dialog = read('../../frontend/js/proposals/dialog-share.js');
const selection = read('../../frontend/js/parcels/ui/parcel-selection.js');
const css = read('../../frontend/css/proposals.css');
const dictOf = locale => JSON.parse(read(`../../frontend/i18n/${locale}.json`));
const locales = ['en', 'hr', 'sr', 'es'];
const planStrings = locale => dictOf(locale).modal.roadWidth.share.plan;

describe('a click on the map finds the row', () => {
    it('the panel answers the click instead of the click being swallowed', () => {
        // It used to return outright: "every fabric click is inert — proposals included".
        const branch = selection.slice(
            selection.indexOf('if (global.sharePlanMode) {'),
            selection.indexOf('if (global.proposalListBrowseMode) {')
        );
        expect(branch).toContain('global.__sharePlanPickProposal');
        expect(branch).toContain('const picked = proposalOnThisParcel();');
        // Still swallowed for the rest of the fabric: share-plan mode stays pan/zoom only.
        expect(branch).toContain('L.DomEvent.stopPropagation(e)');
    });

    it('both modes resolve the proposal the SAME way, from one function', () => {
        // Two copies of "which proposal is on this parcel" would drift, and the map would answer
        // differently depending on which panel happened to be open.
        expect(selection).toContain('const proposalOnThisParcel = () => {');
        expect(selection.match(/proposalOnThisParcel\(\)/g) || []).toHaveLength(2);
        // The old inline copy is gone rather than left behind unused.
        expect(selection).not.toContain('let browseProposal = appliedRoadProposal;');
    });

    it('the picker is released when the panel closes', () => {
        // Left registered, it would scroll rows in a list that is no longer on screen and hold the
        // whole closed panel alive through the closure.
        const close = dialog.slice(dialog.indexOf('function closeSharePlanPanel()'), dialog.indexOf('function showSharePlanPanel()'));
        expect(close).toContain('window.__sharePlanPickProposal = null;');
    });

    it('ignores a click that arrives after the panel is gone', () => {
        const picker = dialog.slice(dialog.indexOf('window.__sharePlanPickProposal = (proposal, parcelId) => {'));
        expect(picker.slice(0, 400)).toContain('if (!panelStillOpen() || !proposal) return;');
    });

    it('says so when the picked proposal is applied but not in this plan', () => {
        // Doing nothing is indistinguishable from a click that missed.
        expect(dialog).toContain("tShare('plan.pickedNotInPlan'");
    });

    it('scrolls the row into view and marks exactly one', () => {
        const reveal = dialog.slice(dialog.indexOf('const revealRow = (key, parcelId) => {'), dialog.indexOf('const highlightRowProposal ='));
        expect(reveal).toContain("scrollIntoView({ block: 'center'");
        expect(reveal).toContain("controls.row.classList.add('is-picked')");
        // The previous holder loses the mark, or two rows both claim to be the picked one.
        expect(reveal).toContain("previous.row.classList.remove('is-picked')");
        // And the map outlines it too, through the same helper the rows' own hover uses.
        expect(reveal).toContain('highlightRowProposal(key);');
    });

    it('marks the picked row so it survives hover — the pointer is on the map', () => {
        expect(css).toContain('.share-plan-row.is-picked {');
        const rule = css.slice(css.indexOf('.share-plan-row.is-picked {'));
        expect(rule.slice(0, 160)).toContain('box-shadow: inset 3px 0 0 0');
    });
});

describe('the map shows what is already on the server', () => {
    const paint = dialog.slice(dialog.indexOf('const overlayStyleFor = (uploaded, color)'), dialog.indexOf('const keyOfProposal ='));

    it('paints uploaded solid and not-yet-uploaded dashed', () => {
        expect(paint).toContain('const uploaded = !!(uploadState.get(key) || {}).uploaded;');
        expect(paint).toContain("dashArray: uploaded ? null : '7 6'");
    });

    it('distinguishes them by SHADING, not by a second colour', () => {
        // Every proposal already owns a colour to tell it from its neighbours; a second colour axis
        // would collide with the first. So fill opacity and dash carry the upload state instead.
        // The COLOUR must be the proposal's own on both sides; how far apart the opacities are is
        // asserted separately, so tuning the contrast does not have to touch this test.
        expect(paint).toContain('const color = colorByKey.get(key)');
        expect(paint).toContain('fillColor: color');
        expect(paint).toMatch(/fillOpacity: uploaded \? [\d.]+ : [\d.]+/);
    });

    it('repaints when the server answer arrives, so the map cannot lag the row', () => {
        const update = dialog.slice(dialog.indexOf('const updateRowState = (key) => {'), dialog.indexOf('const toggleCheckbox ='));
        expect(update).toContain("controls.row.classList.toggle('is-uploaded', !!state.uploaded);");
        expect(update).toContain('if (overlayByKey.has(key)) syncPlanOverlay(key);');
    });

    it('the map opacities are far enough apart to see over imagery', () => {
        const paint = dialog.slice(dialog.indexOf('const overlayStyleFor = (uploaded, color)'), dialog.indexOf('const keyOfProposal ='));
        const pair = paint.match(/fillOpacity: uploaded \? ([\d.]+) : ([\d.]+)/);
        expect(pair, 'fillOpacity pair not found').toBeTruthy();
        expect(Number(pair[1]) - Number(pair[2])).toBeGreaterThanOrEqual(0.25);
    });

    // The legend of two swatches is GONE, and its tests with it. It existed because the map painted
    // uploaded and not-yet-uploaded together and a dashed outline explains nothing on its own. The
    // subset filter replaced that: each mode shows one state and the pressed button names it, so the
    // legend described a distinction that is never on screen at the same time.
    it('names the subset with the filter instead of a legend', () => {
        expect(dialog, 'the legend swatches are back').not.toContain('legendEntry(');
        expect(css, 'the legend rules are back').not.toContain('.share-plan-legend {');
        expect(dialog).toContain("{ value: 'uploaded', key: 'plan.filterUploaded'");
        expect(dialog).toContain("{ value: 'pending', key: 'plan.filterPending'");
    });

    // The filter row is panel content and has to line up with it. It sat on its own 2px inset while
    // the header and body use 14px, which read as a misaligned strip across the top of the panel.
    it('lines the filter row up with the rest of the panel', () => {
        const gutter = (rule) => {
            const start = css.indexOf(rule);
            const block = css.slice(start, css.indexOf('}', start));
            const padding = (block.match(/padding:\s*([^;]+);/) || [])[1] || '';
            const parts = padding.trim().split(/\s+/);
            return parts.length >= 2 ? parts[1] : parts[0];
        };
        expect(gutter('.share-plan-filter {')).toBe(gutter('.share-plan-panel-body {'));
        expect(gutter('.share-plan-filter {')).toBe(gutter('.share-plan-panel-header {'));
    });
});

describe('every language can say it', () => {
    it.each(locales)('%s names the picks and the subset filter', locale => {
        const plan = planStrings(locale);
        ['picked', 'pickedOnMap', 'pickedNotInPlan', 'filterAll', 'filterUploaded', 'filterPending']
            .forEach(key => expect(plan[key], `${locale} missing ${key}`).toBeTruthy());
        // Interpolated, and in the project's {{name}} form — a literal "{title}" would ship as text.
        expect(plan.picked).toContain('{{title}}');
        expect(plan.pickedOnMap).toContain('{{title}}');
        expect(plan.pickedOnMap).toContain('{{parcel}}');
    });

    it.each(locales)('%s translated them rather than copying English', locale => {
        if (locale === 'en') return;
        expect(planStrings(locale).pickedNotInPlan).not.toBe(planStrings('en').pickedNotInPlan);
    });
});
