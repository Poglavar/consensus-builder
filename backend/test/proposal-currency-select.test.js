// The offer currency in the create dialog (attachProposalCurrencyHandlers, proposals/chain.js): a
// connected Solana wallet adds SOL as a choice but never changes the currency already selected.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/chain.js', import.meta.url)), 'utf8');

function lift(name) {
    const start = source.indexOf(`function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\n}', start) + 2);
}

function selectWith(values, selected) {
    const options = values.map(value => ({ value, textContent: value }));
    const select = {
        options,
        value: selected,
        insertBefore(option, before) { options.splice(Math.max(0, options.indexOf(before)), 0, option); }
    };
    return select;
}

function attach(select, solanaConnected) {
    const document = { getElementById: id => (id === 'proposalCurrency' ? select : null), createElement: () => ({}) };
    const window = { solanaWalletManager: { getState: () => (solanaConnected ? { status: 'connected', accounts: ['wallet'] } : { status: 'disconnected', accounts: [] }) } };
    // eslint-disable-next-line no-new-func
    new Function('document', 'window', 'clearProposalBalanceWatcher', 'ensureProposalOfferBalanceElement',
        `${lift('attachProposalCurrencyHandlers')}; attachProposalCurrencyHandlers();`)(document, window, () => {}, () => null);
}

describe('attachProposalCurrencyHandlers', () => {
    it('keeps a chosen ETH offer and adds SOL beside it when a Solana wallet is connected', () => {
        const select = selectWith(['EUR', 'USD', 'ETH', 'USDT'], 'ETH');
        attach(select, true);
        expect(select.value).toBe('ETH');
        expect(select.options.map(o => o.value)).toEqual(['SOL', 'EUR', 'USD', 'ETH', 'USDT']);
    });

    it('does not reset a prefilled EUR offer to USDT', () => {
        const select = selectWith(['EUR', 'USD', 'ETH', 'USDT'], 'EUR');
        attach(select, false);
        expect(select.value).toBe('EUR');
        expect(select.options.map(o => o.value)).toEqual(['EUR', 'USD', 'ETH', 'USDT']);
    });

    it('adds SOL only once', () => {
        const select = selectWith(['SOL', 'USDT'], 'USDT');
        attach(select, true);
        expect(select.options.map(o => o.value)).toEqual(['SOL', 'USDT']);
    });
});
