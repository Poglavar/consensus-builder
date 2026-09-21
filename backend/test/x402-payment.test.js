// Unit tests for utils/x402-payment.js — the pure half of the pay-to-post gate: config reading,
// exact atomic→decimal formatting, agent-path detection and the agent stamp.
import { describe, it, expect } from 'vitest';
import {
    buildAgentStamp,
    CDP_CREDENTIAL_ENV_NAMES,
    CDP_FACILITATOR_URL,
    formatAtomicAmount,
    hashAgentProposalRequest,
    isAgentPath,
    isCdpFacilitatorUrl,
    readX402Config,
    readX402OracleConfig,
    X402_ORACLE_ENV_NAMES,
    X402_ENV_NAMES
} from '../utils/x402-payment.js';

const FULL_ENV = {
    X402_NETWORK: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    X402_FACILITATOR_URL: 'https://x402.org/facilitator',
    X402_PAY_TO: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ',
    X402_PRICE_PROPOSAL: '$0.05',
    X402_PRICE_ORACLE_FACT: '$0.01'
};

describe('readX402Config', () => {
    it('is enabled only when every variable is set', () => {
        const config = readX402Config(FULL_ENV);
        expect(config.enabled).toBe(true);
        expect(config.missing).toEqual([]);
        expect(config.network).toBe(FULL_ENV.X402_NETWORK);
        expect(config.facilitatorUrl).toBe(FULL_ENV.X402_FACILITATOR_URL);
        expect(config.payTo).toBe(FULL_ENV.X402_PAY_TO);
        expect(config.priceProposal).toBe('$0.05');
    });

    it('names every missing or blank variable and never defaults the network', () => {
        const config = readX402Config({ X402_PAY_TO: '  ', X402_PRICE_PROPOSAL: '$0.05' });
        expect(config.enabled).toBe(false);
        expect(config.missing).toEqual(['X402_NETWORK', 'X402_FACILITATOR_URL', 'X402_PAY_TO']);
        expect(config.network).toBeNull();
    });

    it('requires CDP credentials only for the hosted CDP facilitator', () => {
        const hosted = readX402Config({ ...FULL_ENV, X402_FACILITATOR_URL: CDP_FACILITATOR_URL });
        expect(hosted.enabled).toBe(false);
        expect(hosted.usesCdp).toBe(true);
        expect(hosted.missing).toEqual(CDP_CREDENTIAL_ENV_NAMES);

        const configured = readX402Config({
            ...FULL_ENV,
            X402_FACILITATOR_URL: CDP_FACILITATOR_URL,
            CDP_API_KEY_ID: 'organizations/example/apiKeys/example',
            CDP_API_KEY_SECRET: 'secret'
        });
        expect(configured.enabled).toBe(true);
        expect(configured.missing).toEqual([]);
    });

    it('recognizes only the canonical CDP hosted facilitator URL', () => {
        expect(isCdpFacilitatorUrl(CDP_FACILITATOR_URL)).toBe(true);
        expect(isCdpFacilitatorUrl(`${CDP_FACILITATOR_URL}/`)).toBe(true);
        expect(isCdpFacilitatorUrl('https://x402.org/facilitator')).toBe(false);
        expect(isCdpFacilitatorUrl('not a url')).toBe(false);
    });

    it('reads exactly the documented variable names', () => {
        expect(X402_ENV_NAMES).toEqual(['X402_NETWORK', 'X402_FACILITATOR_URL', 'X402_PAY_TO', 'X402_PRICE_PROPOSAL']);
        expect(X402_ORACLE_ENV_NAMES).toEqual(['X402_NETWORK', 'X402_FACILITATOR_URL', 'X402_PAY_TO', 'X402_PRICE_ORACLE_FACT']);
        expect(CDP_CREDENTIAL_ENV_NAMES).toEqual(['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET']);
    });

    it('configures oracle facts independently from proposal pricing', () => {
        const configured = readX402OracleConfig(FULL_ENV);
        expect(configured).toMatchObject({ enabled: true, priceOracleFact: '$0.01' });

        const missing = readX402OracleConfig({ ...FULL_ENV, X402_PRICE_ORACLE_FACT: ' ' });
        expect(missing.enabled).toBe(false);
        expect(missing.missing).toEqual(['X402_PRICE_ORACLE_FACT']);
        expect(missing.priceOracleFact).toBeNull();
    });
});

describe('isAgentPath', () => {
    it('matches only paths under /agent/', () => {
        expect(isAgentPath('/agent/proposals')).toBe(true);
        expect(isAgentPath('/agent/')).toBe(true);
        expect(isAgentPath('/agent')).toBe(false);
        expect(isAgentPath('/proposals')).toBe(false);
        expect(isAgentPath('/agents/foo')).toBe(false);
        expect(isAgentPath(undefined)).toBe(false);
    });
});

describe('formatAtomicAmount', () => {
    it('formats USDC atomic units exactly', () => {
        expect(formatAtomicAmount('50000', 6)).toBe('0.05');
        expect(formatAtomicAmount('1000000', 6)).toBe('1');
        expect(formatAtomicAmount('1500000', 6)).toBe('1.5');
        expect(formatAtomicAmount('1', 6)).toBe('0.000001');
        expect(formatAtomicAmount('0', 6)).toBe('0');
        expect(formatAtomicAmount(50000, 6)).toBe('0.05');
    });

    it('handles zero decimals and strips leading zeros', () => {
        expect(formatAtomicAmount('123', 0)).toBe('123');
        expect(formatAtomicAmount('000123', 0)).toBe('123');
        expect(formatAtomicAmount('0000', 0)).toBe('0');
    });

    it('does not survive a float or a non-integer string', () => {
        expect(formatAtomicAmount('12.5', 6)).toBeNull();
        expect(formatAtomicAmount(12.5, 6)).toBeNull();
        expect(formatAtomicAmount('abc', 6)).toBeNull();
        expect(formatAtomicAmount('-5', 6)).toBeNull();
        expect(formatAtomicAmount('50000', -1)).toBeNull();
        expect(formatAtomicAmount(null, 6)).toBeNull();
    });
});

describe('hashAgentProposalRequest', () => {
    it('is independent of object key order but preserves array order', () => {
        const first = hashAgentProposalRequest({ city: 'zagreb', nested: { b: 2, a: 1 }, parcels: ['A', 'B'] });
        const reordered = hashAgentProposalRequest({ parcels: ['A', 'B'], nested: { a: 1, b: 2 }, city: 'zagreb' });
        const changed = hashAgentProposalRequest({ city: 'zagreb', nested: { a: 1, b: 2 }, parcels: ['B', 'A'] });

        expect(first).toMatch(/^[a-f0-9]{64}$/);
        expect(reordered).toBe(first);
        expect(changed).not.toBe(first);
    });
});

describe('buildAgentStamp', () => {
    const payment = {
        id: 'proposal_1234567890abcdef',
        payer: 'PAYER111',
        transaction: 'SIG111',
        network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        amount: '0.05',
        amountAtomic: '50000'
    };

    it('keeps what the agent sent and stamps wallet and receipt from the settlement', () => {
        const stamp = buildAgentStamp({ persona: 'densifier-01', rationale: 'infill', run_id: 'r1' }, payment);
        expect(stamp).toEqual({
            persona: 'densifier-01',
            rationale: 'infill',
            run_id: 'r1',
            wallet: 'PAYER111',
            paid: { id: payment.id, network: payment.network, asset: payment.asset, amount: '0.05', amountAtomic: '50000', tx: 'SIG111' }
        });
    });

    it('overwrites a wallet or receipt the client tried to claim', () => {
        const stamp = buildAgentStamp({ wallet: 'FORGED', paid: { tx: 'FORGED' } }, payment);
        expect(stamp.wallet).toBe('PAYER111');
        expect(stamp.paid.tx).toBe('SIG111');
    });

    it('tolerates a missing or non-object agent field', () => {
        expect(buildAgentStamp(undefined, payment).wallet).toBe('PAYER111');
        expect(buildAgentStamp('nonsense', payment).wallet).toBe('PAYER111');
        expect(buildAgentStamp(['x'], payment).wallet).toBe('PAYER111');
    });
});
