// Unit tests for utils/x402-payment.js — the pure half of the pay-to-post gate: config reading,
// exact atomic→decimal formatting, agent-path detection and the agent stamp.
import { describe, it, expect } from 'vitest';
import {
    buildAgentStamp,
    formatAtomicAmount,
    isAgentPath,
    readX402Config,
    X402_ENV_NAMES
} from '../utils/x402-payment.js';

const FULL_ENV = {
    X402_NETWORK: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    X402_FACILITATOR_URL: 'https://x402.org/facilitator',
    X402_PAY_TO: 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ',
    X402_PRICE_PROPOSAL: '$0.05'
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

    it('reads exactly the documented variable names', () => {
        expect(X402_ENV_NAMES).toEqual(['X402_NETWORK', 'X402_FACILITATOR_URL', 'X402_PAY_TO', 'X402_PRICE_PROPOSAL']);
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

describe('buildAgentStamp', () => {
    const payment = {
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
            paid: { network: payment.network, asset: payment.asset, amount: '0.05', amountAtomic: '50000', tx: 'SIG111' }
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
