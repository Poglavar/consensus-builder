import { describe, expect, it } from 'vitest';
import { assertPlanCommitment, assertPlanCurrent, planCommitmentError } from '../plans/plan-commitment.js';
import { memberHash, planHash } from '../plans/plan-hash.js';
import { createPlanStore } from '../plans/plan-store.js';
import { createMockPool } from './helpers/mock-pool.js';

const good = () => ({
    slug: 'valid-plan', proposal_ids: ['12', '34'],
    member_hashes: { '12': 'a'.repeat(64), '34': 'b'.repeat(64) },
    plan_hash: 'c'.repeat(64),
});

function currentMember() {
    return {
        id: 12, proposal_id: 'authored-12', type: 'building', goal: 'buildings',
        site: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
        cadastre_parcel_ids: ['parcel-12'], building_proposal: { parameters: { floors: 4 } },
        proposal_data: { kind: 'community-vote' },
    };
}

function currentPlan(member = currentMember(), overrides = {}) {
    const hash = memberHash(member);
    return {
        slug: 'current-plan', proposal_ids: [String(member.id)], member_hashes: { [member.id]: hash },
        plan_hash: planHash([{ proposalId: member.proposal_id, hash }]),
        ...overrides,
    };
}

describe('saved plan commitment validation', () => {
    it('accepts a complete commitment and returns the row', () => {
        const row = good();
        expect(planCommitmentError(row)).toBeNull();
        expect(assertPlanCommitment(row)).toBe(row);
    });

    it.each([
        ['null row ids', { proposal_ids: null }],
        ['empty row ids', { proposal_ids: [] }],
        ['numeric row id', { proposal_ids: [12] }],
        ['nondigit row id', { proposal_ids: ['12x'] }],
        ['duplicate row id', { proposal_ids: ['12', '12'] }],
        ['null member hashes', { member_hashes: null }],
        ['array member hashes', { member_hashes: [] }],
        ['partial member hashes', { member_hashes: { '12': 'a'.repeat(64) } }],
        ['extra member hash', { member_hashes: { '12': 'a'.repeat(64), '34': 'b'.repeat(64), '56': 'd'.repeat(64) } }],
        ['malformed member hash', { member_hashes: { '12': 'A'.repeat(64), '34': 'b'.repeat(64) } }],
        ['array member hash value', { member_hashes: { '12': ['a'.repeat(64)], '34': 'b'.repeat(64) } }],
        ['missing plan hash', { plan_hash: null }],
        ['malformed plan hash', { plan_hash: 'c'.repeat(63) }],
    ])('rejects %s with a recreate message', (_label, override) => {
        const row = { ...good(), ...override };
        const error = planCommitmentError(row);
        expect(error).toMatchObject({ code: 'plan-commitment-invalid', status: 422 });
        expect(error.message).toContain('valid-plan');
        expect(error.message).toMatch(/recreate/i);
        expect(() => assertPlanCommitment(row)).toThrow(error);
    });
});

describe('current plan commitments', () => {
    it('accepts hashes and aggregate identity computed from the current member row', () => {
        const member = currentMember();
        const row = currentPlan(member);
        expect(assertPlanCurrent(row, [member])).toBe(row);
    });

    it.each([
        ['missing member', []],
        ['changed member design', [{ ...currentMember(), building_proposal: { parameters: { floors: 5 } } }]],
    ])('rejects a %s as drift without rewriting the saved commitment', (_label, members) => {
        const row = currentPlan();
        const original = structuredClone(row);
        expect(() => assertPlanCurrent(row, members)).toThrow(expect.objectContaining({ code: 'plan-members-changed', status: 422 }));
        expect(row).toEqual(original);
    });

    it.each([
        ['renamed authored ID', member => ({ ...member, proposal_id: 'authored-renamed' }), {}],
        ['stored aggregate mismatch', member => member, { plan_hash: 'e'.repeat(64) }],
    ])('rejects %s as an invalid commitment without rewriting saved values', (_label, mutate, planOverride) => {
        const member = currentMember();
        const row = currentPlan(member, planOverride);
        const original = structuredClone(row);
        expect(() => assertPlanCurrent(row, [mutate(member)])).toThrow(expect.objectContaining({ code: 'plan-commitment-invalid', status: 422 }));
        expect(row).toEqual(original);
    });
});

describe('plan store mintInput validation', () => {
    it('loads and returns a valid stored plan together with its current member rows', async () => {
        const member = currentMember();
        const row = currentPlan(member);
        const pool = createMockPool();
        pool.setResults([{ rows: [row] }, { rows: [member] }]);
        const result = await createPlanStore(pool).mintInput(row.slug);
        expect(result).toEqual(row);
        expect(pool.getCalls()).toHaveLength(2);
        expect(pool.getCalls()[1].params).toEqual([[12]]);
    });

    it('rejects an invalid saved commitment before querying its members', async () => {
        const row = currentPlan(undefined, { member_hashes: {} });
        const pool = createMockPool();
        pool.setResult({ rows: [row] });
        await expect(createPlanStore(pool).mintInput(row.slug)).rejects.toMatchObject({ code: 'plan-commitment-invalid', status: 422 });
        expect(pool.getCalls()).toHaveLength(1);
    });

    it('rejects drift after loading the current members', async () => {
        const row = currentPlan();
        const changed = { ...currentMember(), building_proposal: { parameters: { floors: 6 } } };
        const pool = createMockPool();
        pool.setResults([{ rows: [row] }, { rows: [changed] }]);
        await expect(createPlanStore(pool).mintInput(row.slug)).rejects.toMatchObject({ code: 'plan-members-changed', status: 422 });
        expect(pool.getCalls()).toHaveLength(2);
    });
});
