// The city's money (frontend/js/city-money.js): amounts are counted in the currency of the place
// they belong to, never the viewer's, and a price model without a defensible figure for that
// currency says so instead of borrowing the euro one.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CityMoney = require('../../frontend/js/city-money.js');
const { buildParcelPriceEstimate } = require('../../frontend/js/financials.js');

const birmingham = { id: 'birmingham', currency: { locale: 'en-GB', code: 'GBP' } };
const UkLandRates = require('../../frontend/js/uk-land-rates.js');
const cityConfigSource = require('node:fs').readFileSync(new URL('../../frontend/data/city-configs.js', import.meta.url), 'utf8');
const croatian = { currency: { locale: 'hr-HR', code: 'EUR' } };
const mumbai = { currency: { locale: 'en-IN', code: 'INR' } };

describe('fiat and tokens', () => {
    it('treats ISO currencies as money and chain tokens as not', () => {
        expect(['GBP', 'EUR', 'usd', 'INR'].map(CityMoney.isFiat)).toEqual([true, true, true, true]);
        expect(['ETH', 'SOL', 'USDC', 'USDT', '', null, 'EURO'].map(CityMoney.isFiat)).toEqual([false, false, false, false, false, false, false]);
    });

    it('reads a city currency only when it is fiat', () => {
        expect(CityMoney.currencyOf(birmingham)).toBe('GBP');
        expect(CityMoney.currencyOf({ currency: { code: 'ETH' } })).toBeNull();
        expect(CityMoney.currencyOf(null)).toBeNull();
    });
});

describe('price assumptions follow the city currency', () => {
    // MHCLG 2023 residential land, medium density at the median house price: Birmingham £6.88m/ha.
    it('gives a UK city its own authority land rate in pounds', () => {
        const a = CityMoney.assumptionsFor(birmingham);
        expect(a).toMatchObject({ currency: 'GBP', landPerSqm: 688, roadLandPerSqm: 688, salesPerSqm: 4000 });
        expect(UkLandRates.cities.birmingham).toMatchObject({ authority: 'E08000025', basis: 'authority' });
        expect(a.sources.land).toMatchObject({
            amount: 688, unit: 'm2-land', currency: 'GBP', basis: 'policy-appraisal', asOf: '2023-10-01',
            sourceId: 'uk-mhclg-land-2023', scope: 'E08000025 · Birmingham'
        });
    });

    it('does not use the England median as an unknown city local rate', () => {
        const assumptions = CityMoney.assumptionsFor({ id: 'not-in-table', currency: { code: 'GBP' } });
        expect(assumptions.landPerSqm).toBeNull();
        expect(assumptions.roadLandPerSqm).toBeNull();
        expect(assumptions.sources).not.toHaveProperty('land');
    });

    // The table is generated from data/city-configs.js; rebuilding it keeps each configured authority's
    // evidence available. Median placeholders are retained as input metadata, not local rates.
    it('has a land rate for every UK city in the config', () => {
        const ukCities = [...cityConfigSource.matchAll(/\n {12}id: '([^']+)'[^\n]*\n {12}label: [^\n]*\n {12}currency: \{ locale: '[^']+', code: 'GBP' \}/g)].map(m => m[1]);
        expect(ukCities.length).toBeGreaterThan(100);
        expect(ukCities.filter(id => !UkLandRates.cities[id])).toEqual([]);
    });

    // The 3D panel's two sliders start at the same figures in every city, in its own currency.
    it('starts the 3D sale price at 4,000 and the construction cost at 2,000 of the local currency', () => {
        for (const [city, currency] of [[birmingham, 'GBP'], [croatian, 'EUR'], [mumbai, 'INR']]) {
            const prices = CityMoney.forCity(() => city).currentFloorAreaPrices();
            expect(prices.currency).toBe(currency);
            expect(prices.sale.perSqm).toBe(4000);
            expect(prices.construction.perSqm).toBe(2000);
        }
    });

    it('keeps euro land assumptions and uses the 4,000 plan-statistics sales default', () => {
        expect(CityMoney.assumptionsFor(croatian)).toMatchObject({ currency: 'EUR', landPerSqm: 133, roadLandPerSqm: 100, salesPerSqm: 4000 });
    });

    it('does not borrow euro land assumptions for INR and keeps the local currency', () => {
        const assumptions = CityMoney.assumptionsFor(mumbai);
        expect(assumptions).toMatchObject({ currency: 'INR', landPerSqm: null, roadLandPerSqm: null, salesPerSqm: 4000 });
        expect(CityMoney.landPriceOptions(mumbai)).toMatchObject({ currency: 'INR', economicSource: null });
        expect(buildParcelPriceEstimate({}, 500, CityMoney.landPriceOptions(mumbai)).basis).toBe('unavailable');
        expect(CityMoney.forCity(() => mumbai).currentFloorAreaPrices()).toMatchObject({ currency: 'INR', sale: { perSqm: 4000 }, construction: { perSqm: 2000 } });
    });
});

describe('land estimates', () => {
    it('prices a UK parcel by area in pounds at its authority rate', () => {
        const options = CityMoney.landPriceOptions(birmingham, 'land');
        expect(buildParcelPriceEstimate({}, 500, options))
            .toEqual({ amount: 344000, currency: 'GBP', basis: 'area-model', rate: 688, economicSource: options.economicSource });
    });

    it('prices a Croatian parcel by area in euros, and road land at its own rate', () => {
        const options = CityMoney.landPriceOptions(croatian, 'land');
        expect(buildParcelPriceEstimate({}, 500, options))
            .toEqual({ amount: 66500, currency: 'EUR', basis: 'area-model', rate: 133, economicSource: options.economicSource });
        expect(buildParcelPriceEstimate({}, 500, CityMoney.landPriceOptions(croatian, 'road')).amount).toBe(50000);
    });

    it('keeps a source price in its own currency whatever the city', () => {
        const estimate = buildParcelPriceEstimate({ estimatedMarketPrice: 250000, estimatedMarketPriceCurrency: 'GBP' }, 500,
            CityMoney.landPriceOptions(birmingham, 'land'));
        expect(estimate).toMatchObject({ amount: 250000, currency: 'GBP', basis: 'source-estimate' });
    });

    it('refuses a null rate instead of pricing the land at zero', () => {
        expect(buildParcelPriceEstimate({}, 500, { areaPricePerSqm: null, currency: 'GBP' }).basis).toBe('unavailable');
    });
});

describe('offer currencies', () => {
    it('lists the city money first and keeps a stored currency', () => {
        expect(CityMoney.offerCurrencies(birmingham)).toEqual(['GBP', 'EUR', 'USD', 'ETH', 'ARS', 'USDC', 'USDT']);
        expect(CityMoney.offerCurrencies(croatian)).toEqual(['EUR', 'USD', 'ETH', 'ARS', 'USDC', 'USDT']);
        expect(CityMoney.offerCurrencies(croatian, 'gbp')).toEqual(['EUR', 'USD', 'ETH', 'ARS', 'USDC', 'USDT', 'GBP']);
    });
});
