// Characterization of _applyParcelLayoutProposal's canonical replay semantics: a geometry-only
// layout stamps flat cadastral anchors on its plots, returns uncovered ground as remainders and
// derives deterministic child identities. Stored prior children are never an input.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { _applyParcelLayoutProposal } = require('../../frontend/js/proposals/apply/parcels.js');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
require('../../frontend/js/proposal-parcel-identity.js'); // installs _getParcelIdFromFeature etc. on globalThis
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');
const contiguity = require('../../frontend/js/proposals/parcel-contiguity.js');
const layoutRecord = require('../../frontend/js/parcel-layout-record.js');
const authoredRecord = require('../../frontend/js/proposals/authored-record.js');

const GLOBAL_KEYS = [
    '_normalizeProposalId', 'updateStatus', 'turf', 'window',
    '_resolveRootParcelIdFromProperties', '_resolveRootParcelNumberFromProperties',
    '_calculateGeoJsonArea',
    'persistAppliedProposal', 'refreshProposalUIAfterApply', 'transferParcelOwnership'
];
const saved = {};

function spy(retval) {
    const fn = (...args) => { fn.calls.push(args); return typeof retval === 'function' ? retval(...args) : retval; };
    fn.calls = [];
    return fn;
}

// Axis-aligned rectangle near Zagreb; dx/dy in units of ~78 m / ~111 m.
function rect(dx0, dy0, dx1, dy1) {
    const LON = 15.96, LAT = 45.80;
    return {
        type: 'Polygon',
        coordinates: [[
            [LON + dx0 * 1e-3, LAT + dy0 * 1e-3], [LON + dx1 * 1e-3, LAT + dy0 * 1e-3],
            [LON + dx1 * 1e-3, LAT + dy1 * 1e-3], [LON + dx0 * 1e-3, LAT + dy1 * 1e-3],
            [LON + dx0 * 1e-3, LAT + dy0 * 1e-3]
        ]]
    };
}

beforeEach(() => {
    GLOBAL_KEYS.forEach(k => { saved[k] = globalThis[k]; });
    globalThis._normalizeProposalId = v => (v == null ? '' : String(v));
    globalThis.updateStatus = spy();
    globalThis.turf = turf;
    globalThis.window = { __formationEdit: formationEdit, __parcelContiguity: contiguity, turf };
    globalThis._resolveRootParcelIdFromProperties = (props, explicit) =>
        (props && props.cadastreParcelIds && props.cadastreParcelIds[0])
        || (props && props.rootParcelId) || explicit || null;
    globalThis._resolveRootParcelNumberFromProperties = (props) => (props && props.rootParcelNumber) || null;
    globalThis._calculateGeoJsonArea = geometry => {
        try { return turf.area({ type: 'Feature', properties: {}, geometry }); } catch (_) { return 0; }
    };
    globalThis.persistAppliedProposal = spy();
    globalThis.refreshProposalUIAfterApply = spy();
    globalThis.transferParcelOwnership = spy();
});

afterEach(() => {
    GLOBAL_KEYS.forEach(k => {
        if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k];
    });
});

// Two pooled base parcels side by side: HR-A covers x 0..2, HR-B covers x 2..4 (y 0..2).
function parentFeature(id, number, dx0, dx1) {
    return {
        type: 'Feature',
        geometry: rect(dx0, 0, dx1, 2),
        properties: {
            parcelId: id,
            BROJ_CESTICE: number,
            rootParcelId: id,
            rootParcelNumber: number,
            cadastreParcelIds: [id]
        }
    };
}

function makeManager() {
    const parents = [parentFeature('HR-A', 'A', 0, 2), parentFeature('HR-B', 'B', 2, 4)];
    return {
        parents,
        hidden: [],
        added: [],
        _setLastApplyFailure: spy(),
        _resolveLiveFormationParents: () => ({
            ok: true,
            ids: ['HR-A', 'HR-B'],
            cadastreIds: ['HR-A', 'HR-B'],
            features: parents
        }),
        _assignSyntheticChildIdentities(...args) { return ProposalManager._assignSyntheticChildIdentities(...args); },
        _addFeaturesToMap(features) { this.added.push(...features); },
        _markParcelProducedByProposal: spy(),
        _consumeFeaturesFromLiveFabric(features) { this.hidden.push(...(features || [])); },
        _applyParcelLayoutProposal
    };
}

// The layout: plot 1 = west half of HR-A, plot 2 = east HR-A + all HR-B (spans both). Geometry only.
function proposalData() {
    return {
        goal: 'parcel-layout',
        cadastreParcelIds: ['HR-A', 'HR-B'],
        parcelLayout: {
            algorithm: 'manual',
            pool: rect(0, 0, 4, 2),
            plots: [
                { geometry: rect(0, 0, 1, 2), source: 'manual' },
                { geometry: rect(1, 0, 4, 2), source: 'manual' }
            ]
        }
    };
}

const plotsOf = manager => manager.added.filter(feature => feature.properties.readjustmentPiece?.role === 'plot');
const remaindersOf = manager => manager.added.filter(feature => feature.properties.readjustmentPiece?.role === 'remainder');

describe('_applyParcelLayoutProposal — flat anchors', () => {
    it('stamps per-plot cadastral provenance from the ground actually under each plot', async () => {
        const manager = makeManager();
        const data = proposalData();
        const ok = await manager._applyParcelLayoutProposal('p-layout', data, {});
        expect(ok).toBe(true);

        const [plot1, plot2] = manager.added;
        expect(plot1.properties.cadastreParcelIds).toEqual(['HR-A']);
        expect(plot2.properties.cadastreParcelIds).toEqual(['HR-A', 'HR-B']);
        expect(data.cadastreParcelIds).toEqual(['HR-A', 'HR-B']);
        // Fresh apply mints 1..n in the disposable fabric, never on the authored record.
        expect(manager.added.map(feature => feature.properties.parcelId))
            .toEqual(['HR-A#p-layout-1', 'HR-A#p-layout-2']);
        expect(data).not.toHaveProperty('childParcelIds');
        expect(data.parcelLayout).not.toHaveProperty('childParcelIds');
        // Both parents are consumed: the plots tile the whole pool.
        expect(manager.hidden.map(feature => feature.properties.parcelId)).toEqual(['HR-A', 'HR-B']);
    });
});

describe('_applyParcelLayoutProposal — remainders', () => {
    it('returns parent ground outside the pool to its parcel as a remainder', async () => {
        const manager = makeManager();
        const data = proposalData();
        // The pool stops at x = 3: the east 25% of HR-B stays its parcel's.
        data.parcelLayout.pool = rect(0, 0, 3, 2);
        data.parcelLayout.plots[1].geometry = rect(1, 0, 3, 2);

        await expect(manager._applyParcelLayoutProposal('p-layout', data, {})).resolves.toBe(true);

        const remainders = remaindersOf(manager);
        expect(remainders).toHaveLength(1);
        expect(remainders[0].properties.producedByProposalId).toBe('p-layout');
        expect(remainders[0].properties.rootParcelId).toBe('HR-B');
        expect(turf.area(remainders[0])).toBeCloseTo(turf.area({
            type: 'Feature', properties: {}, geometry: rect(3, 0, 4, 2)
        }), 0);
    });
});

describe('_applyParcelLayoutProposal — geometry only', () => {
    it('validates the layout geometry and refuses one that leaves its pool uncovered, before any change', async () => {
        const manager = makeManager();
        const data = proposalData();
        data.parcelLayout.plots = data.parcelLayout.plots.slice(0, 1);

        await expect(manager._applyParcelLayoutProposal('p-layout', data, {}))
            .rejects.toMatchObject({ code: 'invalid-parcel-layout' });
        expect(manager._setLastApplyFailure.calls[0][1]).toMatchObject({ code: 'invalid-parcel-layout' });
        expect(manager.added).toHaveLength(0);
        expect(manager.hidden).toHaveLength(0);
        expect(globalThis.transferParcelOwnership.calls).toHaveLength(0);
    });

    it('forms plots that carry no authored owner, colour or share, whatever the record holds', async () => {
        const manager = makeManager();
        const data = proposalData();
        // Not part of the record contract; apply must not read any of it.
        Object.assign(data.parcelLayout.plots[0], {
            ownerKey: 'stray-owner', displayName: 'Stray', color: '#ff0000', percent: 1, jointPool: true,
            owners: [{ ownerKey: 'stray-owner', displayName: 'Stray', share: 1 }]
        });

        await expect(manager._applyParcelLayoutProposal('p-layout', data, {})).resolves.toBe(true);

        plotsOf(manager).forEach(feature => {
            ['ownerKey', 'displayName', 'color', 'percent', 'jointPool', 'ownershipDetails', 'owners']
                .forEach(key => expect(feature.properties).not.toHaveProperty(key));
        });
        // The plot's reference is its geometry: the stray fields do not move it.
        expect(plotsOf(manager)[0].properties.readjustmentPiece.plotFingerprint)
            .toBe(layoutRecord.plotFingerprint({ geometry: rect(0, 0, 1, 2) }));
        // With no parcel mutation context there is no owner record to read or write.
        expect(globalThis.transferParcelOwnership.calls).toHaveLength(0);
    });
});

describe('_applyParcelLayoutProposal — deterministic derivation', () => {
    it('keeps authored plot references when later corridors remove and split plots', async () => {
        const manager = makeManager();
        const data = proposalData();
        const authored = structuredClone(data.parcelLayout);
        // The carver has consumed the first plot and split the second into two connected pieces.
        manager._groundAfterLaterCorridors = () => ({
            corridorIds: ['later-road'],
            geometries: [null, { type: 'MultiPolygon', coordinates: [
                rect(1, 0, 2, 2).coordinates, rect(3, 0, 4, 2).coordinates
            ] }]
        });
        await expect(manager._applyParcelLayoutProposal('p-layout', data, {})).resolves.toBe(true);
        const plots = plotsOf(manager);
        const remainders = remaindersOf(manager);
        expect(plots).toHaveLength(2);
        plots.forEach(feature => expect(feature.properties.readjustmentPiece).toEqual({
            role: 'plot', plotFingerprint: layoutRecord.plotFingerprint(authored.plots[1])
        }));
        expect(new Set(plots.map(feature => feature.properties.parcelId)).size).toBe(2);
        expect(remainders.length).toBeGreaterThan(0);
        remainders.forEach(feature => expect(feature.properties.readjustmentPiece).toEqual({ role: 'remainder' }));
        expect(data.parcelLayout).toEqual(authored);
        // Selecting a live plot as new authored geometry must not persist its runtime relationship.
        expect(authoredRecord.cleanFeature(plots[0]).properties).not.toHaveProperty('readjustmentPiece');
        expect(plots[0].properties.readjustmentPiece.role).toBe('plot');
    });

    it('derives the same disposable ids on every replay without storing them', async () => {
        const firstManager = makeManager();
        const first = proposalData();
        await firstManager._applyParcelLayoutProposal('p-layout', first, {});

        const secondManager = makeManager();
        const second = proposalData();
        await secondManager._applyParcelLayoutProposal('p-layout', second, {});

        expect(firstManager.added.map(feature => feature.properties.parcelId))
            .toEqual(['HR-A#p-layout-1', 'HR-A#p-layout-2']);
        expect(secondManager.added.map(feature => feature.properties.parcelId))
            .toEqual(firstManager.added.map(feature => feature.properties.parcelId));
        expect(first).not.toHaveProperty('childParcelIds');
        expect(second).not.toHaveProperty('childParcelIds');
        expect(secondManager.added.map(feature => feature.geometry))
            .toEqual(firstManager.added.map(feature => feature.geometry));
    });

    it('refuses the layout when later roads take all of its plots', async () => {
        const manager = makeManager();
        manager._groundAfterLaterCorridors = () => ({ corridorIds: ['later-road'], geometries: [null, null] });
        await expect(manager._applyParcelLayoutProposal('p-layout', proposalData(), {})).resolves.toBe(false);
        expect(manager._setLastApplyFailure.calls[0][1]).toMatchObject({ code: 'readjustment-taken-by-corridors' });
        expect(manager.added).toHaveLength(0);
    });
});

describe('_applyParcelLayoutProposal — record shape', () => {
    it('fails without a parcelLayout, and the land-readjustment record is not read', async () => {
        const manager = makeManager();
        const legacy = { goal: 'parcel-layout', cadastreParcelIds: ['HR-A'], reparcellization: { polygons: [{ geometry: rect(0, 0, 2, 2) }] } };
        await expect(manager._applyParcelLayoutProposal('p-layout', legacy, {})).resolves.toBe(false);
        expect(manager._setLastApplyFailure.calls[0][1]).toMatchObject({ code: 'invalid-proposal' });
        expect(manager.added).toHaveLength(0);
    });
});
