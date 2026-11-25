// city-money.js — the currency money is counted in, and the price assumptions the models use, for
// the city on screen. Money belongs to the place, not to the viewer: a Birmingham parcel is valued
// in GBP and a Croatian offer is made in EUR whichever language and region the viewer picked (the
// viewer's locale only decides how the amount is written, js/format.js). Pure, UMD: in the browser
// it is window.CityMoney; backend/test/city-money.test.js runs it headlessly.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CityMoney = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    // Codes that are chain tokens, not a country's money. Everything else with three letters is an
    // ISO 4217 currency (city-config.js `currency.code`).
    const TOKENS = Object.freeze(['ETH', 'SOL', 'USDC', 'USDT']);

    // Rate evidence and editable assumptions share one adapter contract, with separate metrics.
    const economicSources = () => (root && root.EconomicSources)
        || (typeof require === 'function' ? require('./economic-sources.js') : null);
    const DEFAULT_ASSUMPTION_CURRENCY = 'EUR';
    const FLOOR_AREA_PRICES = economicSources().FLOOR_PRICES;

    function normalizeCode(code) {
        if (typeof code !== 'string') return null;
        const normalized = code.trim().toUpperCase();
        return /^[A-Z][A-Z0-9]{1,7}$/.test(normalized) ? normalized : null;
    }

    // A country's money (ISO 4217, three letters), not a chain token.
    function isFiat(code) {
        const normalized = normalizeCode(code);
        return Boolean(normalized) && /^[A-Z]{3}$/.test(normalized) && !TOKENS.includes(normalized);
    }

    // The currency a city counts money in, from its config; null when it declares none.
    function currencyOf(cityConfig) {
        const code = normalizeCode(cityConfig && cityConfig.currency && cityConfig.currency.code);
        return code && isFiat(code) ? code : null;
    }

    // The frontend owns selection. No backend infers a rate provider from a currency or city.
    // The area rate tables by id (scripts/lib/area_rate_table.py): in the browser each registers itself
    // in window.EconomicAreaRates (index.html loads them); under node they are required here.
    const AREA_RATE_FILES = ['./uk-land-rates.js', './uk-private-rents.js', './uk-building-safety-levy.js', './uk-gla-value-bands.js'];
    let nodeAreaRates = null;
    const areaRates = () => (root ? root.EconomicAreaRates || {}
        : nodeAreaRates || (nodeAreaRates = Object.fromEntries(AREA_RATE_FILES.map(file => require(file)).map(table => [table.id, table]))));
    // The areas those tables are published for: in the browser data/uk-economic-areas.js, which
    // city-config.js loads for a city a table names; under node read on first use.
    const areas = () => (root ? root.UkEconomicAreas || null
        : typeof require === 'function' ? require('../data/uk-economic-areas.js') : null);
    // `at` is the location the rates are for, [lng, lat]: a plan's land, a parcel, a design's site.
    // Rates published per area (UK local authority land values and rents, London value bands) follow
    // it; without it they are the city's own, and their scope says so.
    function ratesFor(cityConfig, override = null, at = null) {
        const api = economicSources();
        const tables = areaRates();
        const sources = cityConfig?.economics?.sources || api.defaults(cityConfig, tables, areas());
        const context = { city: cityConfig, areaRates: tables, at, get areas() { return areas(); } };
        return api.resolve(override ? [override, ...sources] : sources, context);
    }
    function assumptionsFor(cityConfig, override = null, at = null) {
        const rates = ratesFor(cityConfig, override, at);
        return { currency: currencyOf(cityConfig) || DEFAULT_ASSUMPTION_CURRENCY,
            landPerSqm: rates.land?.amount ?? null, roadLandPerSqm: rates.roadLand?.amount ?? null,
            salesPerSqm: rates.sale?.amount ?? null, constructionPerSqm: rates.construction?.amount ?? null,
            rentPerSqmMonth: rates.rent?.amount ?? null, saleTaxShare: rates.saleTax?.amount ?? null,
            devChargePerSqm: rates.devCharge?.amount ?? null,
            constructionTaxIncluded: rates.construction?.taxIncluded === true, sources: rates };
    }

    // What new floor area is worth, and costs, in one currency. Value is floor area × sale price (the
    // price as quoted, tax included). The all-in cost is the construction (floor area × construction
    // cost), the development charge (floor area × the place's charge per m² of new floor area), the land
    // (land area × land price per m² of land), the sale tax inside the value (value × saleTax ÷ (1 +
    // saleTax)) and the value of the existing floor area it replaces at the sale price.
    // When the construction cost includes that tax on its inputs (`constructionTaxIncluded`, from the
    // rate's `taxIncluded`), the developer reclaims it from the tax on the sale: the all-in cost is less
    // `taxReclaimed` (construction × saleTax ÷ (1 + saleTax)); otherwise nothing is reclaimed (0).
    // Profit is value − all-in cost. Annual rent is floor area × monthly rent × 12, and its yield is
    // on the construction, development charge, land and replaced value: a landlord who charges no tax on the rent and
    // reclaims none. A missing price or area keeps every amount that depends on it unknown (null),
    // never 0. The 3D panel (gain.js), Plan stats and the MCP comparison count with this.
    function newBuildMoney({ floorAreaM2, replacedFloorAreaM2 = null, landAreaM2 = null, salePerM2, constructionPerM2,
        landPerM2 = null, saleTaxShare = null, constructionTaxIncluded = false, rentPerM2Month = null, devChargePerM2 = 0 } = {}) {
        const amount = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
        const times = (a, b) => (a === null || b === null ? null : a * b);
        const sum = parts => (parts.some(part => part === null) ? null : parts.reduce((total, part) => total + part, 0));
        const area = amount(floorAreaM2), replaced = amount(replacedFloorAreaM2), landArea = amount(landAreaM2);
        const sale = amount(salePerM2), cost = amount(constructionPerM2), land = amount(landPerM2), rent = amount(rentPerM2Month);
        const charge = amount(devChargePerM2);
        const tax = amount(saleTaxShare) !== null && saleTaxShare < 1 ? saleTaxShare : null;
        const value = times(area, sale);
        const constructionCost = times(area, cost);
        const devCharge = times(area, charge);
        const landCost = times(landArea, land);
        const saleTax = value === null || tax === null ? null : value * tax / (1 + tax);
        const replacedValue = times(replaced, sale);
        const taxReclaimed = constructionTaxIncluded !== true ? 0
            : constructionCost === null || tax === null ? null : constructionCost * tax / (1 + tax);
        const buildCost = sum([constructionCost, devCharge, landCost, replacedValue]);
        const taxed = sum([buildCost, saleTax, taxReclaimed]);
        const totalCost = taxed === null ? null : buildCost + saleTax - taxReclaimed;
        const profit = value === null || totalCost === null ? null : value - totalCost;
        const annualRent = area === null || rent === null ? null : area * rent * 12;
        const rentYieldOnCost = annualRent === null || buildCost === null || buildCost <= 0 ? null : annualRent / buildCost;
        return { value, constructionCost, devCharge, landCost, saleTax, taxReclaimed, replacedValue, totalCost, profit, annualRent, rentYieldOnCost };
    }

    // Parcel and road estimates retain the selected observation, including its unit and provenance.
    function landPriceOptions(cityConfig, kind = 'land', override = null, at = null) {
        const observation = ratesFor(cityConfig, override, at)[kind === 'road' ? 'roadLand' : 'land'];
        return { areaPricePerSqm: observation?.amount, currency: currencyOf(cityConfig), economicSource: observation || null };
    }

    // The currencies an offer can be made in: the city's own money first, the general ones, the chain
    // tokens, and `current` (a stored offer's currency) when it is none of those.
    const GENERAL_OFFER_CURRENCIES = Object.freeze(['EUR', 'USD', 'ETH', 'ARS', 'USDC', 'USDT']);
    function offerCurrencies(cityConfig, current) {
        const list = [currencyOf(cityConfig), ...GENERAL_OFFER_CURRENCIES, normalizeCode(current)].filter(Boolean);
        return [...new Set(list)];
    }

    // The current-city view of all this: `getCityConfig` returns the city on screen. The browser
    // instance reads CityConfigManager; a test binds its own city.
    function forCity(getCityConfig, getOverride = () => null) {
        const city = () => {
            try { return getCityConfig() || null; } catch (_) { return null; }
        };
        return Object.freeze({
            // The city's currency, EUR when it declares none.
            currentCurrency: () => currencyOf(city()) || DEFAULT_ASSUMPTION_CURRENCY,
            // Each takes the location, [lng, lat], the rates are for (see ratesFor).
            currentAssumptions: (at = null) => assumptionsFor(city(), getOverride(city()), at),
            currentEconomicRates: (at = null) => ratesFor(city(), getOverride(city()), at),
            currentLandPriceOptions: (kind, at = null) => landPriceOptions(city(), kind, getOverride(city()), at),
            currentOfferCurrencies: current => offerCurrencies(city(), current),
            // Not city-specific; every city's view carries it so its consumers need only that view.
            newBuildMoney,
            // The 3D panel's slider prices, in the city's currency.
            currentFloorAreaPrices: (at = null) => {
                const rates = ratesFor(city(), getOverride(city()), at);
                return {
                    currency: currencyOf(city()) || DEFAULT_ASSUMPTION_CURRENCY,
                    sourceKey: JSON.stringify(rates), sources: rates,
                    sale: economicSources().slider('sale', rates.sale),
                    // A slid construction cost keeps the tax basis of the rate it starts from.
                    construction: { ...economicSources().slider('construction', rates.construction),
                        taxIncluded: rates.construction?.taxIncluded === true },
                    // No land price: its range follows the size of the city's money (its sale price).
                    land: economicSources().slider('land', rates.land, (rates.sale?.amount ?? 0) / FLOOR_AREA_PRICES.sale.perSqm),
                    saleTax: economicSources().slider('saleTax', rates.saleTax),
                    // Like land, a charge's range follows the size of the city's money.
                    devCharge: economicSources().slider('devCharge', rates.devCharge, (rates.sale?.amount ?? 0) / FLOOR_AREA_PRICES.sale.perSqm),
                    rent: economicSources().slider('rent', rates.rent)
                };
            }
        });
    }

    const browserCity = forCity(() => {
        const manager = typeof window !== 'undefined' ? window.CityConfigManager : null;
        return manager && typeof manager.getCurrentCityConfig === 'function' ? manager.getCurrentCityConfig() : null;
    }, city => root?.EconomicSourceSettings?.choiceForCity(city?.id, root) || null);

    return Object.freeze(Object.assign({
        TOKENS,
        FLOOR_AREA_PRICES,
        isFiat,
        currencyOf,
        ratesFor,
        assumptionsFor,
        landPriceOptions,
        offerCurrencies,
        forCity
    }, browserCity));
});
