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
const EconomicSources = require('../../frontend/js/economic-sources.js');
const UkEconomicAreas = require('../../frontend/data/uk-economic-areas.js');
// A point, [lng, lat], in Birmingham city centre (Birmingham City Council, E08000025).
const BIRMINGHAM_CENTRE = [-1.8904, 52.4862];
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
    it('gives a UK place its own authority land rate in pounds', () => {
        const a = CityMoney.assumptionsFor(birmingham, null, BIRMINGHAM_CENTRE);
        expect(a).toMatchObject({ currency: 'GBP', landPerSqm: 688, roadLandPerSqm: 688, salesPerSqm: 4000 });
        expect(UkLandRates.cities.birmingham).toBe('E08000025');
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

    // The table is generated from data/city-configs.js: every UK city whose centre lies in an English
    // authority with an estimate has that authority for when a location gives none; the others none.
    it('knows the authority of every English city in the config', () => {
        const ukCities = [...cityConfigSource.matchAll(/\n {12}id: '([^']+)'[^\n]*\n {12}label: [^\n]*\n {12}currency: \{ locale: '[^']+', code: 'GBP' \},(?:\n {12}\/\/[^\n]*)*(?:\n {12}economics: [\s\S]*?)?\n {12}map: \{[^]*?defaultCenter: \[(-?[\d.]+), (-?[\d.]+)\]/g)]
            .map(m => ({ id: m[1], centre: [Number(m[3]), Number(m[2])] }));
        expect(ukCities.length).toBeGreaterThan(100);
        const outside = ukCities.filter(city => !UkLandRates.cities[city.id]);
        expect(outside.length).toBeLessThan(10);
        // Outside England, or in an authority MHCLG gives no estimate for (Cumberland).
        for (const city of outside) expect(UkLandRates.authorities[EconomicSources.areaAt(UkEconomicAreas, 'lad', city.centre)?.id], city.id).toBeUndefined();
        for (const city of ukCities.filter(row => UkLandRates.cities[row.id])) expect(UkLandRates.authorities[UkLandRates.cities[city.id]], city.id).toBeTruthy();
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

describe('new floor area: value, all-in cost, profit and rent', () => {
    const { newBuildMoney } = CityMoney;
    // 1,000 m² of floor on 500 m² of land, replacing 200 m²: sale 4,000, construction 2,000, land 300.
    const base = { floorAreaM2: 1000, replacedFloorAreaM2: 200, landAreaM2: 500, salePerM2: 4000, constructionPerM2: 2000,
        landPerM2: 300, saleTaxShare: 0.25, rentPerM2Month: 15 };

    it('charges construction, the land, the sale tax inside the value and the value it replaces', () => {
        const money = newBuildMoney(base);
        expect(money).toMatchObject({ value: 4000000, constructionCost: 2000000, landCost: 150000, replacedValue: 800000 });
        expect(money.saleTax).toBeCloseTo(4000000 * 0.25 / 1.25);
        expect(money.totalCost).toBeCloseTo(2000000 + 150000 + 800000 + 800000);
        expect(money.profit).toBeCloseTo(4000000 - money.totalCost);
    });

    it('rents it by the month and yields the rent on the cost without the sale tax', () => {
        const money = newBuildMoney(base);
        expect(money.annualRent).toBe(1000 * 15 * 12);
        expect(money.rentYieldOnCost).toBeCloseTo(180000 / (2000000 + 150000 + 800000));
        // Nothing spent: no yield, rather than an infinite one.
        expect(newBuildMoney({ ...base, replacedFloorAreaM2: 0, constructionPerM2: 0, landPerM2: 0 }).rentYieldOnCost).toBeNull();
    });

    it('keeps what depends on a missing price or area unknown instead of counting it as zero', () => {
        const noLand = newBuildMoney({ ...base, landPerM2: null });
        expect(noLand).toMatchObject({ value: 4000000, constructionCost: 2000000, landCost: null, totalCost: null, profit: null, rentYieldOnCost: null });
        expect(noLand.annualRent).toBe(180000);
        expect(newBuildMoney({ ...base, saleTaxShare: null })).toMatchObject({ saleTax: null, totalCost: null, profit: null });
        expect(newBuildMoney({ ...base, saleTaxShare: null }).rentYieldOnCost).not.toBeNull();
        expect(newBuildMoney({ ...base, landAreaM2: null }).totalCost).toBeNull();
        expect(newBuildMoney({ ...base, replacedFloorAreaM2: null }).profit).toBeNull();
        expect(newBuildMoney({ ...base, floorAreaM2: null })).toMatchObject({ value: null, constructionCost: null, annualRent: null, profit: null });
        expect(newBuildMoney({ ...base, salePerM2: -1 }).value).toBeNull();
        // A tax share of 1 or more is no tax share.
        expect(newBuildMoney({ ...base, saleTaxShare: 1 }).saleTax).toBeNull();
    });

    it('is on every city view, which is what the dialogs and the MCP hold', () => {
        expect(CityMoney.forCity(() => birmingham).newBuildMoney).toBe(newBuildMoney);
    });

    it('takes the tax on a tax-inclusive construction cost off the all-in cost of a sale, not off the rent yield', () => {
        const exclusive = newBuildMoney(base);
        const inclusive = newBuildMoney({ ...base, constructionTaxIncluded: true });
        expect(exclusive.taxReclaimed).toBe(0);
        expect(inclusive.taxReclaimed).toBeCloseTo(2000000 * 0.25 / 1.25);
        expect(inclusive.totalCost).toBeCloseTo(exclusive.totalCost - 400000);
        expect(inclusive.profit).toBeCloseTo(exclusive.profit + 400000);
        // A landlord who charges no tax on the rent reclaims none.
        expect(inclusive.rentYieldOnCost).toBe(exclusive.rentYieldOnCost);
        // Unknown while the tax or the construction cost is, never 0.
        expect(newBuildMoney({ ...base, constructionTaxIncluded: true, saleTaxShare: null })).toMatchObject({ taxReclaimed: null, totalCost: null });
        expect(newBuildMoney({ ...base, constructionTaxIncluded: true, constructionPerM2: null })).toMatchObject({ taxReclaimed: null, profit: null });
    });
});
