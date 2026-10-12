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
