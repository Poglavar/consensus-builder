// Local economic overrides are isolated by place and validated before replacing saved evidence.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const EconomicSourceSettings = require('../../frontend/js/economic-source-settings.js');
const EconomicSources = require('../../frontend/js/economic-sources.js');

const descriptor = (id, currency = 'GBP', amount = 700) => ({
    version: 1, id, name: `Local ${id}`, adapter: 'rate-table',
    rates: [{ metric: 'land', unit: 'm2-land', amount, currency, basis: 'assumption' }]
});
function store() {
    const values = new Map();
    return {
        values,
        localStorage: {
            getItem: key => values.get(key) ?? null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: key => values.delete(key)
        },
        EconomicSources
    };
}

describe('economic source settings storage', () => {
    it('saves, reads, and resets choices independently for each city', () => {
        const global = store();
        const birmingham = { id: 'birmingham', currency: { code: 'GBP' } };
        const bristol = { id: 'bristol', currency: { code: 'GBP' } };
        EconomicSourceSettings.saveChoice(birmingham, descriptor('birmingham-rates', 'GBP', 710), global);
        EconomicSourceSettings.saveChoice(bristol, descriptor('bristol-rates', 'GBP', 820), global);
        expect(EconomicSourceSettings.choiceForCity('birmingham', global).rates[0].amount).toBe(710);
        expect(EconomicSourceSettings.choiceForCity('bristol', global).rates[0].amount).toBe(820);

        EconomicSourceSettings.resetChoice('birmingham', global);
        expect(EconomicSourceSettings.choiceForCity('birmingham', global)).toBeNull();
        expect(EconomicSourceSettings.choiceForCity('bristol', global).rates[0].amount).toBe(820);
    });

    it('refuses a currency mismatch before replacing the saved choice', () => {
        const global = store();
        const city = { id: 'birmingham', currency: { code: 'GBP' } };
        EconomicSourceSettings.saveChoice(city, descriptor('valid', 'GBP', 710), global);
        expect(() => EconomicSourceSettings.saveChoice(city, descriptor('wrong-currency', 'EUR', 900), global))
            .toThrow(/currency differs/);
        expect(EconomicSourceSettings.choiceForCity(city.id, global)).toMatchObject({ id: 'valid', rates: [{ amount: 710, currency: 'GBP' }] });
    });

    it('surfaces corrupt or invalid stored evidence instead of silently defaulting', () => {
        const global = store();
        global.localStorage.setItem('cb_economic_source:birmingham', '{broken');
        expect(() => EconomicSourceSettings.choiceForCity('birmingham', global)).toThrow();
        global.localStorage.setItem('cb_economic_source:birmingham', JSON.stringify(descriptor('bad-rate', 'GBP', -1)));
        expect(() => EconomicSourceSettings.choiceForCity('birmingham', global)).toThrow(/rate, unit or basis/);
    });

    it('does not let imported rates impersonate a built-in provider', () => {
        const global = store();
        const city = { id: 'sample-city', currency: { code: 'GBP' } };
        expect(() => EconomicSourceSettings.saveChoice(city, descriptor('scenario-assumptions'), global)).toThrow(/identity/);
        expect(EconomicSourceSettings.choiceForCity(city.id, global)).toBeNull();
    });
});
