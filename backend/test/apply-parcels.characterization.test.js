// Characterization of _applyReparcellizationProposal's canonical replay semantics: authored plots
// stamp flat cadastral anchors and derive deterministic child identities. Stored prior children are
// never an input.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const { _applyReparcellizationProposal } = require('../../frontend/js/proposals/apply/parcels.js');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');
require('../../frontend/js/proposal-parcel-identity.js'); // installs _getParcelIdFromFeature etc. on globalThis
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');

const GLOBAL_KEYS = [
    '_normalizeProposalId', 'updateStatus', 'turf', 'window',
    '_resolveRootParcelIdFromProperties', '_resolveRootParcelNumberFromProperties',
    '_calculateGeoJsonArea',
    'persistAppliedProposal', 'refreshProposalUIAfterApply'
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
    globalThis.window = { __formationEdit: formationEdit };
    globalThis._resolveRootParcelIdFromProperties = (props, explicit) =>
        (props && props.cadastreParcelIds && props.cadastreParcelIds[0])
        || (props && props.rootParcelId) || explicit || null;
    globalThis._resolveRootParcelNumberFromProperties = (props) => (props && props.rootParcelNumber) || null;
    globalThis._calculateGeoJsonArea = geometry => {
        try { return turf.area({ type: 'Feature', properties: {}, geometry }); } catch (_) { return 0; }
    };
    globalThis.persistAppliedProposal = spy();
    globalThis.refreshProposalUIAfterApply = spy();
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
        _setDescendantProposalOnParcels: spy(),
        _linkProposalToAncestors: spy(),
        _consumeFeaturesFromLiveFabric(features) { this.hidden.push(...(features || [])); },
        _markParcelsModifiedBatch: spy(),
        _addChildParcels: spy(),
        _adoptForeignPlotPieces: spy(),
        _applyReparcellizationProposal
    };
}

// The plan: plot 1 = west half of HR-A (unchanged), plot 2 = east HR-A + all HR-B (spans both).
function planPolygons() {
    return [
        { geometry: rect(0, 0, 1, 2), ownerKey: null, displayName: 'One' },
        { geometry: rect(1, 0, 4, 2), ownerKey: null, displayName: 'Two' }
    ];
}

function proposalData(priorless) {
    return {
        cadastreParcelIds: ['HR-A', 'HR-B'],
        reparcellization: { polygons: planPolygons() },
        ...(priorless ? {} : {})
    };
}

describe('_applyReparcellizationProposal — flat anchors', () => {
    it('stamps per-plot cadastral provenance from the ground actually under each plot', async () => {
        const manager = makeManager();
        const data = proposalData();
        const ok = await manager._applyReparcellizationProposal('p-rep', data, {});
        expect(ok).toBe(true);

        const [plot1, plot2] = manager.added;
        expect(plot1.properties.cadastreParcelIds).toEqual(['HR-A']);
        expect(plot2.properties.cadastreParcelIds).toEqual(['HR-A', 'HR-B']);
        expect(data.cadastreParcelIds).toEqual(['HR-A', 'HR-B']);
        // Fresh apply mints 1..n in the disposable fabric, never on the authored record.
        expect(manager.added.map(feature => feature.properties.parcelId))
            .toEqual(['HR-A#p-rep-1', 'HR-A#p-rep-2']);
        expect(data).not.toHaveProperty('childParcelIds');
        expect(data.reparcellization).not.toHaveProperty('childParcelIds');
    });
});

describe('_applyReparcellizationProposal — deterministic derivation', () => {
    it('derives the same disposable ids on every replay without storing them', async () => {
        const firstManager = makeManager();
        const first = proposalData();
        await firstManager._applyReparcellizationProposal('p-rep', first, {});

        const secondManager = makeManager();
        const second = proposalData();
        await secondManager._applyReparcellizationProposal('p-rep', second, {});

        expect(firstManager.added.map(feature => feature.properties.parcelId))
            .toEqual(['HR-A#p-rep-1', 'HR-A#p-rep-2']);
        expect(secondManager.added.map(feature => feature.properties.parcelId))
            .toEqual(firstManager.added.map(feature => feature.properties.parcelId));
        expect(first).not.toHaveProperty('childParcelIds');
        expect(second).not.toHaveProperty('childParcelIds');
        expect(secondManager.added.map(feature => feature.geometry))
            .toEqual(firstManager.added.map(feature => feature.geometry));
    });
});
