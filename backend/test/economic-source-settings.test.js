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

    it('uses workspace storage when available', () => {
        const global = store();
        const workspace = store().localStorage;
        global.BrowserWorkspace = { storage: workspace };
        const city = { id: 'birmingham', currency: { code: 'GBP' } };
        EconomicSourceSettings.saveChoice(city, descriptor('workspace-rates'), global);
        expect(global.localStorage.getItem('cb_economic_source:birmingham')).toBeNull();
        expect(EconomicSourceSettings.choiceForCity(city.id, global).id).toBe('workspace-rates');
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

describe('a local rent', () => {
    it('is saved and read back per city like any other rate', () => {
        const global = store();
        const city = { id: 'astana', currency: { code: 'KZT' } };
        EconomicSourceSettings.saveChoice(city, { version: 1, id: 'local-rates', name: 'My rents', adapter: 'rate-table',
            rates: [{ metric: 'rent', unit: 'm2-floor-month', amount: 5200, currency: 'KZT', basis: 'assumption' }] }, global);
        expect(EconomicSourceSettings.choiceForCity('astana', global).rates).toEqual([
            { metric: 'rent', unit: 'm2-floor-month', amount: 5200, currency: 'KZT', basis: 'assumption', asOf: null, scope: null }]);
    });

    it('keeps a construction cost\'s tax basis through storage', () => {
        const global = store();
        const city = { id: 'astana', currency: { code: 'KZT' } };
        EconomicSourceSettings.saveChoice(city, { version: 1, id: 'local-rates', name: 'My costs', adapter: 'rate-table',
            rates: [{ metric: 'construction', unit: 'm2-floor', amount: 320000, currency: 'KZT', basis: 'assumption', taxIncluded: true }] }, global);
        expect(EconomicSourceSettings.choiceForCity('astana', global).rates[0]).toMatchObject({ amount: 320000, taxIncluded: true });
    });
});

// A minimal DOM: elements with children, text and attributes, enough for renderSource.
function fakeElement(document, tag = 'p') {
    const node = { tagName: tag.toUpperCase(), ownerDocument: document, children: [], attributes: {},
        replaceChildren(...items) { this.children = []; this.append(...items); },
        append(...items) { this.children.push(...items.map(item => (typeof item === 'string' ? document.createTextNode(item) : item))); },
        get textContent() { return this.children.map(child => child.textContent).join(''); },
        set textContent(value) { this.children = [document.createTextNode(value)]; } };
    return node;
}
function fakeDocument() {
    const document = { createElement: tag => fakeElement(document, tag), createTextNode: text => ({ textContent: String(text) }) };
    return document;
}

describe('a rate\'s visible source', () => {
    const global = { i18n: { t: (key, params = {}) => ({ 'economicSources.sourceLabel': 'Source:', 'economicSources.assumption': 'Scenario assumption',
        'economicSources.policy-appraisal': 'Policy appraisal', 'economicSources.date': ` · as of ${params.date}` })[key] || key } };
    const row = { metric: 'land', amount: 5018, currency: 'GBP', basis: 'policy-appraisal', asOf: '2023-10-01', sourceId: 'uk-mhclg-land-2023',
        sourceName: 'MHCLG residential policy appraisal 2023', sourceUrl: 'https://example.org/land.xlsx', scope: 'E09000019 · Islington' };

    it('names the source, links its document and says where the rate is for, as text', () => {
        const note = EconomicSourceSettings.renderSource(fakeElement(fakeDocument()), row, global);
        expect(note.textContent).toBe('Source: MHCLG residential policy appraisal 2023 · Policy appraisal · as of 2023-10-01 · E09000019 · Islington');
        const link = note.children.find(child => child.tagName === 'A');
        expect(link).toMatchObject({ href: 'https://example.org/land.xlsx', target: '_blank', rel: 'noopener', textContent: row.sourceName });
    });

    it('says a price the visitor set is their assumption, and an assumption has no link', () => {
        expect(EconomicSourceSettings.renderSource(fakeElement(fakeDocument()), row, global, { set: true }).textContent).toBe('Source: Scenario assumption');
        const assumed = EconomicSourceSettings.renderSource(fakeElement(fakeDocument()), { ...row, sourceId: 'scenario-assumptions', sourceUrl: null }, global);
        expect(assumed.textContent).toBe('Source: Scenario assumption');
        expect(assumed.children.some(child => child.tagName === 'A')).toBe(false);
    });
});
