// Characterization of the land readjustment editor (frontend/js/reparcellization.js) end to end: a
// fresh editor from createReparcellizationEditor() in a fake browser world
// (helpers/reparcellization-env.js) is opened on a selection or a saved plan and driven through its
// own panel and map — buttons, plots on the map, the owner popup, the drawing tools, keys — with the
// observable effects asserted: plots and owners in its state, panel text, layers, and the plan it
// hands to the proposal (window.pendingReparcellizationPlan and the design draft).
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { makeEditor, box } from './helpers/reparcellization-env.js';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

// Two side-by-side parcels, 2,000 m² (Ana) and 3,000 m² (Bo), 50 m deep: one 100 × 50 m pool.
const PARCELS = [
    { id: 'P1', geometry: box(0, 0, 40, 50), properties: { calculatedArea: 2000 } },
    { id: 'P2', geometry: box(40, 0, 100, 50), properties: { calculatedArea: 3000 } }
];
const OWNERS = {
    P1: [{ key: 'o-ana', ownerId: 'ana', displayName: 'Ana', shareText: '1/1' }],
    P2: [{ key: 'o-bo', ownerId: 'bo', displayName: 'Bo', shareText: '1/1' }]
};

function world(options = {}) {
    env = makeEditor({ parcels: PARCELS, owners: OWNERS, selection: { ids: ['P1', 'P2'] }, ...options });
    return env;
}

const area = geometry => turf.area({ type: 'Feature', properties: {}, geometry });
const plotOwners = slice => (slice.owners || []).map(owner => owner.ownerKey);

describe('opening', () => {
    it('refuses without a selection, and says so', async () => {
        const w = world({ selection: null });
        expect(await w.editor.openReparcellizationModal()).toBe(false);
        expect(globalThis.updateStatus.calls.at(-1)[0]).toBe('Select at least one parcel before running reparcellization.');
        expect(globalThis.OnMapEditor.open.calls).toHaveLength(0);
    });

    it('refuses ground another proposal holds (a road\'s corridor piece)', async () => {
        const w = world({
            parcels: [PARCELS[0], { ...PARCELS[1], properties: { ...PARCELS[1].properties, isCorridor: true } }]
        });
        expect(await w.editor.openReparcellizationModal()).toBe(false);
        expect(globalThis.showEphemeralMessage.calls[0]).toEqual([
            'A land readjustment cannot take ground another proposal already holds. Deselect it, or unapply that proposal first.', 8000, 'warning'
        ]);
        expect(globalThis.OnMapEditor.open.calls).toHaveLength(0);
    });

    it('is one editor at a time, even for two requests in the same tick', async () => {
        // Reopening a saved plan awaits its input parcels before anything is built, which is
        // where a guard on the built modal alone lets a second request through.
        const plan = { parcelIds: ['P1', 'P2'], polygons: [{ ownerKey: 'ana', geometry: box(0, 0, 100, 50) }] };
        const w = world({ pendingPlan: plan });
        const open = () => w.editor.openReparcellizationModal({ algorithm: 'manual', initialPolygons: plan.polygons });
        const [first, second] = await Promise.all([open(), open()]);
        expect([first, second]).toEqual([true, false]);
        expect(await w.editor.openReparcellizationModal()).toBe(false);
        expect(globalThis.OnMapEditor.open.calls).toHaveLength(1);
    });

    it('opens on the automatic split: one plot per owner in proportion to value, all land assigned, Done enabled', async () => {
        const w = world();
        expect(await w.editor.openReparcellizationModal()).toBe(true);
        const { state } = w;
        expect(state.algorithm).toBe('sweep-line');
        expect(state.ownerShares.map(owner => [owner.ownerKey, owner.displayName, owner.percent])).toEqual([
            ['bo', 'Owner B', 0.6], ['ana', 'Owner A', 0.4]
        ]);
        expect(state.slices.map(plotOwners)).toEqual([['bo'], ['ana']]);
        // Value shares of the pooled ground, to the slicer's tolerance.
        expect(area(state.slices[0].geometry) / state.totalArea).toBeCloseTo(0.6, 2);
        expect(area(state.slices[1].geometry) / state.totalArea).toBeCloseTo(0.4, 2);
        expect(area(state.slices[0].geometry) + area(state.slices[1].geometry)).toBeCloseTo(state.totalArea, 0);

        // The panel and the map.
        expect(globalThis.OnMapEditor.open.calls[0][0]).toMatchObject({ owner: 'reparcellization', title: 'Reparcellization', modes: ['2d'] });
        expect(w.document.contains(state.modal)).toBe(true);
        expect(w.plotLayers()).toHaveLength(2);
        expect(w.plotLayers()[0].options.pane).toBe('reparcelPlots');
        expect(state.boundaryLayer.getLayers()[0].options).toMatchObject({ color: '#dc2626', pane: 'reparcelTools', interactive: false });
        expect(w.$('[data-reparcel-commit]').disabled).toBe(false);
        expect(state.coverageEl.textContent).toMatch(/^All pooled land assigned \(100\.0%\)\./);
        expect(state.legendListEl.textContent).toContain('Owner A');
        expect(state.newPlotsListEl.querySelectorAll('tr.reparcel-newplot-row')).toHaveLength(2);
        // The node handles are the editor: they are on from the start.
        expect(state.nodeEdit.active).toBe(true);
        expect(w.handles()).not.toBeNull();
        expect(w.windowListeners('keydown')).toContain(state.escHandler);
    });

    it('a single owner readjusts against public land, half and half', async () => {
        const w = world({ parcels: [PARCELS[0]], selection: { ids: ['P1'] } });
        await w.editor.openReparcellizationModal();
        expect(w.state.ownerShares.map(owner => [owner.ownerKey, owner.percent])).toEqual([['ana', 0.5], ['public-land', 0.5]]);
        expect(w.state.slices).toHaveLength(2);
    });
});

describe('leaving', () => {
    it('Done saves the plan to the proposal and closes the editor', async () => {
        const w = world();
        await w.editor.openReparcellizationModal();
        const session = w.session();
        w.$('[data-reparcel-commit]').click();

        const plan = globalThis.pendingReparcellizationPlan;
        expect(plan).toMatchObject({ algorithm: 'sweep-line', parcelIds: ['P1', 'P2'], contributionBasis: 'value', isSingleOwner: false });
        expect(plan.polygons.map(polygon => polygon.ownerKey)).toEqual(['bo', 'ana']);
        expect(plan.polygons.every(polygon => polygon.geometry && polygon.area > 0)).toBe(true);
        expect(plan.ownerShares.map(owner => owner.ownerKey)).toEqual(['bo', 'ana']);
        expect(area(plan.poolGeometry)).toBeCloseTo(plan.totalArea, 0);
        expect(plan.polygons.reduce((sum, polygon) => sum + polygon.area, 0)).toBeCloseTo(plan.totalArea, 0);
        expect(globalThis.syncActiveProposalDraftFromEditor.calls[0]).toEqual(['reparcellization', plan, { coalesceKey: 'reparcellization-design' }]);
        expect(session.close.calls).toHaveLength(1);
        expect(w.document.contains(session.root)).toBe(false);
        expect(w.state.modal).toBeNull();
        expect(w.windowListeners('keydown')).toEqual([]);
        expect(globalThis.finishProposalDraftDesignSession.calls).toHaveLength(1);
        expect(globalThis.discardProposalDraftDesignSession.calls).toHaveLength(0);
        expect(globalThis.showEphemeralMessage.calls.at(-1)).toEqual(['Saved reparcellization layout for this proposal.', 4000, 'success']);
    });

    it('Cancel with nothing changed closes and discards without asking', async () => {
        const w = world();
        await w.editor.openReparcellizationModal();
        w.$('[data-reparcel-cancel]').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(globalThis.CbDialog.confirm.calls).toHaveLength(0);
        expect(w.state.modal).toBeNull();
        expect(globalThis.pendingReparcellizationPlan).toBeNull();
        expect(globalThis.syncActiveProposalDraftFromEditor.calls).toHaveLength(0);
        expect(globalThis.discardProposalDraftDesignSession.calls).toHaveLength(1);
    });

    it('Escape after an edit asks first: Keep editing keeps the editor, Discard closes it unsaved', async () => {
        const w = world();
        await w.editor.openReparcellizationModal();
        w.$('[data-reparcel-assign]').click();
        w.$('[data-reparcel-all-public]').click();
        globalThis.CbDialog.confirm = Object.assign(async () => false, { calls: [] });
        w.key('Escape');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(w.state.modal).not.toBeNull();

        globalThis.CbDialog.confirm = async () => true;
        w.key('Escape');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(w.state.modal).toBeNull();
        expect(globalThis.pendingReparcellizationPlan).toBeNull();
        expect(globalThis.discardProposalDraftDesignSession.calls).toHaveLength(1);
    });
});

describe('drawing freely', () => {
    async function manual(w) {
        await w.editor.openReparcellizationModal({ algorithm: 'manual' });
        return w;
    }

    it('starts from the undivided pool as one unassigned plot, and Done waits for an owner', async () => {
        const w = await manual(world());
        expect(w.state.slices).toHaveLength(1);
        expect(plotOwners(w.state.slices[0])).toEqual([]);
        expect(w.$('[data-reparcel-commit]').disabled).toBe(true);
        expect(w.state.coverageEl.textContent).toMatch(/^1 plot\(s\) unassigned · .* not yet assigned \(0\.0% covered\)\.$/);
        expect(w.state.coverageEl.getAttribute('data-state')).toBe('warn');
    });

    it('a line across the pool cuts it in two; Ctrl+Z puts it back', async () => {
        const w = await manual(world());
        w.$('[data-reparcel-line]').click();
        expect(w.state.drawing).toMatchObject({ active: true, mode: 'line' });
        expect(w.$('[data-reparcel-line]').getAttribute('aria-pressed')).toBe('true');
        expect(w.$('[data-reparcel-draw-toolbar]').hidden).toBe(false);
        w.clickAt(30, -10);
        w.clickAt(30, 60);
        expect(w.state.drawing.points).toHaveLength(2);
        w.key('f');
        expect(w.state.drawing.active).toBe(false);
        expect(w.state.slices).toHaveLength(2);
        const areas = w.state.slices.map(slice => area(slice.geometry)).sort((a, b) => a - b);
        expect(areas[0] / w.state.totalArea).toBeCloseTo(0.3, 2);
        expect(w.statusText()).toMatch(/^Cut made — 1 new plot\(s\)/);
        expect(w.plotLayers()).toHaveLength(2);

        const undo = w.key('z', { ctrlKey: true });
        expect(undo.defaultPrevented).toBe(true);
        expect(w.state.slices).toHaveLength(1);
        expect(w.statusText()).toBe('Undid the last change.');
    });

    it('a line that meets the boundary only once changes nothing and says why', async () => {
        const w = await manual(world());
        w.$('[data-reparcel-line]').click();
        w.clickAt(30, -10);
        w.clickAt(30, 25);
        w.key('Enter');
        expect(w.state.slices).toHaveLength(1);
        expect(w.statusText()).toMatch(/^That line met the existing boundaries in fewer than two places/);
    });

    it('a drawn plot is carved out of the plot it lies in; U takes back a point while drawing', async () => {
        const w = await manual(world());
        w.$('[data-reparcel-draw]').click();
        w.clickAt(10, 10);
        w.clickAt(30, 10);
        w.clickAt(99, 99);
        w.key('u');
        expect(w.state.drawing.points).toHaveLength(2);
        w.clickAt(30, 30);
        w.clickAt(10, 30);
        w.$('[data-reparcel-finish]').click();
        expect(w.state.slices).toHaveLength(2);
        const carved = w.state.slices.find(slice => area(slice.geometry) < 1000);
        expect(area(carved.geometry)).toBeCloseTo(400, -1);
        expect(w.statusText()).toBe('Plot added. Click it to assign owners.');
        // The pieces still tile the pool.
        const total = w.state.slices.reduce((sum, slice) => sum + area(slice.geometry), 0);
        expect(total).toBeCloseTo(w.state.totalArea, 0);
    });

    it('a plot drawn outside the pool is refused', async () => {
        const w = await manual(world());
        w.$('[data-reparcel-draw]').click();
        [[200, 0], [220, 0], [220, 20]].forEach(([e, n]) => w.clickAt(e, n));
        w.key('f');
        expect(w.state.slices).toHaveLength(1);
        expect(w.statusText()).toBe('The drawn plot is outside the pooled land.');
    });

    it('erasing the boundary between two plots makes them one', async () => {
        const w = await manual(world());
        w.$('[data-reparcel-line]').click();
        w.clickAt(30, -10);
        w.clickAt(30, 60);
        w.key('f');
        w.$('[data-reparcel-erase]').click();
        expect(w.state.erase.active).toBe(true);
        expect(w.statusText()).toMatch(/1 boundaries can be erased\.$/);
        const lines = w.state.erase.layer.getLayers().filter(layer => layer.options.className === 'reparcel-erase-line');
        expect(lines.length).toBeGreaterThan(0);
        lines[0].fire('click', { originalEvent: {} });
        expect(w.state.slices).toHaveLength(1);
        expect(area(w.state.slices[0].geometry)).toBeCloseTo(w.state.totalArea, 0);
    });
});

describe('assigning owners', () => {
    it('in assign mode a plot click opens the owner picker; ticking an owner assigns the plot', async () => {
        const w = world();
        await w.editor.openReparcellizationModal({ algorithm: 'manual' });
        w.$('[data-reparcel-line]').click();
        w.clickAt(40, -10);
        w.clickAt(40, 60);
        w.key('f');

        // Editing mode: a click on a plot does not open the picker.
        w.clickPlot(0);
        expect(w.popup()).toBeNull();

        w.$('[data-reparcel-assign]').click();
        expect(w.state.assignMode).toBe(true);
        expect(w.state.nodeEdit.active).toBe(false);
        expect(w.$('[data-reparcel-all-public]').hidden).toBe(false);
        w.clickPlot(0);
        let picker = w.popup().content;
        const rowsOf = popup => popup.querySelectorAll('label.reparcel-owner-popup__row');
        expect(rowsOf(picker).map(row => row.textContent.trim())).toEqual(['Owner B', 'Owner A', 'Public land']);
        rowsOf(picker)[1].querySelector('input').click();
        expect(plotOwners(w.state.slices[0])).toEqual(['ana']);
        expect(w.state.slices[0].displayName).toBe('Owner A');
        expect(w.plotLayers()[0].tooltip).toBe('Owner A');
        expect(w.$('[data-reparcel-commit]').disabled).toBe(true);   // plot 2 has no owner yet

        // The other plot to Bo: everything is assigned and Done is enabled.
        w.clickPlot(1);
        rowsOf(w.popup().content)[0].querySelector('input').click();
        expect(w.$('[data-reparcel-commit]').disabled).toBe(false);

        // A second owner on plot 1 splits it equally; the share editor follows.
        w.clickPlot(0);
        picker = w.popup().content;
        rowsOf(picker)[0].querySelector('input').click();
        expect(w.state.slices[0].owners.map(owner => [owner.ownerKey, owner.share])).toEqual([['ana', 0.5], ['bo', 0.5]]);
        const shareInputs = picker.querySelectorAll('.reparcel-share-row').map(row => row.querySelector('input'));
        expect(shareInputs.map(input => input.value)).toEqual(['50', '50']);

        // Custom shares typed but not applied hold Done back; applied, they stand.
        shareInputs[0].value = '30';
        shareInputs[0].dispatchEvent({ type: 'input', bubbles: false });
        shareInputs[1].value = '70';
        shareInputs[1].dispatchEvent({ type: 'input', bubbles: false });
        expect(w.state.shareDraftPending).toBe(true);
        expect(w.$('[data-reparcel-commit]').disabled).toBe(true);
        expect(w.state.coverageEl.textContent).toBe('Apply the edited shares, or close the share editor to discard them.');
        picker.querySelector('.reparcel-apply-shares').click();
        expect(w.state.slices[0].owners.map(owner => [owner.ownerKey, owner.share])).toEqual([['ana', 0.3], ['bo', 0.7]]);
        expect(w.state.shareDraftPending).toBe(false);
        expect(w.popup()).toBeNull();
        expect(w.$('[data-reparcel-commit]').disabled).toBe(false);

        w.$('[data-reparcel-commit]').click();
        const plan = globalThis.pendingReparcellizationPlan;
        expect(plan.algorithm).toBe('manual');
        expect(plan.polygons.map(polygon => polygon.owners.map(owner => [owner.ownerKey, owner.share]))).toEqual([
            [['ana', 0.3], ['bo', 0.7]], [['bo', 1]]
        ]);
    });

    it('All public gives every plot to public land, which completes the plan', async () => {
        const w = world();
        await w.editor.openReparcellizationModal({ algorithm: 'manual' });
        w.$('[data-reparcel-assign]').click();
        w.$('[data-reparcel-all-public]').click();
        expect(w.state.slices.map(plotOwners)).toEqual([['public-land']]);
        expect(w.$('[data-reparcel-commit]').disabled).toBe(false);
        // Leaving assign mode brings the node handles back.
        w.$('[data-reparcel-assign]').click();
        expect(w.state.nodeEdit.active).toBe(true);
    });

    it('a cash offer typed into the owners table enters the plan', async () => {
        const w = world();
        await w.editor.openReparcellizationModal();
        const input = w.state.legendListEl.querySelectorAll('.cash-offer-input')
            .find(element => element.getAttribute('data-owner-key') === 'ana');
        input.value = '1500';
        input.dispatchEvent({ type: 'input', bubbles: false });
        expect(w.state.cashOfferOverrides.ana).toBe(1500);
        w.$('[data-reparcel-commit]').click();
        const ana = globalThis.pendingReparcellizationPlan.ownerShares.find(owner => owner.ownerKey === 'ana');
        expect(ana.cashOffer).toBe(1500);
    });
});

describe('switching the starting layout', () => {
    it('Draw freely continues from the automatic split, owners included', async () => {
        const w = world();
        await w.editor.openReparcellizationModal();
        const before = w.state.slices.map(plotOwners);
        const manualRadio = w.$('input[name="reparcel-algorithm"][value="manual"]');
        manualRadio.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(w.state.algorithm).toBe('manual');
        expect(w.state.slices.map(plotOwners)).toEqual(before);
        expect(w.state.sweepHandle).toBeNull();
        expect(w.statusText()).toMatch(/^Drawing freely from the current layout\./);
    });
});

describe('moving a boundary node', () => {
    it('a node moved through the handle layer reshapes both plots that share it', async () => {
        const w = world();
        await w.editor.openReparcellizationModal({ algorithm: 'manual' });
        w.$('[data-reparcel-line]').click();
        w.clickAt(50, -10);
        w.clickAt(50, 60);
        w.key('f');
        const layer = w.handles();
        const topology = layer.render();
        // The cut's top end: on the pool's north edge, where it may only slide along that edge.
        const [lng50, lat50] = turf.centroid({ type: 'Feature', geometry: box(50, 50, 50.001, 50.001) }).geometry.coordinates;
        const node = topology.nodes.find(candidate => Math.abs(candidate.coord[0] - lng50) < 1e-6 && Math.abs(candidate.coord[1] - lat50) < 1e-6);
        expect(node).toBeTruthy();
        const [lng70] = turf.centroid({ type: 'Feature', geometry: box(70, 50, 70.001, 50.001) }).geometry.coordinates;
        const before = w.state.slices.map(slice => area(slice.geometry));
        layer.options.onMove(node.id, [lng70, node.coord[1]], topology);
        const after = w.state.slices.map(slice => area(slice.geometry));
        // The cut now runs from (50, 0) to (70, 50): 500 m² changes hands.
        expect(Math.abs(after[0] - before[0])).toBeCloseTo(500, -1);
        expect(after[0] + after[1]).toBeCloseTo(before[0] + before[1], 0);
        w.key('z', { metaKey: true });
        expect(w.state.slices.map(slice => area(slice.geometry))).toEqual(before);
    });
});

describe('editing a saved readjustment', () => {
    function savedPlan() {
        return {
            algorithm: 'upu-plan',
            parcelIds: ['P1', 'P2'],
            poolGeometry: box(0, 0, 100, 50),
            polygons: [
                { ownerKey: 'ana', displayName: 'Ana', color: '#2E86AB', geometry: box(0, 0, 45, 50), owners: [{ ownerKey: 'ana', displayName: 'Ana', share: 1 }] },
                { ownerKey: 'bo', displayName: 'Bo', color: '#F18F01', geometry: box(45, 0, 100, 50) }
            ],
            ownerShares: [
                { ownerKey: 'ana', displayName: 'Ana', contributedArea: 2000, contributedValue: 266000, percent: 0.4 },
                { ownerKey: 'bo', displayName: 'Bo', contributedArea: 3000, contributedValue: 399000, percent: 0.6 }
            ],
            contributionBasis: 'value', valuationCurrency: 'EUR', totalValue: 665000, poolUnitValue: 133
        };
    }

    // What the design draft's adapter does (proposal-editor-adapters.js openDesignEditor): the plan
    // becomes the pending plan, and the editor opens on its algorithm, plots and pool.
    function reopen(w, plan) {
        return w.editor.openReparcellizationModal({
            algorithm: plan.algorithm, ownershipMode: 'multiple',
            initialPolygons: JSON.parse(JSON.stringify(plan.polygons)),
            poolGeometry: JSON.parse(JSON.stringify(plan.poolGeometry)), approvalConfig: null
        });
    }

    it('reopens on the plan\'s own plots and declared parcels — not the map selection — in manual mode, clean', async () => {
        const plan = savedPlan();
        const w = world({ selection: { ids: ['P1'] }, pendingPlan: plan });
        expect(await reopen(w, plan)).toBe(true);
        expect(globalThis.CadastralParcelRepository.ensureIds.calls[0][0]).toEqual(['P1', 'P2']);
        expect(w.state.selection).toEqual({ ids: ['P1', 'P2'], source: 'cadastre' });
        // An algorithm this editor does not know is hand-authored ground.
        expect(w.state.algorithm).toBe('manual');
        expect(w.state.slices.map(plotOwners)).toEqual([['ana'], ['bo']]);
        expect(w.$('[data-reparcel-commit]').disabled).toBe(false);
        expect(w.editor.isDirty()).toBe(false);
        w.$('[data-reparcel-cancel]').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(globalThis.CbDialog.confirm.calls).toHaveLength(0);
    });

    it('an edit of the saved plan is saved by Done and only by Done', async () => {
        const plan = savedPlan();
        const w = world({ selection: null, pendingPlan: plan });
        await reopen(w, plan);
        w.$('[data-reparcel-assign]').click();
        w.clickPlot(1);
        const rows = w.popup().content.querySelectorAll('label.reparcel-owner-popup__row');
        rows.find(row => row.textContent.trim() === 'Public land').querySelector('input').click();
        expect(w.editor.isDirty()).toBe(true);
        expect(globalThis.syncActiveProposalDraftFromEditor.calls).toHaveLength(0);
        w.$('[data-reparcel-commit]').click();
        const saved = globalThis.pendingReparcellizationPlan;
        expect(saved.parcelIds).toEqual(['P1', 'P2']);
        expect(saved.polygons[1].owners.map(owner => owner.ownerKey)).toEqual(['bo', 'public-land']);
        expect(saved).not.toBe(plan);
        expect(globalThis.syncActiveProposalDraftFromEditor.calls).toHaveLength(1);
    });
});

describe('other starting layouts and pools', () => {
    it('Keep existing parcels starts from the input parcels with their owners, and is complete', async () => {
        const w = world();
        await w.editor.openReparcellizationModal({ algorithm: 'amend' });
        expect(w.state.slices.map(plotOwners)).toEqual([['ana'], ['bo']]);
        expect(w.state.slices.map(slice => Math.round(area(slice.geometry)))).toEqual(PARCELS.map(parcel => Math.round(area(parcel.geometry))));
        expect(w.$('[data-reparcel-courtyard-tools]').hidden).toBe(false);
        expect(w.$('[data-reparcel-commit]').disabled).toBe(false);
        w.$('[data-reparcel-commit]').click();
        expect(globalThis.pendingReparcellizationPlan.inputParcels.map(input => input.parcelId)).toEqual(['P1', 'P2']);
    });

    it('a subdivision pools a drawn site: the bound parcel\'s part plus unrepresented open ground', async () => {
        const w = world({ selection: null });
        const site = box(0, 0, 60, 50);   // P1 whole (2,000 m²) and 1,000 m² of open ground beside it
        expect(await w.editor.openReparcellizationModal({ sitePool: { site, boundParcelIds: ['P1'] } })).toBe(true);
        expect(globalThis.OnMapEditor.open.calls[0][0].title).toBe('Subdivision');
        const shares = w.state.ownerShares.map(owner => [owner.ownerKey, !!owner.unrepresentedGround]);
        expect(shares.find(([key]) => key === 'ana')).toEqual(['ana', false]);
        expect(shares.filter(([, unrepresentedGround]) => unrepresentedGround)).toHaveLength(1);
        expect(w.state.ownerShares.some(owner => owner.ownerKey === 'public-land')).toBe(false);
        // "Keep existing parcels" has nothing to keep on open ground.
        expect(w.$('input[name="reparcel-algorithm"][value="amend"]').hasAttribute('disabled')).toBe(true);
        w.$('[data-reparcel-commit]').click();
        expect(globalThis.pendingReparcellizationPlan).toMatchObject({ poolSource: 'site' });
        expect(globalThis.pendingReparcellizationPlan.openGroundM2).toBeCloseTo(area(site) - area(PARCELS[0].geometry), -1);
    });
});
