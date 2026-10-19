// Binding drift (PARCEL-OPTIONAL.md rule 5): the pure comparison and notice model shared with the
// details panel, the derived record a re-bind publishes (the source is never edited), and
// GET /proposals/:id/binding-drift recomputing a stored site at the stored tolerance against a
// scripted cadastre — a read that writes nothing.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { BINDING_COUNT_SQL, BINDING_SQL, PARCEL_ACT_SITE_SQL, INTRUSION_NOISE_M } from '../proposals/binding.js';
import { BINDING_DRIFT_ROW_SQL, computeBindingDrift } from '../proposals/binding-drift.js';
import { setupProposalBindingRoute, BINDING_DRIFT_PATH } from '../routes/proposal-binding.js';

const require = createRequire(import.meta.url);
const drift = require('../../frontend/js/proposals/binding-drift.js');

const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const SITE = { type: 'MultiPolygon', coordinates: [box(15.969, 45.799, 15.972, 45.802).coordinates] };
const entry = (parcelId, overlapM2 = 100, intrusionM = 5) => ({ parcelId, overlapM2, intrusionM });
const binding = (parcels, extra = {}) => ({
    parcels, touched: [], toleranceM: 0, coverage: 'complete', unsurveyedM2: 0, unknownM2: 0,
    siteM2: 9000, source: 'server:hr-cadastre', computedAt: '2026-09-01T00:00:00.000Z', ...extra
});
const STORED = binding([entry('HR-1-10'), entry('HR-1-11/1')]);

describe('bindingDrift (pure)', () => {
    it('is null when the same parcels are bound with the same coverage', () => {
        const current = binding([entry('HR-1-11/1', 99), entry('HR-1-10', 101)], { computedAt: '2026-10-01T00:00:00.000Z' });
        expect(drift.bindingDrift(STORED, current)).toBeNull();
        // Open ground moving by less than a square metre is arithmetic, not a cadastre change.
        expect(drift.bindingDrift(binding([], { coverage: 'partial', unsurveyedM2: 500 }),
            binding([], { coverage: 'partial', unsurveyedM2: 500.6 }))).toBeNull();
    });

    it('names the parcels a split added and removed, sorted', () => {
        const current = binding([entry('HR-1-10'), entry('HR-1-11/3', 40, 2), entry('HR-1-11/2', 60, 3)]);
        const result = drift.bindingDrift(STORED, current);
        expect(result.added.map(hit => hit.parcelId)).toEqual(['HR-1-11/2', 'HR-1-11/3']);
        expect(result.removed).toEqual([entry('HR-1-11/1')]);
        expect(result.coverageChanged).toBe(false);
    });

    it('reports a coverage change: open ground surveyed into a new parcel', () => {
        const stored = binding([entry('HR-1-10')], { coverage: 'partial', unsurveyedM2: 1200 });
        const current = binding([entry('HR-1-10'), entry('HR-1-99')], { coverage: 'complete', unsurveyedM2: 0 });
        const result = drift.bindingDrift(stored, current);
        expect(result).toMatchObject({ coverageChanged: true, coverage: { from: 'partial', to: 'complete' }, openGroundM2: { from: 1200, to: 0 } });
        expect(result.added.map(hit => hit.parcelId)).toEqual(['HR-1-99']);
        // Same class, open ground grew: still a coverage change.
        expect(drift.bindingDrift(binding([], { coverage: 'partial', unsurveyedM2: 10 }),
            binding([], { coverage: 'partial', unsurveyedM2: 30 })).coverageChanged).toBe(true);
    });
});

describe('driftNotice (pure)', () => {
    const response = { checkable: true, stored: STORED, current: binding([entry('HR-1-10')]), drift: drift.bindingDrift(STORED, binding([entry('HR-1-10')])) };

    it('counts the change and offers a re-bind', () => {
        expect(drift.driftNotice(response)).toMatchObject({
            addedCount: 0, removedCount: 1, removedIds: ['HR-1-11/1'], coverageChanged: false,
            storedAt: '2026-09-01T00:00:00.000Z', canRebind: true, reboundAs: null
        });
    });

    it('says nothing without drift or when the record cannot be checked', () => {
        expect(drift.driftNotice({ ...response, drift: null })).toBeNull();
        expect(drift.driftNotice({ checkable: false, reason: 'unknown-coverage' })).toBeNull();
        expect(drift.driftNotice(null)).toBeNull();
    });

    it('points at the derived record instead of offering a second re-bind', () => {
        const notice = drift.driftNotice(response, { reboundAs: { proposalId: 'p-new', serverProposalId: '77', title: 'Park' } });
        expect(notice.canRebind).toBe(false);
        expect(notice.reboundAs).toEqual({ proposalId: 'p-new', serverProposalId: '77', title: 'Park' });
    });
});

describe('deriveReboundRecord (pure)', () => {
    const source = {
        proposalId: 'p-park', id: 'p-park', serverProposalId: '41', title: 'Park', goal: 'park',
        applied: true, appliedAt: 'x', lifecycleStatus: 'Active', createdAt: '2026-09-01T00:00:00.000Z',
        cadastreParcelIds: ['HR-1-10', 'HR-1-11/1'], acceptedParcelIds: ['HR-1-10'], ownerAcceptances: { 'HR-1-10': {} },
        onchainData: { mint: 'abc' }, tokenId: 'abc', isMinted: true, effectHash: 'e', ownershipFlow: [{}],
        site: SITE, binding: STORED, offer: 1000,
        structureProposal: { geometry: box(15.97, 45.80, 15.971, 45.801), applied: true, childParcelIds: ['x-1'] },
        childParcelIds: ['x-1'], sourceProposalId: 'older'
    };
    const current = binding([entry('HR-1-10'), entry('HR-1-11/2'), entry('HR-1-11/3')], { computedAt: '2026-10-01T00:00:00.000Z' });
    const response = { checkable: true, stored: STORED, current, drift: drift.bindingDrift(STORED, current) };

    it('carries the site and design with the current binding and a link to its source', () => {
        const before = JSON.stringify(source);
        const derived = drift.deriveReboundRecord(source, response);
        expect(JSON.stringify(source)).toBe(before); // the source is never edited
        expect(derived.site).toEqual(SITE);
        expect(derived.structureProposal.geometry).toEqual(source.structureProposal.geometry);
        expect(derived.offer).toBe(1000);
        expect(derived.binding).toEqual(current);
        expect(derived.cadastreParcelIds).toEqual(['HR-1-10', 'HR-1-11/2', 'HR-1-11/3']);
        expect(derived).toMatchObject({ sourceProposalId: 'p-park', replacementOfProposalId: 'p-park', copiedFromName: 'Park' });
        expect(derived.rebind).toMatchObject({
            sourceProposalId: 'p-park', sourceServerId: '41', storedComputedAt: '2026-09-01T00:00:00.000Z',
            currentComputedAt: '2026-10-01T00:00:00.000Z', added: ['HR-1-11/2', 'HR-1-11/3'], removed: ['HR-1-11/1']
        });
    });

    it('drops the source record\'s identity, consent, chain and local state', () => {
        const derived = drift.deriveReboundRecord(source, response);
        ['proposalId', 'id', 'serverProposalId', 'applied', 'appliedAt', 'lifecycleStatus', 'createdAt',
            'acceptedParcelIds', 'ownerAcceptances', 'onchainData', 'tokenId', 'isMinted', 'effectHash',
            'ownershipFlow', 'childParcelIds'].forEach(key => expect(derived, key).not.toHaveProperty(key));
        expect(derived.structureProposal).not.toHaveProperty('applied');
        expect(derived.structureProposal).not.toHaveProperty('childParcelIds');
    });

    it('keys the derived content by the new binding, and refuses without a current binding', () => {
        const again = drift.deriveReboundRecord(source, response);
        expect(again.rebind.bindingKey).toBe(drift.deriveReboundRecord(source, response).rebind.bindingKey);
        const other = drift.deriveReboundRecord(source, { ...response, current: binding([entry('HR-1-10')]) });
        expect(other.rebind.bindingKey).not.toBe(again.rebind.bindingKey);
        expect(() => drift.deriveReboundRecord(source, { checkable: true, stored: STORED })).toThrow(/current binding/);
        expect(() => drift.deriveReboundRecord({ title: 'x' }, response)).toThrow(/no id/);
    });

    it('finds a local record re-bound from a published one', () => {
        const derived = { proposalId: 'p-new', ...drift.deriveReboundRecord(source, response) };
        expect(drift.findRebound([{ proposalId: 'x' }, derived], { serverId: '41' })).toBe(derived);
        expect(drift.findRebound([derived], { proposalId: 'p-park' })).toBe(derived);
        expect(drift.findRebound([derived], { serverId: '42' })).toBeNull();
    });
});

// A scripted database: one proposal row plus the binding statements.
function scriptedDb({ row, parcels = [], inRegion = true, unsurveyedM2 = 0, found = null } = {}) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql === BINDING_DRIFT_ROW_SQL) return { rows: row && (params[0] === row.proposal_id || params[0] === String(row.id)) ? [row] : [] };
            if (sql === BINDING_COUNT_SQL) return { rows: [{ parcels: parcels.length }] };
            if (sql === BINDING_SQL) {
                return { rows: [{ parcels, site_m2: 9000, in_region: inRegion, unsurveyed_m2: unsurveyedM2, unknown_m2: 0, site_geojson: JSON.stringify(SITE) }] };
            }
            if (sql === PARCEL_ACT_SITE_SQL) {
                const ids = JSON.parse(params[0]).map(hit => hit.id).filter(id => !found || found.includes(id));
                return { rows: [{ parcels: ids.map(id => ({ parcelId: id, overlapM2: 400 })), site_geojson: ids.length ? JSON.stringify(SITE) : null, site_m2: 400 * ids.length }] };
            }
            throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
        }
    };
}
const bound = (parcelId, intrusionM = 5) => ({ parcelId, overlapM2: 100, intrusionM, bound: true });
const ROW = { id: 41, proposal_id: 'c2-park', city: 'zagreb', binding: { ...STORED, toleranceM: 0.05 }, site_geojson: JSON.stringify(SITE), data_site: null };

describe('computeBindingDrift (server)', () => {
    it('recomputes the stored site at the stored tolerance and reports the split', async () => {
        const db = scriptedDb({ row: ROW, parcels: [bound('HR-1-10'), bound('HR-1-11/2'), bound('HR-1-11/3')] });
        const result = await computeBindingDrift(db, '41');
        expect(result).toMatchObject({ id: '41', proposalId: 'c2-park', checkable: true });
        expect(result.stored).toEqual(ROW.binding);
        expect(result.current.parcels.map(hit => hit.parcelId)).toEqual(['HR-1-10', 'HR-1-11/2', 'HR-1-11/3']);
        expect(result.current.toleranceM).toBe(0.05);
        expect(result.drift.added.map(hit => hit.parcelId)).toEqual(['HR-1-11/2', 'HR-1-11/3']);
        expect(result.drift.removed.map(hit => hit.parcelId)).toEqual(['HR-1-11/1']);
        const bindingCall = db.calls.find(call => call.sql === BINDING_SQL);
        expect(JSON.parse(bindingCall.params[0])).toEqual([SITE]); // the STORED site
        expect(bindingCall.params[2]).toBe(Math.max(0.05, INTRUSION_NOISE_M)); // the stored tolerance
    });

    it('answers no drift for an unchanged cadastre, and reads the site from proposal_data when the column is empty', async () => {
        const row = { ...ROW, binding: STORED, site_geojson: null, data_site: SITE };
        const result = await computeBindingDrift(scriptedDb({ row, parcels: [bound('HR-1-10'), bound('HR-1-11/1')] }), 'c2-park');
        expect(result.checkable).toBe(true);
        expect(result.drift).toBeNull();
    });

    it('re-checks a parcel act by its named parcels: a parcel that is gone is removed', async () => {
        const row = { ...ROW, site_geojson: null, binding: { ...STORED, subject: 'declared-parcels' } };
        const result = await computeBindingDrift(scriptedDb({ row, found: ['HR-1-10'] }), '41');
        expect(result.drift.removed.map(hit => hit.parcelId)).toEqual(['HR-1-11/1']);
        expect(result.drift.added).toEqual([]);
    });

    it('cannot check a record without a binding, without a site, or outside the held cadastre', async () => {
        expect(await computeBindingDrift(scriptedDb({ row: { ...ROW, binding: null } }), '41'))
            .toMatchObject({ checkable: false, reason: 'no-binding' });
        expect(await computeBindingDrift(scriptedDb({ row: { ...ROW, site_geojson: null } }), '41'))
            .toMatchObject({ checkable: false, reason: 'no-site' });
        expect(await computeBindingDrift(scriptedDb({ row: ROW, inRegion: false }), '41'))
            .toMatchObject({ checkable: false, reason: 'unknown-coverage' });
        expect(await computeBindingDrift(scriptedDb({ row: ROW }), 'nope')).toBeNull();
    });
});

describe('GET /proposals/:id/binding-drift', () => {
    const app = db => {
        const server = express();
        server.use(express.json());
        setupProposalBindingRoute(server, db);
        return server;
    };

    it('answers stored, current and drift, and writes nothing', async () => {
        const db = scriptedDb({ row: ROW, parcels: [bound('HR-1-10')] });
        const res = await request(app(db)).get('/proposals/41/binding-drift');
        expect(res.status).toBe(200);
        expect(res.body.drift.removed.map(hit => hit.parcelId)).toEqual(['HR-1-11/1']);
        expect(res.body.stored.computedAt).toBe('2026-09-01T00:00:00.000Z');
        expect(typeof res.body.queryMs).toBe('number');
        expect(db.calls.some(call => /\b(INSERT|UPDATE|DELETE)\b/i.test(call.sql))).toBe(false);
    });

    it('answers 404 for an unknown record and 500 when the cadastre query fails', async () => {
        expect((await request(app(scriptedDb({ row: ROW }))).get('/proposals/999/binding-drift')).status).toBe(404);
        const broken = { query: async () => { throw new Error('db down'); } };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await request(app(broken)).get('/proposals/41/binding-drift');
        error.mockRestore();
        expect(res.status).toBe(500);
        expect(res.body.drift).toBeUndefined();
    });

    it('is limited with the binding reads (path pattern used by index.js)', () => {
        expect(BINDING_DRIFT_PATH.test('/proposals/41/binding-drift')).toBe(true);
        expect(BINDING_DRIFT_PATH.test('/proposals/41')).toBe(false);
        expect(BINDING_DRIFT_PATH.test('/proposals/a/b/binding-drift')).toBe(false);
    });
});
