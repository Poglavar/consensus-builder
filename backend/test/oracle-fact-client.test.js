import { describe, expect, it, vi } from 'vitest';
import { encodePaymentResponseHeader } from '@x402/core/http';
import { buyOracleFact, oracleFactUrl } from '../agents/oracle-fact-client.js';

const PROPOSAL = 'Gsvt6nMhsvfrEDgvcqZDzPKZhhqACFEi3mueMxQNQ6UT';
const MARKET = 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB';

describe('paid oracle fact client', () => {
    it('builds the exact query URL without hand-concatenating user input', () => {
        expect(oracleFactUrl('https://api.example.test/base', PROPOSAL, MARKET)).toBe(
            `https://api.example.test/agent/oracle/facts?subject=${PROPOSAL}&market=${MARKET}`
        );
        expect(() => oracleFactUrl('', PROPOSAL)).toThrow(/baseUrl/);
        expect(() => oracleFactUrl('https://api.example.test', '')).toThrow(/proposalAccount/);
    });

    it('returns the verified bundle and decoded x402 settlement receipt', async () => {
        const receipt = {
            success: true,
            transaction: 'tx-paid-fact',
            network: 'solana:devnet',
            payer: PROPOSAL
        };
        const paidFetch = vi.fn(async () => new Response(JSON.stringify({
            fact: { subject: { id: PROPOSAL }, outcome: 'cancelled' },
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
            baseUrl: 'https://api.example.test', proposalAccount: PROPOSAL, paidFetch
        });

        expect(result).toMatchObject({
            status: 200,
            body: { verification: { status: 'verified' } },
            receipt,
            extensionResponses: { bazaar: { status: 'processing' } }
        });
        expect(paidFetch).toHaveBeenCalledWith(
            `https://api.example.test/agent/oracle/facts?subject=${PROPOSAL}`,
            { headers: { accept: 'application/json' } }
        );
    });

    it('ignores malformed facilitator extension responses without losing the paid fact', async () => {
        const paidFetch = vi.fn(async () => new Response('{}', {
            status: 200,
            headers: { 'extension-responses': 'not-base64-json' }
        }));

        const result = await buyOracleFact({
            baseUrl: 'https://api.example.test', proposalAccount: PROPOSAL, paidFetch
        });

        expect(result.extensionResponses).toBeNull();
    });
});
