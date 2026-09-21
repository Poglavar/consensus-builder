import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const timeline = require('../../frontend/js/proposals/possibility-timeline.js');

function activity(type, transaction, at, extra = {}) {
    return {
        entity: { type: 'proposal', id: 'proposal-id' },
        actor: { id: 'wallet', name: extra.actor || 'Ada' },
        action: { type, proposalId: 'proposal-id', amount: extra.amount, side: extra.side },
        transaction, recordedAt: at
    };
}

describe('proposal possibility timeline', () => {
    it('assembles the complete proposal-to-public-fact sequence oldest first', () => {
        const model = timeline.build({
            proposalId: 'proposal-id', proposalAccount: 'proposal-account',
            events: [
                activity('stake', 'stake-tx', '2026-09-21T03:00:00Z', { side: 'yes' }),
                activity('publish', 'publish-tx', '2026-09-21T01:00:00Z'),
                activity('pledge', 'pledge-tx', '2026-09-21T02:00:00Z', { amount: '0.10', actor: 'Supporter' })
            ],
            oracleEvents: [{
                eventType: 'proposal_lifecycle', subject: { id: 'proposal-account' }, outcome: 'executed',
                observedAt: '2026-09-21T04:00:00Z', attester: { address: 'ProposalNFT' },
                source: { transaction: 'resolution-tx', hash: `sha256:${'a'.repeat(64)}` }
            }]
        });
        expect(model.complete).toBe(true);
        expect(model.current).toBeNull();
        expect(model.stages.map(item => [item.id, item.status, item.evidence?.transaction])).toEqual([
            ['proposed', 'complete', 'publish-tx'],
            ['backed', 'complete', 'pledge-tx'],
            ['forecast', 'complete', 'stake-tx'],
            ['realized', 'complete', 'resolution-tx']
        ]);
        expect(model.stages[1].evidence.actor).toBe('Supporter');
        expect(model.stages[3].evidence.action).toBe('resolved YES');
    });

    it('keeps absent stages visibly pending instead of inventing activity', () => {
        const model = timeline.build({ proposalId: 'proposal-id', createdAt: '2026-09-21T01:00:00Z' });
        expect(model.complete).toBe(false);
        expect(model.current).toBe('backed');
        expect(model.stages.map(item => item.status)).toEqual(['complete', 'current', 'pending', 'pending']);
        expect(model.stages[0].evidence).toMatchObject({ action: 'proposal recorded', occurredAt: '2026-09-21T01:00:00Z' });
    });

    it('ignores activity and oracle events for other proposals', () => {
        const other = activity('donate', 'other-tx', '2026-09-21T02:00:00Z');
        other.entity.id = 'other';
        const model = timeline.build({
            proposalId: 'proposal-id', events: [other],
            oracleEvents: [{ eventType: 'proposal_lifecycle', subject: { id: 'other' }, outcome: 'cancelled' }]
        });
        expect(model.stages[1].evidence).toBeNull();
        expect(model.stages[3].evidence).toBeNull();
    });

    it('makes resolution the next stage once a forecast exists', () => {
        const model = timeline.build({
            proposalId: 'proposal-id',
            events: [
                activity('pledge', 'pledge-tx', '2026-09-21T02:00:00Z'),
                activity('stake', 'stake-tx', '2026-09-21T03:00:00Z')
            ]
        });
        expect(model.current).toBe('realized');
        expect(model.stages[3].status).toBe('current');
    });
});
