// How Permitted zones and envelopes read in the reader's language (frontend/js/planning/item-labels.js):
// translated names, the source's own wording kept apart, coded reasons and conditions, and colour keys.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const labels = require('../../frontend/js/planning/item-labels.js');
const en = require('../../frontend/i18n/en.json');

// The app's lookup: a dotted key in the English dictionary with {{params}}, else the key itself.
const t = (key, params = {}) => {
    const text = key.split('.').reduce((node, part) => node?.[part], en);
    return typeof text === 'string' ? text.replace(/{{(\w+)}}/g, (_, name) => String(params[name] ?? '')) : key;
};
const mid = { key: 'residential-mid', group: 'housing-mid', label: 'Среднеэтажная застройка', stage: 'planned' };
const zone = { role: 'permitted', title: 'Среднеэтажная застройка · до 5 эт. (6*) · проектируемая', use: mid,
    assessment: { meaning: 'zoning-area', status: 'allowed' },
    constraints: [{ quantity: 'storeys', value: 5 }], metrics: { conditional: { storeys: 6, condition: '6* этажей по легенде генплана', conditionCode: 'legend-asterisk' } } };
const envelope = { role: 'permitted', parcelEnvelope: true, title: 'Среднеэтажная застройка · до 5 эт. (6*) · проектируемая · 03055234792', use: mid,
    assessment: { meaning: 'outer-bound', status: 'unresolved' }, metrics: { conditional: { heightM: 18, condition: '6* этажей по легенде генплана', conditionCode: 'legend-asterisk' } } };

describe('names in the reader\'s language', () => {
    it('names a zone by its use, height class and stage, and keeps the plan\'s words apart', () => {
        expect(labels.title(zone, t)).toBe('Mid-rise housing (4–6 floors) · up to 5 floors (6 on a condition) · planned zone');
        expect(labels.sourceWording(zone, t)).toBe(zone.title);
    });

    it('names a parcel envelope by the use and stage of the zone it stands in', () => {
        expect(labels.title(envelope, t)).toBe('Mid-rise housing (4–6 floors) · planned zone');
        expect(labels.sourceWording(envelope, t)).toBe(envelope.title);
    });

    it('names a zone the plan leaves to another instrument by that, and an existing zone as existing', () => {
        const school = { ...zone, use: { key: 'education', group: 'public', label: 'Образование', stage: 'existing' }, constraints: [], metrics: {},
            assessment: { meaning: 'zoning-area', status: 'instrument_handoff' } };
        expect(labels.title(school, t, 'Another planning instrument applies')).toBe('Education · Another planning instrument applies · existing zone');
    });

    it('keeps the source\'s title, with no separate wording, for an item without a recorded use', () => {
        const plain = { role: 'permitted', parcelEnvelope: true, title: 'Max envelope · Synthetic source', assessment: { meaning: 'outer-bound' } };
        expect(labels.title(plain, t)).toBe(plain.title);
        expect(labels.sourceWording(plain, t)).toBeNull();
        // A use the app has no word for falls back to the plan's label, still with the translated stage.
        const unknown = { ...envelope, use: { key: 'unheard-of', group: null, label: 'Новая зона', stage: 'planned' } };
        expect(labels.title(unknown, t)).toBe('Новая зона · planned zone');
    });
});

describe('reasons and conditions', () => {
    it('translates a coded reason or condition, and flags uncoded source text to be quoted', () => {
        expect(labels.reason({ assessment: { reasonCode: 'detailed-plan', reason: 'Параметры … ПДП' } }, t))
            .toEqual({ text: t('planningViews.zoneReason.detailed-plan'), source: false });
        expect(labels.reason({ assessment: { reason: 'Rango de edificabilidad 3' } }, t)).toEqual({ text: 'Rango de edificabilidad 3', source: true });
        expect(labels.reason({ assessment: { reasonCode: 'unheard-of', reason: 'Текст' } }, t)).toEqual({ text: 'Текст', source: true });
        expect(labels.reason({ assessment: {} }, t)).toBeNull();
        expect(labels.condition(envelope.metrics.conditional, t)).toEqual({ text: t('planningViews.condition.legend-asterisk'), source: false });
    });

    it('has an English text for every code the Alatau provider writes', () => {
        for (const code of ['detailed-plan', 'above-12-floors', 'not-for-building', 'restricted-regime', 'reserve', 'agriculture', 'uninterpreted'])
            expect(en.planningViews.zoneReason[code], code).toEqual(expect.any(String));
        expect(en.planningViews.condition['legend-asterisk']).toEqual(expect.any(String));
        expect(Object.keys(en.planningViews.zoneStage).sort()).toEqual(['existing', 'planned']);
    });
});

describe('colour keys', () => {
    it('has a colour, a swatch and a name in every language for every use group', () => {
        const { readFileSync } = require('node:fs');
        const tokens = readFileSync(new URL('../../frontend/css/tokens.css', import.meta.url), 'utf8');
        const swatches = readFileSync(new URL('../../frontend/css/planning-views.css', import.meta.url), 'utf8');
        for (const group of labels.ZONE_GROUPS) {
            expect(tokens, group).toMatch(new RegExp(`--cb-planning-zone-${group}: #[0-9a-f]{6};`));
            expect(swatches, group).toContain(`.planning-swatch--zone-${group} { background: var(--cb-planning-zone-${group}); }`);
            for (const language of ['ar', 'en', 'es', 'fr', 'hr', 'pt', 'ru', 'sr'])
                expect(require(`../../frontend/i18n/${language}.json`).planningViews.useGroup[group], `${language} ${group}`).toEqual(expect.any(String));
        }
        // Mixed use and commercial follow housing in the legend; red is commercial, not high-rise housing.
        expect(labels.ZONE_GROUPS.slice(0, 7)).toEqual(['housing', 'housing-low', 'housing-mid', 'housing-high', 'mixed', 'commercial', 'public']);
        expect(tokens).toContain('--cb-planning-zone-commercial: #d62f3a;');
        expect(tokens).not.toContain('--cb-planning-zone-housing-high: #d62f3a;');
    });


    it('keys a zone by its use group, with the dashed edge when building is not allowed there', () => {
        expect(labels.colourKey(zone, t)).toEqual([{ swatch: 'zone-housing-mid', text: 'Mid-rise housing' }]);
        const park = { ...zone, use: { key: 'parks', group: 'green' }, assessment: { meaning: 'zoning-area', status: 'prohibited' } };
        expect(labels.colourKey(park, t).map(row => row.swatch)).toEqual(['zone-green', 'dashed']);
    });

    it('keys an envelope by the use of its land, or by the Permitted colour when the source states none', () => {
        expect(labels.colourKey(envelope, t)).toEqual([{ swatch: 'zone-housing-mid', text: 'Mid-rise housing' }]);
        const { use, ...plain } = envelope;
        expect(labels.colourKey(plain, t)).toEqual([{ swatch: 'permitted', text: t('planningViews.legend.envelope') }]);
        expect(labels.colourKey({ ...envelope, use: { key: 'x', group: 'not-a-group' } }, t).map(row => row.swatch)).toEqual(['permitted']);
        expect(labels.colourKey({ role: 'existing' }, t)).toEqual([]);
    });

    it('draws a zoning area and the massing on it in the colour of their use, anything else in its role colour', () => {
        expect(labels.colourRole(zone)).toBe('zone-housing-mid');
        expect(labels.colourRole(envelope)).toBe('zone-housing-mid');
        const { use, ...plain } = envelope;
        expect(labels.colourRole(plain)).toBe('permitted');
        expect(labels.colourRole({ ...envelope, use: { key: 'x', group: 'not-a-group' } })).toBe('permitted');
        // A use on a building or a design is not a zoning use: the role colour stays.
        expect(labels.colourRole({ role: 'existing', use: { group: 'housing-mid' } })).toBe('existing');
        expect(labels.colourRole({ role: 'proposed', use: { group: 'housing-mid' } })).toBe('proposed');
    });

    it('lists the colours drawn: envelopes, zone groups in legend order, then dashed edges', () => {
        const park = { ...zone, use: { key: 'parks', group: 'green' }, assessment: { meaning: 'zoning-area', status: 'prohibited' } };
        const tall = { ...zone, use: { key: 'residential-high', group: 'housing-high' } };
        expect(labels.legend([park, tall, envelope, zone], t).map(row => row.swatch))
            .toEqual(['zone-housing-mid', 'zone-housing-high', 'zone-green', 'dashed']);
        // An envelope lists its use group though no zoning area is drawn; one with no stated use lists the Permitted colour.
        expect(labels.legend([envelope], t).map(row => row.swatch)).toEqual(['zone-housing-mid']);
        const { use, ...plain } = envelope;
        expect(labels.legend([plain, envelope, tall], t).map(row => row.swatch)).toEqual(['permitted', 'zone-housing-mid', 'zone-housing-high']);
        expect(labels.legend([zone], t).map(row => row.swatch)).toEqual(['zone-housing-mid']);
        expect(labels.legend([], t)).toEqual([]);
    });
});
