// city-money.js — the currency money is counted in, and the price assumptions the models use, for
// the city on screen. Money belongs to the place, not to the viewer: a Birmingham parcel is valued
// in GBP and a Croatian offer is made in EUR whichever language and region the viewer picked (the
// viewer's locale only decides how the amount is written, js/format.js). Pure, UMD: in the browser
// it is window.CityMoney; backend/test/city-money.test.js runs it headlessly.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CityMoney = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // Codes that are chain tokens, not a country's money. Everything else with three letters is an
    // ISO 4217 currency (city-config.js `currency.code`).
    const TOKENS = Object.freeze(['ETH', 'SOL', 'USDC', 'USDT']);

    // Price assumptions per currency, each in that currency per square metre. They are model inputs,
    // not valuations; a null means there is no defensible figure, and the model says "unavailable"
    // instead of inventing one.
    // - landPerSqm: parcel land when the data carries no price (parcel panel, selection, readjustment).
    // - roadLandPerSqm: land taken by a drawn road (road acquisition model).
    // - salesPerSqm: the plan statistics' sales price default (the user edits it there).
    // EUR are the figures the app has used for its Croatian cities all along. GBP has no land figure: published
    // English land values (MHCLG "Land value estimates for policy appraisal") vary tenfold between
    // councils and are not market values, so one UK rate would be wrong almost everywhere. Its sales
    // default is the 3D panel's sale price (below).
    const ASSUMPTIONS = Object.freeze({
        EUR: Object.freeze({
            landPerSqm: 133,
            roadLandPerSqm: 100,
            salesPerSqm: 5000
        }),
        GBP: Object.freeze({
            landPerSqm: null,
            roadLandPerSqm: null,
            salesPerSqm: 4000
        })
    });
    // A city whose currency has no assumptions of its own keeps the EUR ones, and its figures say EUR.
    // The 3D value panel's two sliders: the sale price and the construction cost of a m² of floor
    // area, each with its default and range. The same numbers in every city, in that city's own
    // currency (the user's call, 2026-10-22: both are invented starting points the viewer moves).
    const DEFAULT_ASSUMPTION_CURRENCY = 'EUR';
    const FLOOR_AREA_PRICES = Object.freeze({
        sale: Object.freeze({ perSqm: 4000, min: 500, max: 15000, step: 100 }),
        construction: Object.freeze({ perSqm: 2000, min: 500, max: 8000, step: 100 })
    });

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

    // The price assumptions for a city, with the currency they are expressed in.
    function assumptionsFor(cityConfig) {
        const cityCurrency = currencyOf(cityConfig);
        const currency = cityCurrency && ASSUMPTIONS[cityCurrency] ? cityCurrency : DEFAULT_ASSUMPTION_CURRENCY;
        return Object.assign({ currency }, ASSUMPTIONS[currency]);
    }

    // The area-model options ParcelPriceModel.buildEstimate takes (financials.js): a rate in the
    // assumptions' currency, or no rate at all (the estimate is then "unavailable", never 0).
    // `kind` is 'land' (a parcel) or 'road' (land a drawn road takes).
    function landPriceOptions(cityConfig, kind = 'land') {
        const assumptions = assumptionsFor(cityConfig);
        const rate = kind === 'road' ? assumptions.roadLandPerSqm : assumptions.landPerSqm;
        return { areaPricePerSqm: typeof rate === 'number' ? rate : undefined, currency: assumptions.currency };
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
    function forCity(getCityConfig) {
        const city = () => {
            try { return getCityConfig() || null; } catch (_) { return null; }
        };
        return Object.freeze({
            // The city's currency, EUR when it declares none.
            currentCurrency: () => currencyOf(city()) || DEFAULT_ASSUMPTION_CURRENCY,
            currentAssumptions: () => assumptionsFor(city()),
            currentLandPriceOptions: kind => landPriceOptions(city(), kind),
            currentOfferCurrencies: current => offerCurrencies(city(), current),
            // The 3D panel's slider prices, in the city's currency.
            currentFloorAreaPrices: () => ({
                currency: currencyOf(city()) || DEFAULT_ASSUMPTION_CURRENCY,
                sale: Object.assign({}, FLOOR_AREA_PRICES.sale),
                construction: Object.assign({}, FLOOR_AREA_PRICES.construction)
            })
        });
    }

    const browserCity = forCity(() => {
        const manager = typeof window !== 'undefined' ? window.CityConfigManager : null;
        return manager && typeof manager.getCurrentCityConfig === 'function' ? manager.getCurrentCityConfig() : null;
    });

    return Object.freeze(Object.assign({
        TOKENS,
        ASSUMPTIONS,
        FLOOR_AREA_PRICES,
        isFiat,
        currencyOf,
        assumptionsFor,
        landPriceOptions,
        offerCurrencies,
        forCity
    }, browserCity));
});
