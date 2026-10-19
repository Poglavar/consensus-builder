// The auto-settlement job's selection rule: only minted, expired, still-Active-on-chain proposals whose
// lens holds the lifecycle member; every other row is skipped with a reason, never silently.
import { describe, expect, it } from 'vitest';
import { selectExpiryCandidates } from '../scripts/expire-proposals.mjs';

const ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
const OTHER = 'Fh3K8apDKKKjPUPLVV5Y327Hd5s2HY9Y7bqAvjidFcC5';
const LIFECYCLE = 'm8gLfyPspP6ABSNA4ZMFYCzzRGjNLBmrKKwKrGqbUfR';
const now = new Date('2026-10-09T12:00:00Z');
const row = (overrides) => ({ proposal_id: 'p', city: 'san_francisco', title: 'T', expires_at: '2026-10-01T00:00:00Z', onchain_data: { chainId: 'solana-devnet', proposalId: ACCOUNT }, ...overrides });

describe('selectExpiryCandidates', () => {
    it('selects an expired, minted, Active proposal whose lens holds the lifecycle member', () => {
        const statuses = new Map([[ACCOUNT, { status: 'Active', lens: [LIFECYCLE] }]]);
        const out = selectExpiryCandidates([row({})], { statuses, now, lifecycleKey: LIFECYCLE });
        expect(out.selected).toHaveLength(1);
        expect(out.selected[0]).toMatchObject({ proposalId: 'p', account: ACCOUNT, expiresAt: new Date('2026-10-01T00:00:00Z') });
        expect(out.skipped).toEqual([]);
    });

    it('skips, with a reason, everything the verdict could not settle', () => {
        const statuses = new Map([
            [ACCOUNT, { status: 'Active', lens: ['someone-else'] }],
            [OTHER, { status: 'Expired', lens: [LIFECYCLE] }]
        ]);
        const out = selectExpiryCandidates([
            row({ proposal_id: 'unminted', onchain_data: null }),
            row({ proposal_id: 'future', expires_at: '2027-01-01T00:00:00Z', onchain_data: { chainId: 'solana-devnet', proposalId: OTHER } }),
            row({ proposal_id: 'no-expiry', expires_at: null }),
            row({ proposal_id: 'already', onchain_data: { chainId: 'solana-devnet', proposalId: OTHER } }),
            row({ proposal_id: 'wrong-lens' }),
            row({ proposal_id: 'unreadable', onchain_data: { chainId: 'solana-devnet', proposalId: '5A9kzK2SzjP5nU2Dnz958wQcy96KkMnavoMNGxt7p1h3' } })
        ], { statuses, now, lifecycleKey: LIFECYCLE });
        expect(out.selected).toEqual([]);
        expect(out.skipped.map(item => `${item.proposalId}: ${item.reason}`)).toEqual([
            'unminted: not minted on Solana',
            'future: not expired yet',
            'no-expiry: no expiry',
            'already: already Expired on-chain',
            'wrong-lens: lifecycle member not in its lens',
            'unreadable: proposal account unreadable'
        ]);
    });
});
