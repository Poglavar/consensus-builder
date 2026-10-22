// The outside-agent client of the paid verified-fact endpoint (agents/oracle-fact-client.js): its URL
// names the agreement account as the subject, and a paid answer comes back with its decoded receipt.
import { describe, expect, it, vi } from 'vitest';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { buyOracleFact, fetchOracleFactChallenge, oracleFactUrl } from '../agents/oracle-fact-client.js';

// An agreement account (the fact's subject) and a market account.
const AGREEMENT = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';
const MARKET = 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB';

describe('paid oracle fact client', () => {
    it('builds the exact query URL without hand-concatenating user input', () => {
        expect(oracleFactUrl('https://api.example.test/base', AGREEMENT, MARKET)).toBe(
            `https://api.example.test/agent/oracle/facts?subject=${AGREEMENT}&market=${MARKET}`
        );
        expect(oracleFactUrl('https://api.example.test/base')).toBe(
            'https://api.example.test/agent/oracle/facts'
        );
        expect(() => oracleFactUrl('', AGREEMENT)).toThrow(/baseUrl/);
    });

    it('returns the verified bundle and decoded x402 settlement receipt', async () => {
        const receipt = {
            success: true,
            transaction: 'tx-paid-fact',
            network: 'solana:devnet',
            payer: AGREEMENT
        };
        const paidFetch = vi.fn(async () => new Response(JSON.stringify({
            fact: { subject: { id: AGREEMENT }, outcome: 'cancelled' },
            recipe: { hash: `sha256:${'a'.repeat(64)}` },
            verification: { status: 'verified' }
        }), {
            status: 200,
            headers: {
                'content-type': 'application/json',
                'payment-response': encodePaymentResponseHeader(receipt),
                'extension-responses': Buffer.from(JSON.stringify({
                    bazaar: { status: 'processing' }
                })).toString('base64')
            }
        }));

        const result = await buyOracleFact({
            baseUrl: 'https://api.example.test', subject: AGREEMENT, paidFetch
        });

        expect(result).toMatchObject({
            status: 200,
            body: { verification: { status: 'verified' } },
            receipt,
            extensionResponses: { bazaar: { status: 'processing' } }
        });
        expect(paidFetch).toHaveBeenCalledWith(
            `https://api.example.test/agent/oracle/facts?subject=${AGREEMENT}`,
            { headers: { accept: 'application/json' } }
        );
    });

    it('ignores malformed facilitator extension responses without losing the paid fact', async () => {
        const paidFetch = vi.fn(async () => new Response('{}', {
            status: 200,
            headers: { 'extension-responses': 'not-base64-json' }
        }));

        const result = await buyOracleFact({
            baseUrl: 'https://api.example.test', subject: AGREEMENT, paidFetch
        });

        expect(result.extensionResponses).toBeNull();
    });

    it('reads the 402 challenge without paying, and refuses an answer that is not one', async () => {
        const header = encodePaymentRequiredHeader({
            x402Version: 2, error: 'payment required',
            resource: { url: 'https://api.example.test/agent/oracle/facts', description: 'A verified agreement fact' },
            accepts: [{ scheme: 'exact', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
                amount: '10000', payTo: MARKET, maxTimeoutSeconds: 60, extra: {} }]
        });
        const fetchImpl = vi.fn(async () => new Response('{}', { status: 402, headers: { 'payment-required': header } }));
        const challenge = await fetchOracleFactChallenge({ baseUrl: 'https://api.example.test', subject: AGREEMENT, marketAccount: MARKET, fetchImpl });
        expect(challenge.accepts[0].amount).toBe('10000');
        expect(fetchImpl).toHaveBeenCalledWith(`https://api.example.test/agent/oracle/facts?subject=${AGREEMENT}&market=${MARKET}`, { headers: { accept: 'application/json' } });
        const notFound = vi.fn(async () => new Response('{"error":"no fact"}', { status: 404 }));
        await expect(fetchOracleFactChallenge({ baseUrl: 'https://api.example.test', subject: AGREEMENT, fetchImpl: notFound })).rejects.toThrow(/404/);
    });

    it('can buy the latest fact through the advertised queryless resource URL', async () => {
        const paidFetch = vi.fn(async () => new Response('{}', { status: 200 }));

        await buyOracleFact({ baseUrl: 'https://api.example.test', paidFetch });

        expect(paidFetch).toHaveBeenCalledWith(
            'https://api.example.test/agent/oracle/facts',
            { headers: { accept: 'application/json' } }
        );
    });
});
