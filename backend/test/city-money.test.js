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
const cityConfigSource = require('node:fs').readFileSync(new URL('../../frontend/js/city-config.js', import.meta.url), 'utf8');
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
    });

    it('falls back to the England median for a UK city the table does not know', () => {
        expect(CityMoney.assumptionsFor({ id: 'not-in-table', currency: { code: 'GBP' } }).landPerSqm).toBe(UkLandRates.englandMedianPerSqm);
    });

    // The table is generated from city-config.js; a UK city added without rebuilding it would
    // silently take the England median.
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

    it('keeps the euro figures for a euro city', () => {
        expect(CityMoney.assumptionsFor(croatian)).toMatchObject({ currency: 'EUR', landPerSqm: 133, roadLandPerSqm: 100, salesPerSqm: 5000 });
    });

    it('labels borrowed assumptions with the currency they are in', () => {
        expect(CityMoney.assumptionsFor(mumbai).currency).toBe('EUR');
    });
});

describe('land estimates', () => {
    it('prices a UK parcel by area in pounds at its authority rate', () => {
        expect(buildParcelPriceEstimate({}, 500, CityMoney.landPriceOptions(birmingham, 'land')))
            .toEqual({ amount: 344000, currency: 'GBP', basis: 'area-model', rate: 688 });
    });

    it('prices a Croatian parcel by area in euros, and road land at its own rate', () => {
        expect(buildParcelPriceEstimate({}, 500, CityMoney.landPriceOptions(croatian, 'land')))
            .toEqual({ amount: 66500, currency: 'EUR', basis: 'area-model', rate: 133 });
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
