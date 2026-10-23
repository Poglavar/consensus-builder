// The share panel and the map are two views of one plan, and they were only wired one way: rows
// pointed at the map, the map pointed nowhere. Finding one row among several hundred meant scrolling
// and reading titles, and the map itself said nothing about which designs were already published
// and which existed only on this machine.
//
// Since M3 the panel picks on the map through js/map-pick.js (MapPick 'share'): the map's own click
// resolution hands the design it found to MapPick.pick, which hands it to the panel (outside pick mode
// the click goes to the click stack, click-stack.md). That click path
// (parcels/ui/parcel-selection.js onParcelClick) and the panel's overlay style are executed here on
// fakes; the panel's own wiring around them is read from source.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dialog = read('../../frontend/js/proposals/dialog-share.js');
const selection = read('../../frontend/js/parcels/ui/parcel-selection.js');
const css = read('../../frontend/css/proposals.css');
const dictOf = locale => JSON.parse(read(`../../frontend/i18n/${locale}.json`));
const locales = ['en', 'hr', 'sr', 'es'];
const planStrings = locale => dictOf(locale).modal.roadWidth.share.plan;
const panelStrings = locale => dictOf(locale).proposals.share.panel;

const between = (from, to) => {
    const start = dialog.indexOf(from);
    const end = dialog.indexOf(to, start);
    expect(start, `missing marker: ${from}`).toBeGreaterThan(-1);
    expect(end, `missing marker after it: ${to}`).toBeGreaterThan(start);
    return dialog.slice(start, end);
};

// parcel-selection.js on a fake map, with a picking surface (MapPick) when `picking` is set. The parcel
// clicked is HR-1; `stack` is what the drill finds under the pointer, topmost first; `onParcel` the
// designs the storage lists for the parcel.
function clickParcel({ picking = 'share', stack = [], onParcel = [] } = {}) {
    const pick = vi.fn(() => true);
    const stopPropagation = vi.fn();
    // Without a picking surface the click stack shows everything under the point.
    const handleClick = vi.fn(() => true);
    const showParcelInfoPanel = vi.fn();
    const layer = { feature: { type: 'Feature', properties: { parcelId: 'HR-1' }, geometry: { type: 'Polygon', coordinates: [] } }, setStyle: vi.fn(), bringToFront: vi.fn() };
    const context = {
        console,
        document: { addEventListener: vi.fn(), getElementById: vi.fn(() => null), querySelector: vi.fn(() => null) },
        MapPick: { active: () => picking, pick },
        __drillUi: { stackAt: vi.fn(() => stack) },
        ClickStack: { handleClick },
        LiveParcelFabric: { get: id => (String(id) === 'HR-1' ? layer.feature : null) },
        ParcelPresenter: { getLayer: id => (String(id) === 'HR-1' ? layer : null), getIdForLayer: candidate => (candidate === layer ? 'HR-1' : null) },
        ParcelsUIParcelPanel: { showParcelInfoPanel },
        multiParcelSelection: { isActive: false, selectedParcels: new Set(), clearSelection: vi.fn(), clearSingleParcelSelection: vi.fn() },
        proposalStorage: { getProposalsForParcel: vi.fn(() => onParcel) },
        isProposalApplied: proposal => proposal.applied === true,
        getProposalKey: proposal => proposal.proposalId,
        isRoadParcel: () => false,
        map: { hasLayer: () => false },
        L: { DomEvent: { stopPropagation } }
    };
    context.window = context;
    vm.runInNewContext(selection, context);
    const event = { target: layer, latlng: { lat: 45.8, lng: 15.97 }, originalEvent: { shiftKey: false } };
    context.onParcelClick(event);
    return { pick, stopPropagation, handleClick, showParcelInfoPanel, event, stackAt: context.__drillUi.stackAt };
}

describe('a click on the map finds the row', () => {
    const building = { proposalId: 'building-1', applied: true };
    const layout = { proposalId: 'layout-1', applied: true };

    it('hands the topmost design at the click to the picking surface, with the parcel clicked', () => {
        const click = clickParcel({ stack: [{ kind: 'proposal', key: 'building-1', proposal: building }, { kind: 'proposal', key: 'layout-1', proposal: layout }, { kind: 'parcel' }] });
        expect(click.stackAt).toHaveBeenCalledWith(click.event.latlng);
        expect(click.pick).toHaveBeenCalledTimes(1);
        expect(click.pick).toHaveBeenCalledWith('building-1', { parcelId: 'HR-1' });
        // Pan/zoom only: the click selects nothing and opens nothing of the fabric's own.
        expect(click.stopPropagation).toHaveBeenCalledWith(click.event);
        expect(click.handleClick).not.toHaveBeenCalled();
        expect(click.showParcelInfoPanel).not.toHaveBeenCalled();
    });

    it('falls back to the applied design standing on the parcel, the way browse mode finds it', () => {
        const park = { proposalId: 'park-1', applied: true };
        const click = clickParcel({ stack: [{ kind: 'parcel' }], onParcel: [{ proposalId: 'draft-1', applied: false }, park] });
        expect(click.pick).toHaveBeenCalledWith('park-1', { parcelId: 'HR-1' });
        // Two copies of "which design is on this parcel" would drift between the two modes.
        expect(selection).toContain('const proposalOnThisParcel = () => {');
        expect(selection.match(/proposalOnThisParcel\(\)/g) || []).toHaveLength(2);
    });

    it('keeps ordinary fabric inert while a surface picks', () => {
        const click = clickParcel({ stack: [], onParcel: [] });
        expect(click.pick).not.toHaveBeenCalled();
        expect(click.stopPropagation).toHaveBeenCalledWith(click.event);
        expect(click.handleClick).not.toHaveBeenCalled();
    });

    it('leaves the click to the click stack when no surface picks', () => {
        const click = clickParcel({ picking: null, stack: [{ kind: 'proposal', key: 'building-1', proposal: building }] });
        expect(click.pick).not.toHaveBeenCalled();
        expect(click.handleClick).toHaveBeenCalledWith(click.event.latlng);
    });

    it('the pick mode ends when the panel closes, and a late pick is ignored', () => {
        // Left picking, the map would scroll rows in a list that is no longer on screen.
        expect(between('function closeSharePlanPanel(', 'function showSharePlanPanel(')).toContain("window.MapPick.end('share');");
        const picker = between('window.MapPick.begin({', '}).catch(');
        expect(picker).toContain('pick: (id, proposal, { parcelId }) => {');
        expect(picker).toContain('if (!panelStillOpen()) return;');
        expect(picker).toContain('revealRow(key, parcelId);');
    });

    it('says so when the picked proposal is applied but not in this plan', () => {
        // Doing nothing is indistinguishable from a click that missed.
        expect(between('window.MapPick.begin({', '}).catch(')).toContain("setStatus(tShare('plan.pickedNotInPlan'");
    });

    it('scrolls the row into view and marks exactly one', () => {
        const reveal = between('const revealRow = (key, parcelId) => {', 'const highlightRowProposal =');
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

describe('the map shows what is already published', () => {
    // The panel's overlay style, evaluated as written.
    const styleSource = between('const overlayStyleFor = (published, color) =>', 'const highlightedKeys =');
    const arrow = styleSource.slice(styleSource.indexOf('(published, color)'), styleSource.indexOf('});') + 2);
    const overlayStyleFor = vm.runInNewContext(`(${arrow})`);

    it('paints published solid and not-yet-published dashed', () => {
        expect(overlayStyleFor(true, '#e6194B')).toMatchObject({ dashArray: null });
        expect(overlayStyleFor(false, '#e6194B')).toMatchObject({ dashArray: '7 6' });
        // MapPick paints each highlighted design with the panel's style for its row: published means
        // the design hashes to the CID it was published as (DesignSync.publishedCid).
        expect(between('window.MapPick.begin({', '}).catch(')).toContain("style: key => overlayStyleFor(isPublished(key), colorByKey.get(key) || '#4363d8')");
        expect(dialog).toContain('const isPublished = key => !!(publishState.get(key) || {}).cid;');
    });

    it('distinguishes them by SHADING, not by a second colour', () => {
        // Every design already owns a colour to tell it from its neighbours; a second colour axis
        // would collide with the first. So fill opacity and dash carry the publication state instead.
        for (const published of [true, false]) {
            expect(overlayStyleFor(published, '#3cb44b')).toMatchObject({ color: '#3cb44b', fillColor: '#3cb44b' });
        }
    });

    it('repaints when a row is published, so the map cannot lag the row', () => {
        const update = between('const updateRowState = (key) => {', 'const onCheckboxChange =');
        expect(update).toContain("controls.row.classList.toggle('is-published', !!state.cid);");
        expect(update).toContain('window.MapPick.refresh([key]);');
        // A publish ends in updateRowState.
        expect(between('const publishRow = async (key) => {', 'const attachRow =')).toMatch(/publishState\.set\(key, \{ cid, publishing: false \}\);[\s\S]*updateRowState\(key\);/);
    });

    it('the map opacities are far enough apart to see over imagery', () => {
        expect(overlayStyleFor(true, '#000').fillOpacity - overlayStyleFor(false, '#000').fillOpacity).toBeGreaterThanOrEqual(0.25);
    });

    // The legend of two swatches is GONE, and its tests with it. It existed because the map painted
    // published and not-yet-published together and a dashed outline explains nothing on its own. The
    // subset filter replaced that: each mode shows one state and the pressed button names it, so the
    // legend described a distinction that is never on screen at the same time.
    it('names the subset with the filter instead of a legend', () => {
        expect(dialog, 'the legend swatches are back').not.toContain('legendEntry(');
        expect(css, 'the legend rules are back').not.toContain('.share-plan-legend {');
        expect(dialog).toContain("{ value: 'all', key: 'modal.roadWidth.share.plan.filterAll'");
        expect(dialog).toContain("{ value: 'published', key: 'proposals.share.panel.filterPublished'");
        expect(dialog).toContain("{ value: 'pending', key: 'proposals.share.panel.filterPending'");
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
        ['picked', 'pickedOnMap', 'pickedNotInPlan', 'filterAll']
            .forEach(key => expect(plan[key], `${locale} missing ${key}`).toBeTruthy());
        ['filterPublished', 'filterPending']
            .forEach(key => expect(panelStrings(locale)[key], `${locale} missing proposals.share.panel.${key}`).toBeTruthy());
        // Interpolated, and in the project's {{name}} form — a literal "{title}" would ship as text.
        expect(plan.picked).toContain('{{title}}');
        expect(plan.pickedOnMap).toContain('{{title}}');
        expect(plan.pickedOnMap).toContain('{{parcel}}');
    });

    it.each(locales)('%s translated them rather than copying English', locale => {
        if (locale === 'en') return;
        expect(planStrings(locale).pickedNotInPlan).not.toBe(planStrings('en').pickedNotInPlan);
        expect(panelStrings(locale).filterPending).not.toBe(panelStrings('en').filterPending);
    });
});
