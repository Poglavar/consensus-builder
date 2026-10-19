// A named plan commits to its members' decision kind, site and design (plans.md). The hash must move when that
// content moves, and must NOT move for prose, thumbnails or lifecycle state.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { memberHash, memberContent, planHash, nextVersionSlug, stableStringify, changedMembers, roadContent } from '../plans/plan-hash.js';
import { createPlanStore } from '../plans/plan-store.js';

const require = createRequire(import.meta.url);
const deal = require('../../frontend/js/reparcellization-deal.js');

const building = {
    id: 7, type: 'building', goal: 'buildings', title: 'Blok M1-9', description: 'Prvi opis',
    site: { type: 'MultiPolygon', coordinates: [[[[16, 45], [16.001, 45], [16.001, 45.001], [16, 45]]]] },
    cadastre_parcel_ids: ['HR-335550-1791/69'],
    building_proposal: { parameters: { floors: 5, height: 17.5 } },
    geometry: { buildings: [{ type: 'Feature', properties: { height: 17.5 }, geometry: { type: 'Polygon', coordinates: [] } }] },
    screenshot_url: 'https://example.invalid/a.png', lifecycle_status: 'Active'
};
building.proposal_data = { kind: 'owner-deal', site: building.site };

const plot = x => ({
    type: 'Polygon',
    coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]]
});

function readjustment() {
    return {
        proposalId: 'lr-member', type: 'parcel', goal: 'reparcellization', kind: 'owner-deal', site: plot(-1),
        cadastreParcelIds: ['HR-A', 'HR-B'], offer: 100, offerCurrency: 'EUR',
        isConditional: true, expiresAt: '2030-01-01T00:00:00.000Z',
        depositEnabled: true, depositPercent: 10, decayEnabled: true,
        decayPercent: 5, decayDurationMs: 3600000, disbursementMode: 'partial',
        reparcellizationAgreement: { groupId: 'deal-1', index: 0, count: 1 },
        reparcellization: {
            poolGeometry: plot(-1), poolSource: 'site', contributionBasis: 'area',
            poolUnitValue: 10, totalValue: 2000, contributionRatio: 1,
            polygons: [
                { geometry: plot(0), jointPool: false, percent: 50, owners: [
                    { ownerKey: 'ana', displayName: 'Ana', share: 0.5 },
                    { ownerKey: 'bob', displayName: 'Bob', share: 0.5 }
                ] },
                { geometry: plot(2), ownerKey: 'ana', displayName: 'Ana', percent: 50 }
            ],
            inputParcels: [{ geometry: plot(-1), ownerKey: 'ana', displayName: 'Ana' }],
            ownerShares: [
                { ownerKey: 'ana', cashOffer: 60, contributedArea: 100, contributedValue: 1000,
                    entitledValue: 1000, assignedArea: 100, assignedValue: 1000, cashBalance: 0 },
                { ownerKey: 'bob', cashOffer: 40, contributedArea: 100, contributedValue: 1000,
                    entitledValue: 1000, assignedArea: 100, assignedValue: 1000, cashBalance: 0 }
            ],
            regime: { id: 'consensus-v1' }, policy: { threshold: 0.75 }, electorate: ['ana', 'bob']
        }
    };
}

function asDatabaseRow(proposal) {
    return {
        type: proposal.type, goal: proposal.goal,
        cadastre_parcel_ids: proposal.cadastreParcelIds,
        offer: String(proposal.offer), offer_currency: proposal.offerCurrency,
        is_conditional: proposal.isConditional, expires_at: new Date(proposal.expiresAt),
        deposit_enabled: proposal.depositEnabled, deposit_percent: proposal.depositPercent,
        decay_enabled: proposal.decayEnabled, decay_percent: proposal.decayPercent,
        decay_duration_ms: String(proposal.decayDurationMs), disbursement_mode: proposal.disbursementMode,
        reparcellization: proposal.reparcellization,
        proposal_data: {
            kind: proposal.kind, site: proposal.site,
            reparcellizationAgreement: proposal.reparcellizationAgreement,
            currency: proposal.currency
        }
    };
}

describe('memberHash', () => {
    it('ignores prose, thumbnails and lifecycle state', () => {
        const restated = { ...building, title: 'Novi naslov', description: 'Drugi opis', screenshot_url: null, lifecycle_status: 'Expired' };
        expect(memberHash(restated)).toBe(memberHash(building));
    });

    it('moves when what is built moves', () => {
        expect(memberHash({ ...building, building_proposal: { parameters: { floors: 6, height: 21 } } })).not.toBe(memberHash(building));
        expect(memberHash({ ...building, cadastre_parcel_ids: ['HR-335550-1791/70'] })).not.toBe(memberHash(building));
        const road = { id: 8, type: 'road', road_proposal: { definition: { segments: [[{ lat: 1, lng: 2 }, { lat: 1, lng: 3 }]], width: 19 } } };
        const moved = { ...road, road_proposal: { definition: { segments: [[{ lat: 1, lng: 2 }, { lat: 1.0001, lng: 3 }]], width: 19 } } };
        expect(memberHash(moved)).not.toBe(memberHash(road));
    });

    it('hashes a road by its stretches and cross-sections, whichever shape the row spells them in', () => {
        const osmForm = require('../../frontend/js/corridor-osm-form.js');
        const P = require('../../frontend/js/corridor-profile.js');
        const profile = { strips: P.CORRIDOR_PROFILE_PRESETS[10].map(lane => ({ ...lane })) };
        const points = [{ lat: 45.8, lng: 15.97 }, { lat: 45.8004, lng: 15.9712, level: -1, elevationM: 120.5 }];
        const nested = { id: 8, type: 'road', road_proposal: { definition: { points: [points], segments: [points], segmentIds: [null], segmentProfiles: {}, profile, width: 10 } } };
        const flat = { ...nested, road_proposal: { definition: { points, width: 10, profile } } };
        const recorded = { ...nested, road_proposal: { definition: osmForm.toRecord(nested.road_proposal.definition) } };
        const legacy = { ...nested, road_proposal: { definition: { points, width: 10 } } }; // the 10 m preset, as a width alone
        expect(recorded.road_proposal.definition.points).toBeUndefined();
        expect(memberHash(flat)).toBe(memberHash(nested));
        expect(memberHash(recorded)).toBe(memberHash(nested));
        expect(memberHash(legacy)).toBe(memberHash(nested));
        const relaned = { ...nested, road_proposal: { definition: { ...nested.road_proposal.definition, profile: { strips: [{ type: 'driving', width: 5 }] } } } };
        expect(memberHash(relaned)).not.toBe(memberHash(nested));
        const raised = { ...nested, road_proposal: { definition: { ...nested.road_proposal.definition, points: [[points[0], { ...points[1], elevationM: 121 }]], segments: undefined } } };
        expect(memberHash(raised)).not.toBe(memberHash(nested));
        expect(roadContent({ polygon: { type: 'Polygon', coordinates: [] }, kind: 'road', width: 12 })).toEqual({ stretches: [], width: 12, kind: 'road' });
    });

    it('does not depend on key order or parcel order', () => {
        const shuffled = { ...building, cadastre_parcel_ids: ['HR-335550-1791/69'], building_proposal: { parameters: { height: 17.5, floors: 5 } } };
        expect(memberHash(shuffled)).toBe(memberHash(building));
        expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    });

    it.each([
        ['building', () => structuredClone(building)],
        ['readjustment', () => asDatabaseRow(readjustment())]
    ])('commits to authored kind and site for a %s member', (_label, makeRow) => {
        const original = makeRow();
        const changedKind = makeRow();
        changedKind.proposal_data.kind = 'community-vote';
        const changedSite = makeRow();
        changedSite.proposal_data.site = plot(5);
        expect(memberHash(changedKind)).not.toBe(memberHash(original));
        expect(memberHash(changedSite)).not.toBe(memberHash(original));
        expect(memberHash({ ...original, site: plot(10) })).toBe(memberHash(original));
        expect(memberHash({ ...original, id: 999 })).toBe(memberHash(original));
    });

    it('hashes the current non-readjustment content contract', () => {
        const projection = {
            kind: building.proposal_data.kind,
            site: building.proposal_data.site,
            type: building.type ?? null,
            goal: building.goal ?? null,
            parcels: [...building.cadastre_parcel_ids].map(String).sort(),
            road: null,
            building: building.building_proposal.parameters,
            structure: null,
            layout: null,
            geometry: building.geometry
        };
        const expected = createHash('sha256').update(stableStringify(projection)).digest('hex');
        expect(memberHash(building)).toBe(expected);
    });

    it('includes the shared LR deal fingerprint within the plan member commitment', () => {
        const proposal = readjustment();
        const row = asDatabaseRow(proposal);
        const projection = { kind: proposal.kind, site: proposal.site, readjustmentDeal: deal.fingerprint(proposal) };
        expect(memberContent(row)).toEqual(projection);
        expect(memberHash(row)).toBe(createHash('sha256').update(stableStringify(projection)).digest('hex'));
    });

    it.each([
        ['co-owner shares', proposal => { proposal.reparcellization.polygons[0].owners[0].share = 0.6; proposal.reparcellization.polygons[0].owners[1].share = 0.4; }],
        ['cash allocation', proposal => { proposal.reparcellization.ownerShares[0].cashOffer = 70; proposal.reparcellization.ownerShares[1].cashOffer = 30; }],
        ['total cash offer', proposal => { proposal.offer = 120; proposal.reparcellization.ownerShares[0].cashOffer = 80; proposal.reparcellization.ownerShares[1].cashOffer = 40; }],
        ['same-outline plot partition', proposal => { proposal.reparcellization.polygons[1].ownerKey = 'bob'; proposal.reparcellization.polygons[1].displayName = 'Bob'; }],
        ['valuation', proposal => { proposal.reparcellization.totalValue += 1; }],
        ['policy', proposal => { proposal.reparcellization.policy.threshold = 0.8; }],
        ['regime', proposal => { proposal.reparcellization.regime.id = 'consensus-v2'; }],
        ['electorate', proposal => { proposal.reparcellization.electorate.push('cara'); }]
    ])('moves the named member digest when LR %s changes', (_label, mutate) => {
        const original = readjustment();
        const changed = readjustment();
        mutate(changed);
        expect(memberHash(asDatabaseRow(changed))).not.toBe(memberHash(asDatabaseRow(original)));
    });

    it('ignores LR presentation and validation metadata', () => {
        const original = readjustment();
        const cosmetic = readjustment();
        cosmetic.title = 'Renamed';
        cosmetic.screenshotUrl = '/new-thumbnail.png';
        cosmetic.reparcellization.validated = false;
        cosmetic.reparcellization.polygons.forEach(polygon => { polygon.percent = 1; });
        expect(memberHash(asDatabaseRow(cosmetic))).toBe(memberHash(asDatabaseRow(original)));
    });
});

describe('createPlanStore member query', () => {
    it('selects the serialized deal fields and raw proposal data needed by the shared fingerprint', async () => {
        let sql;
        const store = createPlanStore({ query: async query => { sql = query; return { rows: [] }; } });
        await store.members([7]);
        for (const column of ['p.offer,', 'p.offer_currency', 'p.is_conditional', 'p.expires_at',
            'p.deposit_enabled', 'p.deposit_percent', 'p.decay_enabled', 'p.decay_percent',
            'p.decay_duration_ms', 'p.disbursement_mode', 'p.proposal_data']) {
            expect(sql).toContain(column);
        }
    });
});

describe('createPlanStore named-plan identifier plumbing', () => {
    it('passes proposalRowIds through list and insert while persisting the SQL proposal_ids column', async () => {
        const calls = [];
        const store = createPlanStore({
            query: async (sql, params) => {
                calls.push({ sql, params });
                return { rows: [] };
            }
        });

        await store.list('zagreb', { proposalRowIds: ['11', '22'], parcelIds: null });
        await store.insert({
            slug: 'row-plan', proposalRowIds: ['11', '22'], title: 'Row plan', description: null,
            author: null, place: null, city: 'zagreb', memberHashes: { 11: 'a', 22: 'b' },
            planHash: 'hash', supersedes: null, creatorIp: null, creatorFingerprint: null
        });

        expect(calls[0].sql).toContain('e.proposal_ids ?| $2::text[]');
        expect(calls[0].params).toEqual(['zagreb', ['11', '22'], null]);
        expect(calls[1].sql).toContain('INSERT INTO ens_plan (slug, proposal_ids,');
        expect(calls[1].params[1]).toBe(JSON.stringify(['11', '22']));
        expect(calls[1].params[12]).toEqual([11, 22]);
    });
});

describe('planHash', () => {
    it('depends on member order', () => {
        const a = { proposalId: '1', hash: 'aa' };
        const b = { proposalId: '2', hash: 'bb' };
        expect(planHash([a, b])).not.toBe(planHash([b, a]));
    });
});

describe('changedMembers', () => {
    it('reports repaired and vanished members', () => {
        const hashes = { 7: memberHash(building), 9: 'gone' };
        expect(changedMembers(hashes, [building])).toEqual(['9']);
        expect(changedMembers(hashes, [{ ...building, building_proposal: { parameters: { floors: 9 } } }])).toEqual(['7', '9']);
    });

    it('reports an invalid current LR member as changed without rewriting its named hash', () => {
        const original = asDatabaseRow(readjustment());
        const namedHash = memberHash(original);
        const hashes = { 7: namedHash };
        const malformed = { ...original, id: 7,
            reparcellization: { ...original.reparcellization,
                ownerShares: original.reparcellization.ownerShares.map((owner, index) => index === 0
                    ? { ...owner, cashOffer: -1 } : owner) } };

        expect(changedMembers(hashes, [malformed])).toEqual(['7']);
        expect(hashes[7]).toBe(namedHash);
    });

    it('rethrows unexpected fingerprint infrastructure errors', () => {
        const row = { ...asDatabaseRow(readjustment()), id: 7 };
        const hashes = { 7: memberHash(row) };
        const hadOverride = Object.prototype.hasOwnProperty.call(globalThis, '__consentSha256');
        const previous = globalThis.__consentSha256;
        globalThis.__consentSha256 = { sha256Hex() { throw new Error('digest service unavailable'); } };
        try {
            expect(() => changedMembers(hashes, [row])).toThrow('digest service unavailable');
        } finally {
            if (hadOverride) globalThis.__consentSha256 = previous;
            else delete globalThis.__consentSha256;
        }
    });
});

describe('nextVersionSlug', () => {
    it('counts up from the base name, skipping taken versions', () => {
        expect(nextVersionSlug('borovje', new Set(['borovje']))).toBe('borovje-v2');
        expect(nextVersionSlug('borovje-v2', new Set(['borovje', 'borovje-v2', 'borovje-v3']))).toBe('borovje-v4');
    });
});
