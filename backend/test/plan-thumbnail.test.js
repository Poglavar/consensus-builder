import { describe, expect, it } from 'vitest';
import { collectPlanMemberParts, planMembersMatchSnapshot, generateAndStorePlanThumbnail } from '../thumbnails/plan-thumbnail.js';
import { memberHash, planHash } from '../plans/plan-hash.js';

const square = (x, y, size = 0.001) => [
    [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]
];

describe('whole-plan thumbnail geometry', () => {
    it('keeps every member footprint, every MultiPolygon part, and hole rings without unioning', () => {
        const first = square(1, 1);
        first.push([[1.0002, 1.0002], [1.0002, 1.0004], [1.0004, 1.0004], [1.0004, 1.0002], [1.0002, 1.0002]]);
        const second = square(2, 2);
        const members = [
            { proposal_data: {}, geometry: { buildings: [
                { type: 'Feature', geometry: { type: 'Polygon', coordinates: first } },
                { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [second, square(3, 3)] } }
            ] } },
            { proposal_data: { site: { type: 'MultiPolygon', coordinates: [square(4, 4), square(5, 5)] } }, geometry: null }
        ];
        const parts = collectPlanMemberParts(members);
        expect(parts).toHaveLength(5);
        expect(parts[0]).toEqual(first);
        expect(parts[1]).toEqual(second);
        expect(parts[2]).toEqual(square(3, 3));
        expect(parts[3]).toEqual(square(4, 4));
        expect(parts[4]).toEqual(square(5, 5));
    });

    it('refuses thumbnail storage when any member no longer matches the named plan snapshot', () => {
        const row = { id: 7, proposal_id: 'building-7', type: 'single', goal: 'single', proposal_data: { site: { type: 'Polygon', coordinates: square(1, 1) } }, cadastre_parcel_ids: [] };
        const plan = { slug: 'named-plan', proposal_ids: ['7'], member_hashes: { 7: memberHash(row) }, plan_hash: planHash([{ proposalId: 'building-7', hash: memberHash(row) }]) };
        expect(planMembersMatchSnapshot(plan, [row])).toBe(true);
        expect(planMembersMatchSnapshot(plan, [{ ...row, goal: 'park' }])).toBe(false);
        expect(planMembersMatchSnapshot({ ...plan, member_hashes: null }, [row])).toBe(false);
        expect(planMembersMatchSnapshot(plan, [])).toBe(false);
    });
});

describe('plan thumbnail canonical member loading', () => {
    it('checks the canonical complete member projection before attempting to render a changed plan', async () => {
        const queries = [];
        const pool = { query: async (sql) => {
            queries.push(sql);
            if (sql.includes('FROM ens_plan')) return { rows: [{ slug: 'changed', proposal_ids: ['7'], member_hashes: { 7: 'stale' }, plan_hash: 'stale' }] };
            return { rows: [{ id: 7, proposal_id: 'building-7', proposal_data: {} }] };
        } };
        expect(await generateAndStorePlanThumbnail(pool, 'changed', { dryRun: true })).toBeNull();
        expect(queries).toHaveLength(3);
        expect(queries[1]).toContain('p.proposal_data');
        expect(queries[1]).toContain('p.offer');
        expect(queries[2]).toContain("SELECT id, COALESCE(binding, proposal_data->'binding') AS binding FROM proposal");
        expect(queries.some(query => query.includes('UPDATE'))).toBe(false);
    });

    it('does not use an unqualified parcel ID as thumbnail context', async () => {
        const { declaredHrParcelIds } = await import('../thumbnails/plan-thumbnail.js');
        expect(declaredHrParcelIds({ cadastre_parcel_ids: ['parcel-1'], binding: null })).toEqual([]);
        expect(declaredHrParcelIds({ cadastre_parcel_ids: ['parcel-1'], binding: {
            parcelSource: { sourceId: 'another-provider', snapshotId: null }
        } })).toEqual([]);
        expect(declaredHrParcelIds({ cadastre_parcel_ids: ['parcel-1'], binding: {
            parcelSource: { sourceId: 'hr-cadastre', snapshotId: null }
        } })).toEqual(['parcel-1']);
    });
});
