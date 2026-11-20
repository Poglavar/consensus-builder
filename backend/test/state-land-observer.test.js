// State land observer (oracle/state-land-observer.js): snapshot records, status-change events
// against the recorded history, the removal guard and the per-view failure verdict.
import { describe, expect, it } from 'vitest';
import {
    observeStateLand, outcomeOf, snapshotHash, snapshotRecords, stateLandCities, statusEvents, subjectId, viewSourceUrl
} from '../oracle/state-land-observer.js';

const config = { provider: 'kazakhstan-pkk', relaySourceId: 'kz-alatau-pkk', districtId: 364, zone: 13 };
const geometry = { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] };
const application = (id, code, updated = '2026-11-19T09:11:00Z') => ({
    geometry, properties: { gid: Number(id.slice(-3)), id, status_land_id: code, create_time: '2026-11-01T08:00:00Z', update_time: updated }
});
const snapshotOf = records => ({ hash: snapshotHash(records), url: viewSourceUrl(config, 'applications') });

describe('snapshot records', () => {
    it('keeps id, status code and the cadastre\'s own times, sorted, with a geometry hash', () => {
        const records = snapshotRecords('applications', [application('0334172026000002', 100), application('0334172026000001', null, null)]);
        expect(records.map(r => r.id)).toEqual(['0334172026000001', '0334172026000002']);
        expect(records[1]).toMatchObject({ statusCode: 100, createdAt: '2026-11-01T08:00:00.000Z', updatedAt: '2026-11-19T09:11:00.000Z' });
        expect(records[1].geometryHash).toMatch(/^[0-9a-f]{64}$/);
        expect(records[0]).toMatchObject({ statusCode: null, updatedAt: null });
        expect(outcomeOf(records[0])).toBe('none');
        expect(snapshotHash(records)).toBe(snapshotHash(snapshotRecords('applications', [application('0334172026000001', null, null), application('0334172026000002', 100)])));
    });

    it('refuses a record without an id or listed twice', () => {
        expect(() => snapshotRecords('applications', [application('', 20)])).toThrow(/no id/);
        expect(() => snapshotRecords('applications', [application('0334172026000001', 20), application('0334172026000001', 25)])).toThrow(/twice/);
    });

    it('takes only cities with a complete stateLand block', () => {
        expect(stateLandCities({ alatau: { stateLand: config }, other: {}, broken: { stateLand: { provider: 'kazakhstan-pkk' } } }))
            .toEqual([{ cityId: 'alatau', config }]);
    });
});

describe('status events', () => {
    it('records a first sighting and a status change, dated by the record\'s update time, and nothing unchanged', () => {
        const records = snapshotRecords('applications', [
            application('0334172026000001', 100, '2026-11-18T10:00:00Z'), application('0334172026000002', 20), application('0334172026000003', 25)
        ]);
        const previous = new Map([[subjectId('0334172026000001'), '45'], [subjectId('0334172026000003'), '25']]);
        const { events, added, changed, removed } = statusEvents({
            viewName: 'applications', config, records, snapshot: snapshotOf(records), previous, fetchedAt: '2026-11-20T06:00:00.000Z'
        });
        expect({ added, changed, removed }).toEqual({ added: 1, changed: 1, removed: 0 });
        const granted = events.find(e => e.subject_id === 'egkn:0334172026000001');
        expect(granted).toMatchObject({
            event_type: 'state_land_status', subject_type: 'land-application', outcome: '100', transaction_signature: '',
            source_observed_at: '2026-11-18T10:00:00.000Z', source_hash: snapshotHash(records)
        });
        expect(granted.evidence).toMatchObject({ previousOutcome: '45', stage: 'granted', statusLabel: 'Постановление МИО выдано', sourceTime: 'update_time', districtId: 364 });
        // The same fact gets the same id on every pass.
        const again = statusEvents({ viewName: 'applications', config, records, snapshot: snapshotOf(records), previous, fetchedAt: '2026-11-21T06:00:00.000Z' });
        expect(again.events.map(e => e.event_id)).toEqual(events.map(e => e.event_id));
    });

    it('dates a removal by the read that missed the record, once', () => {
        const records = snapshotRecords('applications', [application('0334172026000001', 25), application('0334172026000002', 25)]);
        const previous = new Map([[subjectId('0334172026000001'), '25'], [subjectId('0334172026000002'), '25'],
            [subjectId('0334172026000003'), '20'], [subjectId('0334172026000004'), 'removed']]);
        const { events } = statusEvents({ viewName: 'applications', config, records, snapshot: snapshotOf(records), previous, fetchedAt: '2026-11-20T06:00:00.000Z' });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ subject_id: 'egkn:0334172026000003', outcome: 'removed', source_observed_at: '2026-11-20T06:00:00.000Z' });
        expect(events[0].evidence.sourceTime).toBe('fetched_at');
    });

    it('treats a read missing most of the listed records as broken, not as removals', () => {
        const records = snapshotRecords('applications', [application('0334172026000001', 25)]);
        const previous = new Map(['01', '02', '03'].map(n => [subjectId(`03341720260000${n}`), '25']));
        expect(() => statusEvents({ viewName: 'applications', config, records, snapshot: snapshotOf(records), previous, fetchedAt: '2026-11-20T06:00:00.000Z' }))
            .toThrow(/refusing/);
    });
});

describe('observer pass', () => {
    const page = features => ({ type: 'FeatureCollection', features, numberMatched: features.length });

    it('writes each view\'s snapshot with its events only on --apply, and fails the run on a failed view', async () => {
        const writes = [];
        const store = { latestOutcomes: async () => new Map(), writeView: async view => { writes.push(view); } };
        const fetchJson = async url => {
            if (url.includes('freelands_view')) throw new Error('the cadastre answered HTTP 502');
            return page([application('0334172026000001', 100)]);
        };
        const dry = await observeStateLand({ cities: [{ cityId: 'alatau', config }], fetchJson, store });
        expect(writes).toHaveLength(0);
        expect(dry.failed).toEqual([{ cityId: 'alatau', viewName: 'free', error: 'the cadastre answered HTTP 502' }]);
        const applied = await observeStateLand({ cities: [{ cityId: 'alatau', config }], fetchJson, store, apply: true });
        expect(applied.views).toMatchObject([{ viewName: 'applications', records: 1, added: 1, events: 1 }]);
        expect(writes).toHaveLength(1);
        expect(writes[0].snapshot).toMatchObject({ viewName: 'applications', districtId: 364, provider: 'kazakhstan-pkk' });
        expect(writes[0].snapshot.url).not.toMatch(/startIndex/);
        expect(writes[0].events[0].outcome).toBe('100');
    });
});
