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
    const ukLandRates = () => (root && root.UkLandRates)
        || (typeof require === 'function' ? require('./uk-land-rates.js') : null);
    function ratesFor(cityConfig, override = null) {
        const api = economicSources();
        const table = ukLandRates();
        const sources = cityConfig?.economics?.sources || api.defaults(cityConfig, table);
        return api.resolve(override ? [override, ...sources] : sources, { city: cityConfig, ukLandRates: table });
    }
    function assumptionsFor(cityConfig, override = null) {
        const rates = ratesFor(cityConfig, override);
        return { currency: currencyOf(cityConfig) || DEFAULT_ASSUMPTION_CURRENCY,
            landPerSqm: rates.land?.amount ?? null, roadLandPerSqm: rates.roadLand?.amount ?? null,
            salesPerSqm: rates.sale?.amount ?? null, constructionPerSqm: rates.construction?.amount ?? null, sources: rates };
    }

    // What new floor area is worth at two prices per m² of floor, in one currency: its value (floor
    // area × sale price), its construction cost (floor area × construction cost) and its profit
    // (value − construction cost − the value of the floor area it replaces, at the same sale price).
    // A missing price or area keeps every amount that depends on it unknown (null), never 0. The 3D
    // panel (gain.js), Plan stats and the MCP comparison all count with this.
    function newBuildMoney({ floorAreaM2, replacedFloorAreaM2 = null, salePerM2, constructionPerM2 } = {}) {
        const amount = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
        const area = amount(floorAreaM2), replaced = amount(replacedFloorAreaM2);
        const sale = amount(salePerM2), cost = amount(constructionPerM2);
        const value = area === null || sale === null ? null : area * sale;
        const constructionCost = area === null || cost === null ? null : area * cost;
        const replacedValue = replaced === null || sale === null ? null : replaced * sale;
        const profit = value === null || constructionCost === null || replacedValue === null
            ? null : value - constructionCost - replacedValue;
        return { value, constructionCost, replacedValue, profit };
    }

    // Parcel and road estimates retain the selected observation, including its unit and provenance.
    function landPriceOptions(cityConfig, kind = 'land', override = null) {
        const observation = ratesFor(cityConfig, override)[kind === 'road' ? 'roadLand' : 'land'];
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
            currentAssumptions: () => assumptionsFor(city(), getOverride(city())),
            currentEconomicRates: () => ratesFor(city(), getOverride(city())),
            currentLandPriceOptions: kind => landPriceOptions(city(), kind, getOverride(city())),
            currentOfferCurrencies: current => offerCurrencies(city(), current),
            // Not city-specific; every city's view carries it so its consumers need only that view.
            newBuildMoney,
            // The 3D panel's slider prices, in the city's currency.
            currentFloorAreaPrices: () => {
                const rates = ratesFor(city(), getOverride(city()));
                return {
                    currency: currencyOf(city()) || DEFAULT_ASSUMPTION_CURRENCY,
                    sourceKey: JSON.stringify(rates), sources: rates,
                    sale: economicSources().slider('sale', rates.sale),
                    construction: economicSources().slider('construction', rates.construction)
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
