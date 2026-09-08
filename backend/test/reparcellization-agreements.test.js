// Purpose: verify independent reparcellization agreement construction and resumable persistence/application.
import { describe, expect, it } from 'vitest';
import * as turf from '@turf/turf';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const planUtils = require('../../frontend/js/reparcellization-plan-utils.js');
const agreements = require('../../frontend/js/reparcellization-agreements.js');
const square = (x1, y1, x2, y2) => turf.polygon([[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]]);
const feature = geometry => turf.feature(geometry);
const clone = value => JSON.parse(JSON.stringify(value));

function fixture() {
    const first = square(0, 0, 4, 10);
    const second = square(4, 0, 10, 10);
    const courtyard = square(3, 4, 6, 6);
    const inputs = [
        { parcelId: 'p1', label: 'A', geometry: first.geometry, owners: [{ ownerKey: 'a', displayName: 'Owner A', share: 1 }] },
        { parcelId: 'p2', label: 'B', geometry: second.geometry, owners: [{ ownerKey: 'b', displayName: 'Owner B', share: 1 }] }
    ];
    const polygons = [
        { geometry: turf.difference(first, courtyard).geometry, owners: inputs[0].owners },
        { geometry: turf.difference(second, courtyard).geometry, owners: inputs[1].owners },
        { geometry: courtyard.geometry, owners: [{ ownerKey: 'a', share: 0.4 }, { ownerKey: 'b', share: 0.6 }], jointPool: true }
    ];
    const plan = { inputParcels: inputs, polygons };
    const parts = planUtils.splitPlanPerParcel(plan, turf);
    const proposal = {
        proposalId: 'preview-1', title: 'Block plan', name: 'Block plan', offer: 1000, budget: 1000,
        sourceProposalId: 'source-1', replacementOfProposalId: 'source-1', createdAt: '2026-01-01T00:00:00Z',
        reparcellization: { contributionBasis: 'area', poolUnitValue: 2, ownerShares: [
            { ownerKey: 'a', contributedArea: 40, cashOffer: 400 }, { ownerKey: 'b', contributedArea: 60, cashOffer: 600 }
        ] }
    };
    const cadastralParcels = inputs.map(input => ({ id: input.parcelId, feature: feature(input.geometry) }));
    return { inputs, plan, parts, proposal, cadastralParcels };
}

function memoryStorage({ failAdds = new Set(), failAfterInsert = new Set() } = {}) {
    const records = new Map();
    let calls = 0;
    return {
        records,
        addProposal(record) {
            calls += 1;
            const index = calls;
            if (failAdds.has(index)) throw new Error(`save-${index}`);
            const id = `agreement-${index}`;
            records.set(id, { ...clone(record), proposalId: id });
            if (failAfterInsert.has(index)) throw new Error(`receipt-${index}`);
            return id;
        },
        getProposal(id) { return records.get(String(id)) || null; },
        getAllProposals() { return [...records.values()]; }
    };
}

describe('reparcellization agreements', () => {
    it('builds one anchored agreement per original parcel and conserves data', () => {
        const f = fixture();
        const original = clone(f.proposal);
        const batch = agreements.buildBatch({ proposal: f.proposal, parts: f.parts, cadastralParcels: f.cadastralParcels,
            groupId: 'group-1', titleForParcel: (name, parcel) => `${name} — parcel ${parcel}` }, turf);
        expect(batch.items).toHaveLength(2);
        expect(batch.items.map(item => item.record.cadastreParcelIds)).toEqual([['p1'], ['p2']]);
        expect(batch.items.every(item => !('parentParcelIds' in item.record) && !('parcelIds' in item.record.reparcellization))).toBe(true);
        expect(batch.items.map(item => item.record.title)).toEqual(['Block plan — parcel A', 'Block plan — parcel B']);
        expect(batch.items.reduce((sum, item) => sum + item.record.offer, 0)).toBe(1000);
        expect(batch.items.reduce((sum, item) => sum + item.record.budget, 0)).toBe(1000);
        expect(batch.items[0].record.reparcellization.polygons.some(plot => plot.jointPool)).toBe(true);
        expect(f.proposal).toEqual(original);
        expect(batch.items.every(item => item.record.sourceProposalId === 'source-1' && item.record.replacementOfProposalId === 'source-1')).toBe(true);
        const total = batch.items.flatMap(item => item.record.reparcellization.polygons)
            .reduce((sum, plot) => sum + plot.area, 0);
        expect(total).toBeCloseTo(f.inputs.reduce((sum, p) => sum + turf.area(feature(p.geometry)), 0), 3);
    });

    it('persists every item before applying and keeps the preview on partial save failure', async () => {
        const f = fixture();
        const batch = agreements.buildBatch({ proposal: f.proposal, parts: f.parts, cadastralParcels: f.cadastralParcels,
            groupId: 'group-save', titleForParcel: (name, parcel) => `${name} — parcel ${parcel}` }, turf);
        const storage = memoryStorage({ failAdds: new Set([2]) });
        const applied = [];
        const result = await agreements.resumeBatch(batch, {
            storage, persistBatch: async value => { value.persisted = true; },
            isApplied: record => !!record?.applied, apply: async id => { applied.push(id); storage.records.get(id).applied = true; return true; }
        });
        expect(result.complete).toBe(false);
        expect(applied).toEqual([]);
        expect(result.created).toBe(1);
    });

    it('recovers persisted records on retry, skips duplicates, and completes only after apply', async () => {
        const f = fixture();
        const batch = agreements.buildBatch({ proposal: f.proposal, parts: f.parts, cadastralParcels: f.cadastralParcels,
            groupId: 'group-retry', titleForParcel: (name, parcel) => `${name} — parcel ${parcel}` }, turf);
        const storage = memoryStorage({ failAfterInsert: new Set([1]) });
        let applyCalls = 0;
        const deps = {
            storage, persistBatch: async () => {}, isApplied: record => !!record?.applied,
            apply: async id => { applyCalls += 1; storage.records.get(id).applied = true; return true; }
        };
        const first = await agreements.resumeBatch(batch, deps);
        expect(first.complete).toBe(false);
        const ids = [...storage.records.keys()];
        const retry = await agreements.resumeBatch(first.batch, deps);
        expect(retry.complete).toBe(true);
        expect(storage.getAllProposals()).toHaveLength(2);
        expect(applyCalls).toBe(2);
        expect(ids.every(id => storage.getProposal(id))).toBe(true);
    });

    it('remains incomplete when apply fails for all, then retries only unapplied artifacts', async () => {
        const f = fixture();
        const batch = agreements.buildBatch({ proposal: f.proposal, parts: f.parts, cadastralParcels: f.cadastralParcels,
            groupId: 'group-apply', titleForParcel: (name, parcel) => `${name} — parcel ${parcel}` }, turf);
        const storage = memoryStorage();
        let fail = true;
        let calls = 0;
        const deps = { storage, persistBatch: async () => {}, isApplied: record => !!record?.applied,
            apply: async id => { calls += 1; if (fail) return false; storage.records.get(id).applied = true; return true; } };
        const first = await agreements.resumeBatch(batch, deps);
        expect(first.complete).toBe(false);
        expect(first.created).toBe(2);
        expect(first.applied).toBe(0);
        fail = false;
        const retry = await agreements.resumeBatch(first.batch, deps);
        expect(retry.complete).toBe(true);
        expect(retry.applied).toBe(2);
        expect(calls).toBe(4);
    });

    it('keeps the batch incomplete when a later apply displaces an earlier sibling, then recovers it', async () => {
        const f = fixture();
        const batch = agreements.buildBatch({ proposal: f.proposal, parts: f.parts, cadastralParcels: f.cadastralParcels,
            groupId: 'group-displace', titleForParcel: (name, parcel) => `${name} — parcel ${parcel}` }, turf);
        const storage = memoryStorage();
        let firstRun = true;
        const deps = { storage, persistBatch: async () => {}, isApplied: record => !!record?.applied,
            apply: async id => {
                const record = storage.records.get(id);
                if (firstRun && record.reparcellizationAgreement.index === 1) {
                    for (const other of storage.records.values()) other.applied = false;
                }
                record.applied = true;
                return true;
            } };
        const first = await agreements.resumeBatch(batch, deps);
        expect(first.complete).toBe(false);
        expect(first.created).toBe(2);
        expect(first.applied).toBe(1);
        firstRun = false;
        const retry = await agreements.resumeBatch(first.batch, deps);
        expect(retry.complete).toBe(true);
        expect(retry.applied).toBe(2);
    });
});
