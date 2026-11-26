// planRemint decides, per indexed agreement, whether the re-mint script mints, only records, opens a market,
// or leaves it (expired, settled, still recorded on the old program, or a sponsor key we do not hold).
import { describe, expect, it } from 'vitest';
import { OLD_AGREEMENT_PROGRAM_ID, personaKeys, planRemint } from '../scripts/remint-agreements.mjs';

const CURRENT = 'ESJ1w3rpzXtUXcZFgRfzHYRBzcrT7HeCychLNXvdBeYH';
const SPONSOR = '4EXtquCoNRBXvfVgDRfBSXSWzrBctcqLwwUau96Umeqk';
const NOW = Date.parse('2026-11-26T12:00:00Z');
const row = (overrides = {}) => ({
    cid: 'bafkreiarw7qlptbgq2eiccwcmcg5yiuazh5i3zcx7lmt4ly32j4f6q6aj4',
    content: { sponsor: SPONSOR, deadline: '2027-10-09T08:19:27Z', rule: { binding: true, electorate: 'owners' } },
    onchain: null,
    ...overrides
});
const key = { persona: 'builder-02', keypairPath: '/keys/builder-02.json', present: true };
const plan = (args = {}) => planRemint({ row: row(), key, nowMs: NOW, currentProgramId: CURRENT, ...args });

describe('planRemint', () => {
    it('mints, records and opens a market for an unminted agreement, carrying the old escrow', () => {
        const result = plan({ chain: { current: null, old: { requiredLamports: 1000000n, status: 0 } }, market: { wanted: true, exists: false } });
        expect(result).toEqual({ action: 'remint', steps: ['pin', 'mint', 'record', 'open-market'], lamports: '1000000' });
    });

    it('only records an account the sponsor already created on the current program', () => {
        const result = plan({ chain: { current: { requiredLamports: 1000000n }, old: null } });
        expect(result).toEqual({ action: 'remint', steps: ['record'], lamports: '1000000' });
    });

    it('does nothing for an agreement already minted, recorded and with its market open', () => {
        const recorded = row({ onchain: { programId: CURRENT, account: 'x', status: 'active' } });
        const result = plan({ row: recorded, chain: { current: { requiredLamports: 0n } }, market: { wanted: true, exists: true } });
        expect(result.action).toBe('skip');
        expect(result.steps).toEqual([]);
    });

    it('opens only the market when the mint is already recorded', () => {
        const recorded = row({ onchain: { programId: CURRENT, account: 'x', status: 'active' } });
        expect(plan({ row: recorded, chain: { current: { requiredLamports: 0n } }, market: { wanted: true, exists: false } }).steps).toEqual(['open-market']);
    });

    it('skips an expired agreement (the program refuses a past deadline)', () => {
        const expired = row({ content: { ...row().content, deadline: '2026-11-01T23:17:08Z' } });
        expect(plan({ row: expired }).action).toBe('skip');
        expect(plan({ row: expired }).reason).toMatch(/expired/);
    });

    it('skips polls and rows missing from the index', () => {
        expect(plan({ row: row({ content: { ...row().content, rule: { binding: false, electorate: 'community' } } }) }).action).toBe('skip');
        expect(plan({ row: null }).reason).toBe('not in the index');
    });

    it('leaves an agreement settled on the old program, and blocks one still recorded there as active', () => {
        const executed = row({ onchain: { programId: OLD_AGREEMENT_PROGRAM_ID, status: 'executed' } });
        expect(plan({ row: executed }).action).toBe('skip');
        const active = row({ onchain: { programId: OLD_AGREEMENT_PROGRAM_ID, status: 'active' } });
        expect(plan({ row: active }).action).toBe('blocked');
        const settledOnChain = plan({ chain: { current: null, old: { requiredLamports: 0n, status: 1 } } });
        expect(settledOnChain.action).toBe('skip');
    });

    it('names the sponsor when we hold no key for it', () => {
        expect(plan({ key: undefined, chain: { current: null } }).action).toBe('needs-sponsor');
        expect(plan({ key: { ...key, present: false }, chain: { current: null } }).reason).toMatch(/key file missing/);
        // Recording an account the sponsor already created needs no key.
        expect(plan({ key: undefined, chain: { current: { requiredLamports: 0n } } }).action).toBe('remint');
    });
});

describe('personaKeys', () => {
    it('maps each persona wallet to its keypair path, expanding ~ and noting a missing file', () => {
        const keys = personaKeys({ a: { name: 'builder-02', wallet: SPONSOR, keypairPath: '~/.config/solana/b.json' }, b: { name: 'no-key', wallet: 'W' } },
            file => file.endsWith('b.json'));
        expect(keys.get(SPONSOR)).toMatchObject({ persona: 'builder-02', present: true });
        expect(keys.get(SPONSOR).keypairPath.startsWith('~')).toBe(false);
        expect(keys.has('W')).toBe(false);
    });
});
