import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const {
    calculateModeledTotalEth, getPortfolioValuationBasis, areaToEth,
    buildParcelPriceEstimate, aggregateParcelPriceEstimates
} = require('../../frontend/js/financials.js');
const financialSource = readFileSync(new URL('../../frontend/js/financials.js', import.meta.url), 'utf8');
const userSource = readFileSync(new URL('../../frontend/js/user-management.js', import.meta.url), 'utf8');
const walletDisplaySource = userSource.slice(userSource.indexOf('function setUserTotalWealthDisplay('), userSource.indexOf('\nasync function readConnectedWalletEthBalance('));

describe('modeled ETH totals', () => {
    it.each([null, undefined, NaN, Infinity, -1, '2'])('keeps an unavailable or invalid component unknown: %s', missing => {
        expect(calculateModeledTotalEth(5, missing)).toBeNull();
        expect(calculateModeledTotalEth(missing, 5)).toBeNull();
    });

    it('distinguishes a real zero holding from an unknown value', () => {
        expect(calculateModeledTotalEth(5, 0)).toBe(5);
        expect(calculateModeledTotalEth(0, 0)).toBe(0);
        expect(calculateModeledTotalEth(5, 2)).toBe(7);
    });

    it('uses the stated area price and ETH conversion estimate', () => {
        const basis = getPortfolioValuationBasis({ usdPerEth: 4000 });
        expect(basis).toMatchObject({
            pricePerSqmUsd: 200, usdPerEth: 4000, areaUnit: 'm²', inputCurrency: 'USD', outputCurrency: 'ETH'
        });
        expect(areaToEth(100, basis)).toBe(5);
    });

    it('uses a source estimate only when it carries its own currency', () => {
        expect(buildParcelPriceEstimate({ estimatedMarketPrice: 500, currency: 'USD' }, 20))
            .toMatchObject({ amount: null, currency: null, basis: 'unusable-source-estimate' });
        expect(buildParcelPriceEstimate({ estimatedMarketPrice: '500', estimatedMarketPriceCurrency: ' usd ' }, 20))
            .toEqual({ amount: 500, currency: 'USD', basis: 'source-estimate', rate: null });
    });

    it('labels a fallback as a separate area model with explicit units and currency', () => {
        expect(buildParcelPriceEstimate({}, 20, { areaPricePerSqm: 133, currency: 'EUR' }))
            .toEqual({ amount: 2660, currency: 'EUR', basis: 'area-model', rate: 133 });
        expect(buildParcelPriceEstimate({}, null, { areaPricePerSqm: 133, currency: 'EUR' }).amount).toBeNull();
    });

    it('refuses incomplete or mixed-currency aggregates and identifies combined estimate bases', () => {
        const eurSource = { amount: 100, currency: 'EUR', basis: 'source-estimate' };
        const eurModel = { amount: 50, currency: 'EUR', basis: 'area-model' };
        expect(aggregateParcelPriceEstimates([eurSource, { amount: 25, currency: 'EUR', basis: 'source-estimate' }], 2))
            .toMatchObject({ amount: 125, currency: 'EUR', basis: 'source-estimate' });
        expect(aggregateParcelPriceEstimates([eurSource, eurModel], 2))
            .toMatchObject({ amount: 150, currency: 'EUR', basis: 'combined-estimates' });
        expect(aggregateParcelPriceEstimates([eurSource, { amount: 100, currency: 'USD', basis: 'source-estimate' }], 2).basis)
            .toBe('mixed-currency');
        expect(aggregateParcelPriceEstimates([
            { amount: Number.MAX_VALUE, currency: 'EUR' }, { amount: Number.MAX_VALUE, currency: 'EUR' }
        ], 2).basis).toBe('invalid-total');
        expect(aggregateParcelPriceEstimates([eurSource], 2).basis).toBe('incomplete');
        expect(aggregateParcelPriceEstimates([eurSource, { amount: null, currency: null }], 2).basis)
            .toBe('unknown-component');
    });

    it('does not turn an incomplete actual portfolio calculation into a balance-only total', async () => {
        const context = vm.createContext({
            console: { warn: vi.fn(), log: vi.fn() },
            getParcelAreaById: id => id === 'known' ? 100 : null,
            CadastralParcelRepository: { ensureIds: vi.fn(async () => {}) }
        });
        vm.runInContext(financialSource, context);
        const portfolio = await context.calculatePortfolioValue(['known', 'missing']);
        expect(portfolio).toBeNaN();
        expect(calculateModeledTotalEth(5, portfolio)).toBeNull();
    });
});

describe('wallet total display', () => {
    it('requires both the wallet balance and a known portfolio, while preserving zero', () => {
        let attribute = null;
        const node = { textContent: 'stale total', getAttribute: () => attribute };
        const context = vm.createContext({
            document: { querySelector: () => node }, calculateModeledTotalEth,
            CbFormat: { formatMoney: (amount, currency) => `${amount} ${currency}` }
        });
        vm.runInContext(walletDisplaySource, context);
        for (const value of [null, '', ' ', 'NaN']) {
            attribute = value;
            context.setUserTotalWealthDisplay(5);
            expect(node.textContent).toBe('-');
        }
        attribute = '0';
        context.setUserTotalWealthDisplay(5);
        expect(node.textContent).toBe('5 ETH');
        attribute = '2';
        context.setUserTotalWealthDisplay(5);
        expect(node.textContent).toBe('7 ETH');
        context.setUserTotalWealthDisplay(NaN);
        expect(node.textContent).toBe('-');
    });
});
