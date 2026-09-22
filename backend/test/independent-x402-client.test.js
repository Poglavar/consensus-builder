import { encodePaymentRequiredHeader } from '@x402/core/http';
import { describe, expect, it, vi } from 'vitest';
import { discoverFactPurchase, verifyPurchasedFact } from '../examples/independent-x402-client.mjs';

const RESOURCE = 'https://api.example.test/agent/oracle/facts';
const SUBJECT = '11111111111111111111111111111111';

function challenge() {
    return encodePaymentRequiredHeader({
        x402Version: 2,
        error: 'payment required',
        resource: { url: RESOURCE, description: 'verified fact' },
        accepts: [{
            scheme: 'exact', network: 'solana:devnet', asset: 'usdc', amount: '10000',
            payTo: 'treasury', maxTimeoutSeconds: 60, extra: { paymentFlow: 'upfront' }
        }],
        extensions: {}
    });
}

describe('independent x402 client', () => {
    it('discovers the resource publicly and refuses prices above its own cap', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                state: 'listed', network: 'solana:devnet', totalMatches: 1,
                listing: { resource: RESOURCE }
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response('{}', { status: 402, headers: { 'payment-required': challenge() } }));
        const plan = await discoverFactPurchase({ api: 'https://api.example.test', subject: SUBJECT, fetchImpl });
        expect(plan.resource).toBe(`${RESOURCE}?subject=${SUBJECT}`);
        expect(plan.amount).toBe(10000n);

        fetchImpl.mockClear()
            .mockResolvedValueOnce(new Response(JSON.stringify({ state: 'listed', listing: { resource: RESOURCE } }), { status: 200 }))
            .mockResolvedValueOnce(new Response('{}', { status: 402, headers: { 'payment-required': challenge() } }));
        await expect(discoverFactPurchase({ api: 'https://api.example.test', fetchImpl, maxAtomic: 9999n }))
            .rejects.toThrow('exceeds clean-room cap');
    });

    it('matches a purchased fact to its free source-hashed public event', () => {
        const event = {
            id: 'event-1', subject: { type: 'proposal', id: SUBJECT },
            source: { hash: `sha256:${'a'.repeat(64)}`, transaction: 'source-tx' }
        };
        const bundle = {
            fact: event,
            recipe: { subject: { proposalAccount: SUBJECT } },
            verification: { status: 'verified', checks: { subjectMatches: true, sourceHashPresent: true } }
        };
        expect(verifyPurchasedFact(bundle, { events: [event] })).toMatchObject({ verified: true, eventId: 'event-1' });
        expect(() => verifyPurchasedFact(bundle, { events: [] })).toThrow('did not match');
    });
});

