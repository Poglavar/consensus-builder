// The getting-started hints: which one shows for which page state, and that the page wires them.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const Model = require('../../frontend/js/ui/first-design-guide-model.js');
const read = path => readFileSync(new URL(`../../frontend/${path}`, import.meta.url), 'utf8');

describe('first-design guide steps', () => {
    const step = facts => Model.step({ seen: false, created: false, classes: [], selectedKind: null, ...facts });

    it('leads a newcomer from the scene to the map, a parcel and a tool', () => {
        expect(step({ classes: ['three-mode-active'] })).toBe('open-map');
        expect(step({ classes: ['realistic-mode-active', 'three-click-stack-open'] })).toBe('open-map');
        expect(step({})).toBe('click-parcel');
        expect(step({ classes: ['click-stack-open'], selectedKind: 'designs' })).toBe('click-parcel');
        expect(step({ classes: ['click-stack-open'], selectedKind: 'parcels' })).toBe('pick-tool');
        expect(step({ classes: ['click-stack-open'], selectedKind: 'formed' })).toBe('pick-tool');
    });

    it('says nothing to a returning visitor until they author a design in a guided visit', () => {
        expect(step({ seen: true })).toBeNull();
        expect(step({ seen: true, classes: ['three-mode-active'] })).toBeNull();
        expect(step({ seen: true, created: true })).toBe('saved');
    });

    it.each(Model.QUIET)('stays out of the way while %s owns the screen', name => {
        expect(step({ classes: [name] })).toBeNull();
        expect(step({ classes: ['click-stack-open', name], selectedKind: 'parcels' })).toBeNull();
        expect(step({ created: true, classes: [name] })).toBeNull();
    });

    it('offers the map from a scene, the explainer on the map and 3D after a save', () => {
        expect(Model.actions('open-map')).toEqual(['open-map', 'how-it-works']);
        expect(Model.actions('click-parcel')).toEqual(['how-it-works']);
        expect(Model.actions('pick-tool')).toEqual([]);
        expect(Model.actions('saved')).toEqual(['see-3d']);
    });
});

describe('first-design guide wiring', () => {
    const ui = read('js/ui/first-design-guide.js');
    const locales = ['en', 'hr', 'sr', 'es', 'fr', 'pt', 'ar'];

    it('loads the model before the banner that reads it', () => {
        const index = read('index.html');
        const model = index.indexOf("'js/ui/first-design-guide-model.js'");
        expect(model).toBeGreaterThan(-1);
        expect(index.indexOf("'js/ui/first-design-guide.js'")).toBeGreaterThan(model);
        expect(index.indexOf("'js/ui/banner-stack.js'")).toBeLessThan(model);
    });

    it('has every hint, button and label in all seven languages', () => {
        const keys = [...ui.matchAll(/'(firstDesignGuide\.[a-zA-Z0-9]+)'/g)].map(match => match[1].split('.')[1]);
        expect(new Set(keys).size).toBe(7);
        for (const locale of locales) {
            const dictionary = JSON.parse(read(`i18n/${locale}.json`));
            for (const key of keys) expect(dictionary.firstDesignGuide[key], `${locale} ${key}`).toMatch(/\S/);
            expect(dictionary.world.welcome, `${locale} welcome`).toMatch(/\S/);
            expect(dictionary.threeMode.proposalPanel.parcelUnavailable, `${locale} parcelUnavailable`).toMatch(/\S/);
        }
    });

    it('uses the flag the returning-visitor browser fixtures seed', () => {
        expect(Model.SEEN_KEY).toBe('cb_site_intro_seen_v1');
        expect(readFileSync(new URL('../../e2e/helpers/fixtures.ts', import.meta.url), 'utf8')).toContain(`'${Model.SEEN_KEY}'`);
    });
});
