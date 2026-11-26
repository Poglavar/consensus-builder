// Guards the plural groups of every locale file (frontend/i18n/*.json): a group (an object whose keys
// are all CLDR plural categories) needs `other`, the form i18n.js falls back to within the language,
// and a group that splits its forms needs every form the language's Intl.PluralRules selects for a
// count. Plural groups used to be found from English `.other` keys, so a group without an English
// `other` (gameDialogs.log.actors.countActivity: one/many) was never checked and showed its raw key.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { testI18n } from './helpers/i18n.js';

const DIR = new URL('../../frontend/i18n/', import.meta.url);
const FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
const LANGS = readdirSync(DIR).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).sort();

// The categories a count selects. Counts are whole numbers; the Spanish, French and Portuguese `many`
// (whole millions) is left out: it falls back to `other`, which is the right form there.
function countForms(lang) {
    const rules = new Intl.PluralRules(lang);
    return new Set(Array.from({ length: 1001 }, (_, count) => rules.select(count)));
}

function pluralGroups(node, path = '', out = []) {
    if (!node || typeof node !== 'object') return out;
    const keys = Object.keys(node);
    if (keys.length && keys.every(key => FORMS.includes(key) && typeof node[key] === 'string')) out.push([path, keys]);
    else for (const key of keys) pluralGroups(node[key], path ? `${path}.${key}` : key, out);
    return out;
}

function pluralGaps(dictionary, lang) {
    const needed = [...countForms(lang)];
    return pluralGroups(dictionary).flatMap(([group, forms]) => {
        const missing = forms.length === 1 && forms[0] === 'other' ? [] : needed.filter(form => !forms.includes(form));
        if (!forms.includes('other') && !missing.includes('other')) missing.push('other');
        return missing.map(form => `${lang}: ${group}.${form}`);
    });
}

describe('plural groups', () => {
    it('finds a group that lacks other or a form its language selects', () => {
        const dictionary = { a: { one: '{{count}} x', many: '{{count}} xs' }, b: { other: '{{count}} x' }, c: { one: 'x', few: 'y', other: 'z' } };
        expect(pluralGaps(dictionary, 'en')).toEqual(['en: a.other']);
        expect(pluralGaps(dictionary, 'ru')).toEqual(['ru: a.few', 'ru: a.other', 'ru: c.many']);
        expect(pluralGaps({ d: { one: 'x', other: 'y' } }, 'ar')).toEqual(['ar: d.zero', 'ar: d.two', 'ar: d.few', 'ar: d.many']);
    });

    it.each(LANGS)('%s defines every plural form its counts select', lang => {
        const dictionary = JSON.parse(readFileSync(new URL(`${lang}.json`, DIR), 'utf8'));
        expect(pluralGroups(dictionary).length).toBeGreaterThan(50);
        expect(pluralGaps(dictionary, lang)).toEqual([]);
    });
});

describe('actor counts', () => {
    it.each([
        ['en', [[1, '1 activity'], [2, '2 activities'], [0, '0 activities']]],
        ['ru', [[1, '1 действие'], [2, '2 действия'], [5, '5 действий'], [21, '21 действие']]],
        ['hr', [[1, '1 sporazum'], [3, '3 sporazuma'], [5, '5 sporazuma']]]
    ])('%s picks the plural form from the count', (lang, cases) => {
        const api = testI18n(lang);
        const key = lang === 'hr' ? 'gameDialogs.log.actors.countAgreement' : 'gameDialogs.log.actors.countActivity';
        expect(cases.map(([count]) => api.t(key, { count }))).toEqual(cases.map(([, text]) => text));
    });
});
