// Before/after on the main map (proposals/before-after.js): what "before" is made of, when a
// proposal can be compared at all, and the session's lifecycle against the details panel, over
// fake collaborators (no Leaflet, no DOM).
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BeforeAfter = require('../../frontend/js/proposals/before-after.js');
const { footprintParts } = require('../../frontend/js/proposals/footprint-parts.js');

const square = (lng, lat, size = 0.001) => ({
    type: 'Polygon',
    coordinates: [[[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]]]
});
const feature = (id, geometry = square(16, 45.8)) => ({ type: 'Feature', properties: { parcelId: id }, geometry });
const isApplied = proposal => proposal.applied === true;

describe('canCompare', () => {
    it('needs an applied record with a footprint on the map', () => {
        const deps = { isApplied, footprintParts };
        expect(BeforeAfter.canCompare({ applied: true, goal: 'single-building', geometry: square(16, 45.8) }, deps)).toBe(true);
        expect(BeforeAfter.canCompare({ applied: false, goal: 'single-building', geometry: square(16, 45.8) }, deps)).toBe(false);
        expect(BeforeAfter.canCompare({ applied: true, goal: 'urban-rule', cadastreParcelIds: ['HR-1'] }, deps)).toBe(false);
        const legacyRoad = { applied: true, goal: 'road-track', roadProposal: { definition: {
            points: [[16, 45.8], [16.001, 45.8]], width: 12,
            constructionFrame: { kind: 'legacy-centreline', migration: 'legacy-centreline-v1' }
        } } };
        expect(BeforeAfter.canCompare(legacyRoad, deps)).toBe(true);
        expect(BeforeAfter.canCompare(null, deps)).toBe(false);
        expect(BeforeAfter.canCompare({ applied: true, geometry: square(16, 45.8) }, {})).toBe(false);
    });
});

describe('beforeLayers', () => {
    it('keeps untouched parcels as they are, swaps anything derived from a claimed parcel for its original, and gates buildings on the Layers sheet', () => {
        const originalA = feature('A', square(16, 45.8, 0.002));
        const presented = [
            { id: 'A:plot-1', feature: feature('A:plot-1'), cadastreIds: ['A'] },
            { id: 'A:plot-2', feature: feature('A:plot-2'), cadastreIds: ['A'] },
            { id: 'B', feature: feature('B'), cadastreIds: ['B'] },
            { id: 'C', feature: feature('C'), cadastreIds: [] },
            { id: 'piece-of-A-and-B', feature: feature('piece'), cadastreIds: ['B', 'A'] },
            { id: 'broken', feature: null, cadastreIds: ['Z'] }
        ];
        const buildings = [feature('bld-1'), { type: 'Feature', properties: {} }];

        const shown = BeforeAfter.beforeLayers({ affectedIds: ['A', 7], originals: [originalA, null], presented, buildings, buildingsShown: true });
        expect(shown.parcels.map(f => f.properties.parcelId)).toEqual(['B', 'C', 'A']);
        expect(shown.parcels[2]).toBe(originalA);
        expect(shown.buildings).toEqual([buildings[0]]);

        const hidden = BeforeAfter.beforeLayers({ affectedIds: new Set(['A']), originals: [originalA], presented, buildings, buildingsShown: false });
        expect(hidden.buildings).toEqual([]);
        expect(BeforeAfter.beforeLayers({})).toEqual({ parcels: [], buildings: [], previous: [], focus: [] });
    });

    it('carries the replaced version\'s footprint and the one focused parcel, found among the originals', () => {
        const originalA = feature('A');
        const originalB = feature('B');
        const previous = [feature('old'), { type: 'Feature', properties: {} }];
        const layers = BeforeAfter.beforeLayers({ affectedIds: ['A', 'B'], originals: [originalA, originalB], presented: [], previous, focusParcelId: 'B' });
        expect(layers.previous).toEqual([previous[0]]);
        expect(layers.focus).toEqual([originalB]);
        expect(BeforeAfter.beforeLayers({ affectedIds: ['A'], originals: [originalA], focusParcelId: 'Z' }).focus).toEqual([]);
    });
});

describe('footprintFeatures', () => {
    it('turns a record\'s footprint polygons into features and nothing else', () => {
        const record = { goal: 'single-building', geometry: square(16, 45.8), structureProposal: { geometry: square(16.002, 45.8) } };
        const features = BeforeAfter.footprintFeatures(record, footprintParts);
        expect(features).toHaveLength(2);
        expect(features[0]).toMatchObject({ type: 'Feature', geometry: { type: 'Polygon' } });
        expect(BeforeAfter.footprintFeatures(null, footprintParts)).toEqual([]);
        expect(BeforeAfter.footprintFeatures(record, null)).toEqual([]);
    });
});

function harness({ applied = true, originals = [feature('A', square(16, 45.8, 0.002))], ensureFails = false, buildingsShown = true, previous = null } = {}) {
    const proposal = { proposalId: 'p-1', applied, goal: 'single-building', geometry: square(16, 45.8), cadastreParcelIds: ['A'] };
    const fabric = {
        peek: id => ({ 'A:plot-1': feature('A:plot-1'), B: feature('B') }[id] || null),
        explicitCadastreIds: f => (f.properties.parcelId.startsWith('A') ? ['A'] : [f.properties.parcelId]),
        featureId: f => f.properties.parcelId,
        entriesForCadastre: ids => (ids.includes('A') ? [feature('A:plot-1'), feature('A:plot-2')] : [])
    };
    const presenter = {
        getLayersWithinBounds: vi.fn(() => ['layer-A', 'layer-B', 'layer-gone']),
        getIdForLayer: layer => ({ 'layer-A': 'A:plot-1', 'layer-B': 'B' }[layer] || null)
    };
    const repository = { ensureIds: vi.fn(async ids => {
        if (ensureFails) throw new Error('ground unavailable');
        return { status: 'ready', ids, features: originals };
    }) };
    const drawn = [];
    const L = {
        canvas: () => 'canvas',
        geoJSON: (collection, options) => {
            const layer = { collection, options, removed: 0, addTo(target) { drawn.push({ target, collection, options, layer }); return layer; }, remove() { layer.removed += 1; } };
            return layer;
        }
    };
    const sessions = [];
    const attach = vi.fn((map, options) => {
        const session = { map, options, disposed: 0, handleEl: { focus: vi.fn() }, dispose() { this.disposed += 1; } };
        sessions.push(session);
        options.drawBefore('before-map');
        return session;
    });
    const changes = [];
    const warnings = [];
    const deps = {
        map: { getBounds: () => 'bounds' }, L, presenter, fabric, repository,
        claims: { cadastreParcelIdsOf: p => p.cadastreParcelIds },
        isApplied, footprintParts, attach,
        findProposal: key => (key === 'p-1' ? proposal : null),
        previousVersionOf: () => previous,
        buildingPool: () => [feature('bld-1')], buildingsShown: () => buildingsShown,
        buildingStyle: () => ({ color: 'building' }), parcelStyle: id => ({ color: 'parcel:' + id }),
        t: (key, fallback) => fallback + '!', warn: (...args) => warnings.push(args), onChange: active => changes.push(active)
    };
    const instance = BeforeAfter.create(() => deps);
    return { instance, proposal, deps, drawn, sessions, changes, warnings, repository, presenter };
}

describe('ProposalBeforeAfter session', () => {
    it('starts from the details button with the ground as it stands, then toggles off again', async () => {
        const h = harness();
        expect(await h.instance.toggle('p-1')).toBe(true);
        expect(h.instance.isActive()).toBe(true);
        expect(h.instance.isActive('p-1')).toBe(true);
        expect(h.instance.isActive('p-2')).toBe(false);
        expect(h.repository.ensureIds).toHaveBeenCalledWith(['A'], { retainOnly: true });
        expect(h.sessions).toHaveLength(1);
        expect(h.sessions[0].map).toBe(h.deps.map);
        expect(h.sessions[0].options.labels).toEqual({ before: 'Before!', after: 'After!' });
        expect(h.sessions[0].options.sliderLabel).toBe('Before and after comparison!');
        expect(h.sessions[0].options.labelPlacement).toBe('divider');
        expect(h.sessions[0].handleEl.focus).toHaveBeenCalled();

        // Parcels first (B as it is, A in its original shape), then the existing buildings, one canvas.
        expect(h.drawn.map(d => d.target)).toEqual(['before-map', 'before-map']);
        expect(h.drawn[0].collection.features.map(f => f.properties.parcelId)).toEqual(['B', 'A']);
        expect(h.drawn[0].options).toMatchObject({ renderer: 'canvas', interactive: false });
        expect(h.drawn[0].options.style(feature('B'))).toEqual({ color: 'parcel:B' });
        expect(h.drawn[1].collection.features.map(f => f.properties.parcelId)).toEqual(['bld-1']);
        expect(h.drawn[1].options.style()).toEqual({ color: 'building' });
        expect(h.changes).toEqual([true]);

        expect(await h.instance.toggle('p-1')).toBe(false);
        expect(h.instance.isActive()).toBe(false);
        expect(h.sessions[0].disposed).toBe(1);
        expect(h.changes).toEqual([true, false]);
        expect(h.instance.dispose()).toBe(false);
    });

    it('refuses what cannot be compared and survives missing ground', async () => {
        const unapplied = harness({ applied: false });
        expect(await unapplied.instance.toggle('p-1')).toBe(false);
        expect(unapplied.sessions).toHaveLength(0);
        expect(await unapplied.instance.toggle('nope')).toBe(false);

        const noGround = harness({ ensureFails: true, buildingsShown: false });
        expect(await noGround.instance.toggle('p-1')).toBe(true);
        expect(noGround.warnings).toHaveLength(1);
        expect(noGround.drawn).toHaveLength(1);
        expect(noGround.drawn[0].collection.features.map(f => f.properties.parcelId)).toEqual(['B']);
    });

    it('outlines the replaced version on the before side when the record has one', async () => {
        const h = harness({ previous: { goal: 'single-building', geometry: square(16.001, 45.8) } });
        await h.instance.toggle('p-1');
        expect(h.drawn.map(d => d.target)).toEqual(['before-map', 'before-map', 'before-map']);
        expect(h.drawn[2].collection.features).toHaveLength(1);
        expect(h.drawn[2].options.style()).toEqual(BeforeAfter.PREVIOUS_STYLE);
    });

    it('opened for one parcel, outlines it on the before side and its plots on the live map, and moves between parcels', async () => {
        const h = harness();
        expect(await h.instance.toggle('p-1', { focusParcelId: 'A' })).toBe(true);
        expect(h.instance.activeFocus()).toBe('A');
        const onHost = h.drawn.filter(d => d.target === h.deps.map);
        expect(onHost).toHaveLength(1);
        expect(onHost[0].collection.features.map(f => f.properties.parcelId)).toEqual(['A:plot-1', 'A:plot-2']);
        expect(onHost[0].options.style()).toEqual(BeforeAfter.FOCUS_AFTER_STYLE);
        const focusBefore = h.drawn.filter(d => d.target === 'before-map').pop();
        expect(focusBefore.collection.features.map(f => f.properties.parcelId)).toEqual(['A']);
        expect(focusBefore.options.style()).toEqual(BeforeAfter.FOCUS_BEFORE_STYLE);
        expect(h.changes).toEqual([true]);

        // Asked for the same parcel again: closes. Asked for another parcel: moves the focus.
        await h.instance.toggle('p-1', { focusParcelId: 'A' });
        expect(h.instance.isActive()).toBe(false);
        expect(onHost[0].layer.removed).toBe(1);
        await h.instance.toggle('p-1', { focusParcelId: 'A' });
        await h.instance.toggle('p-1', { focusParcelId: 'B' });
        expect(h.instance.isActive('p-1')).toBe(true);
        expect(h.instance.activeFocus()).toBe('B');
        expect(h.sessions.map(s => s.disposed)).toEqual([1, 1, 0]);
        // The plain toggle while a focused comparison runs just ends it.
        await h.instance.toggle('p-1');
        expect(h.instance.isActive()).toBe(false);
    });

    it('ends with the panel: another proposal or an unapplied one disposes, a re-render of the same applied one does not', async () => {
        const h = harness();
        await h.instance.toggle('p-1');
        expect(h.instance.reconcile(h.proposal, 'p-1')).toBe(false);
        expect(h.instance.isActive()).toBe(true);
        expect(h.instance.reconcile({ ...h.proposal, proposalId: 'p-2' }, 'p-2')).toBe(true);
        expect(h.instance.isActive()).toBe(false);

        await h.instance.toggle('p-1');
        expect(h.instance.reconcile({ ...h.proposal, applied: false }, 'p-1')).toBe(true);
        expect(h.instance.isActive()).toBe(false);
        expect(h.sessions.map(s => s.disposed)).toEqual([1, 1]);
    });
});

describe('owner focus (what one owner puts in, and what stands on it now)', () => {
    const withRights = () => ({
        approvalConfig: { rights: { parcels: [
            { parcelId: 'A', owners: [{ ownerId: 'owner-a', share: '1/1' }] },
            { parcelId: 'C', owners: [{ ownerId: 'owner-c', share: '1/2' }, { ownerId: 'owner-d', share: '1/2' }] }
        ] } }
    });

    it('takes the parcels from the rights snapshot', () => {
        expect(BeforeAfter.ownerFocusParts(withRights(), 'owner-d')).toEqual({ parcelIds: ['C'] });
        expect(BeforeAfter.ownerFocusParts(withRights(), 'owner-a')).toEqual({ parcelIds: ['A'] });
        expect(BeforeAfter.ownerFocusParts(withRights(), 'nobody')).toEqual({ parcelIds: [] });
        expect(BeforeAfter.ownerFocusParts(null, 'owner-a')).toEqual({ parcelIds: [] });
    });

    it('finds no owner on a parcel layout: the layout names none', () => {
        const layout = { goal: 'parcel-layout', parcelLayout: { pool: square(16, 45.8), plots: [{ geometry: square(16, 45.8), source: 'manual' }] } };
        expect(BeforeAfter.ownerFocusParts(layout, 'owner-a')).toEqual({ parcelIds: [] });
    });

    it('outlines several parcels on the before side', () => {
        const layers = BeforeAfter.beforeLayers({
            affectedIds: ['A', 'C'], originals: [feature('A'), feature('C'), feature('D')], presented: [],
            focusParcelIds: ['A', 'C'], idOfFeature: f => f.properties.parcelId
        });
        expect(layers.focus.map(f => f.properties.parcelId)).toEqual(['A', 'C']);
    });

    it('frames the owner\'s land clear of the panel and starts the divider through it', async () => {
        const h = harness({ originals: [feature('A'), feature('C', square(16.002, 45.8))] });
        Object.assign(h.proposal, withRights(), { cadastreParcelIds: ['A', 'C'] });
        const fits = [];
        Object.assign(h.deps.map, {
            fitBounds: (bounds, options) => fits.push({ bounds, options }),
            getSize: () => ({ x: 1000, y: 800 }),
            // A projection where longitude 16.0 is x=200 and each 0.001° is 100 px.
            latLngToContainerPoint: ([, lng]) => ({ x: 200 + (lng - 16) * 100000, y: 400 })
        });
        h.deps.fitPadding = () => ({ paddingTopLeft: [40, 40], paddingBottomRight: [520, 40] });
        await h.instance.toggle('p-1', { focusOwnerId: 'owner-c' });
        // Owner C's old parcel C sits in [16.002, 16.003]; nothing else stands on it.
        expect(fits).toHaveLength(1);
        fits[0].bounds.flat().forEach((value, i) => expect(value).toBeCloseTo([45.8, 16.002, 45.801, 16.003][i], 9));
        expect(fits[0].options).toMatchObject({ paddingBottomRight: [520, 40], animate: false });
        expect(h.sessions[0].options.percent).toBeCloseTo(45, 6);
    });

    it('leaves the view alone for a plain comparison', async () => {
        const h = harness();
        const fitBounds = vi.fn();
        h.deps.map.fitBounds = fitBounds;
        await h.instance.toggle('p-1');
        expect(fitBounds).not.toHaveBeenCalled();
        expect(h.sessions[0].options.percent).toBeUndefined();
    });

    it('focusBounds spans every coordinate and ignores features without geometry', () => {
        BeforeAfter.focusBounds([feature('A', square(16, 45.8)), { type: 'Feature', geometry: null }, feature('B', square(16.004, 45.802))])
            .flat().forEach((value, i) => expect(value).toBeCloseTo([45.8, 16, 45.803, 16.005][i], 9));
        expect(BeforeAfter.focusBounds([])).toBeNull();
    });

    it('opens for one owner: their parcels before, the live pieces on them after, and toggles by owner', async () => {
        const h = harness({ originals: [feature('A'), feature('C')] });
        Object.assign(h.proposal, withRights(), { cadastreParcelIds: ['A', 'C'] });
        expect(await h.instance.toggle('p-1', { focusOwnerId: 'owner-a' })).toBe(true);
        expect(h.instance.activeFocus()).toBe('owner:owner-a');
        const onHost = h.drawn.filter(d => d.target === h.deps.map);
        expect(onHost).toHaveLength(1);
        expect(onHost[0].collection.features.map(f => f.properties.parcelId)).toEqual(['A:plot-1', 'A:plot-2']);
        expect(onHost[0].options.style()).toEqual(BeforeAfter.FOCUS_AFTER_STYLE);
        const focusBefore = h.drawn.filter(d => d.target === 'before-map').pop();
        expect(focusBefore.collection.features.map(f => f.properties.parcelId)).toEqual(['A']);
        await h.instance.toggle('p-1', { focusOwnerId: 'owner-c' });
        expect(h.instance.activeFocus()).toBe('owner:owner-c');
        await h.instance.toggle('p-1', { focusOwnerId: 'owner-c' });
        expect(h.instance.isActive()).toBe(false);
    });
});

describe('agreement comparison (plan-design-agreement.md, M1 b)', () => {
    const stored = (overrides = {}) => ({
        id: 'ag-1',
        designs: [{ proposalId: 'p-1' }, { proposalId: 'p-2' }],
        inputs: { parcels: [{ parcelId: 'A' }, { parcelId: 'B' }, { parcelId: 'A' }], openGroundM2: 0 },
        ...overrides
    });
    // The single-proposal harness, with the agreement's designs held by this browser and the
    // stored agreement it reads by id.
    function agreementHarness({ applied = { 'p-1': true, 'p-2': true }, agreement = stored() } = {}) {
        const h = harness({ originals: [feature('A', square(16, 45.8, 0.002)), feature('B', square(16.002, 45.8))] });
        h.deps.recordOf = id => (Object.prototype.hasOwnProperty.call(applied, id) ? { proposalId: id, applied: applied[id] } : null);
        h.deps.findAgreement = vi.fn(id => (agreement && id === agreement.id ? agreement : null));
        return h;
    }

    it('takes its input parcels as the affected land: every piece standing on them gives way to the original', async () => {
        const h = agreementHarness();
        h.deps.map.fitBounds = vi.fn();
        h.deps.map.getSize = () => ({ x: 1000, y: 800 });
        h.deps.map.latLngToContainerPoint = () => ({ x: 300, y: 400 });
        h.deps.fitPadding = () => ({ paddingTopLeft: [40, 40], paddingBottomRight: [420, 40] });
        expect(await h.instance.toggleAgreement('ag-1')).toBe(true);
        expect(h.deps.findAgreement).toHaveBeenCalledWith('ag-1');
        expect(h.instance.activeKey()).toBe(BeforeAfter.agreementKey('ag-1'));
        expect(h.instance.isActive('agreement:ag-1')).toBe(true);
        expect(h.instance.isActive('ag-1')).toBe(false);
        expect(h.repository.ensureIds).toHaveBeenCalledWith(['A', 'B'], { retainOnly: true });
        // A:plot-1 (on A) and B are both input land: the before map holds the two originals only.
        const before = h.drawn.find(layer => layer.target === 'before-map');
        expect(before.collection.features.map(f => f.properties.parcelId)).toEqual(['A', 'B']);
        expect(h.deps.map.fitBounds).toHaveBeenCalledWith([[45.8, 16], [45.802, 16.003]], {
            paddingTopLeft: [40, 40], paddingBottomRight: [420, 40], maxZoom: 20, animate: false
        });
        expect(h.sessions[0].options.percent).toBe(30);
        expect(h.changes).toEqual([true]);

        expect(await h.instance.toggleAgreement('ag-1')).toBe(false);
        expect(h.instance.isActive()).toBe(false);
        expect(h.sessions[0].disposed).toBe(1);
    });

    it('refuses while a design is unapplied or gone, without land, or when the agreement is not stored', async () => {
        const unapplied = agreementHarness({ applied: { 'p-1': true, 'p-2': false } });
        expect(await unapplied.instance.toggleAgreement('ag-1')).toBe(false);
        expect(unapplied.sessions).toHaveLength(0);
        expect(unapplied.repository.ensureIds).not.toHaveBeenCalled();

        const gone = agreementHarness({ applied: { 'p-1': true } });
        expect(await gone.instance.toggleAgreement('ag-1')).toBe(false);

        const landless = agreementHarness({ agreement: stored({ inputs: { parcels: [], openGroundM2: 40 } }) });
        expect(await landless.instance.toggleAgreement('ag-1')).toBe(false);

        const missing = agreementHarness();
        expect(await missing.instance.toggleAgreement('ag-2')).toBe(false);
        expect(await missing.instance.toggleAgreement('')).toBe(false);
        expect(missing.sessions).toHaveLength(0);
    });

    it('replaces a proposal comparison, and ends when the details panel shows a proposal', async () => {
        const h = agreementHarness();
        await h.instance.toggle('p-1');
        expect(h.instance.isActive('p-1')).toBe(true);
        expect(await h.instance.toggleAgreement('ag-1')).toBe(true);
        expect(h.instance.isActive('agreement:ag-1')).toBe(true);
        expect(h.sessions.map(s => s.disposed)).toEqual([1, 0]);
        expect(h.instance.reconcile(h.proposal, 'p-1')).toBe(true);
        expect(h.instance.isActive()).toBe(false);
    });

    it('canCompareAgreement needs designs, land and every design applied', () => {
        const deps = { isApplied, recordOf: id => ({ proposalId: id, applied: id !== 'p-off' }) };
        expect(BeforeAfter.canCompareAgreement(stored(), deps)).toBe(true);
        expect(BeforeAfter.canCompareAgreement(stored({ designs: [{ proposalId: 'p-1' }, { proposalId: 'p-off' }] }), deps)).toBe(false);
        expect(BeforeAfter.canCompareAgreement(stored({ designs: [] }), deps)).toBe(false);
        expect(BeforeAfter.canCompareAgreement(stored(), { isApplied })).toBe(false);
        expect(BeforeAfter.canCompareAgreement(null, deps)).toBe(false);
        expect(BeforeAfter.agreementInputIds(stored())).toEqual(['A', 'B']);
        expect(BeforeAfter.agreementKey('ag-1')).toBe('agreement:ag-1');
        expect(BeforeAfter.agreementKey(null)).toBe('');
    });
});
