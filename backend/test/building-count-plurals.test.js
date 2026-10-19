// Exercise real locale lookup for building counts in editor summaries and obstacle prompts.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
function flatten(value, prefix = '', output = {}) {
    Object.entries(value).forEach(([key, child]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        if (child && typeof child === 'object') flatten(child, path, output);
        else output[path] = child;
    });
    return output;
}
async function translator(language) {
    const window = { location: { search: `?lang=${language}` }, navigator: { languages: [language] } };
    runInNewContext(read('../../frontend/js/i18n.js'), { window, Intl, URLSearchParams, console });
    for (const lang of ['en', 'es', 'hr', 'sr']) {
        window.i18n.registerTranslations(lang, flatten(JSON.parse(read(`../../frontend/i18n/${lang}.json`))));
    }
    await window.i18n.ready;
    window.i18n.setLanguage(language, { persist: false, apply: false });
    return window.i18n.t;
}
const noun = (language, count) => {
    if (language === 'en') return count === 1 ? 'building' : 'buildings';
    if (language === 'es') return count === 1 ? 'edificio' : 'edificios';
    return new Intl.PluralRules(language).select(count) === 'few' ? 'zgrade' : 'zgrada';
};

describe('building counts follow each active language', () => {
    for (const language of ['en', 'es', 'hr', 'sr']) {
        it(`${language}: summaries and comparisons select singular, few and plural`, async () => {
            const t = await translator(language);
            for (const count of [0, 1, 2, 5, 21]) {
                for (const key of ['proposalDrafts.design.buildingSummary', 'parcelCompare.buildings.count', 'blockify.modal.existing.summaryExact']) {
                    const text = t(key, { count, height: 12, typology: 'Block' });
                    expect(text).toContain(`${count} ${noun(language, count)}`);
                    expect(text).not.toMatch(/\(s\)|\{\{/);
                }
            }
        });
        it(`${language}: obstacle offers use the count, including one building`, async () => {
            const t = await translator(language);
            for (const count of [1, 2, 5]) {
                const expected = ['hr', 'sr'].includes(language) && count === 1 ? 'zgradu' : noun(language, count);
                const text = t('modal.corridorTunnel.offer', { count, kind: 'road' });
                expect(text).toContain(`${count} ${expected}`);
                expect(text).not.toMatch(/\(s\)|zgradu\/zgrada|\{\{/);
            }
        });
        it(`${language}: the existing-building total has its own plural count`, async () => {
            const t = await translator(language);
            const singular = t('blockify.modal.existing.summary', { count: 1, total: 1,
                existingBuildings: { key: 'blockify.modal.existing.buildingCount', count: 1 } });
            const plural = t('blockify.modal.existing.summary', { count: 1, total: 5,
                existingBuildings: { key: 'blockify.modal.existing.buildingCount', count: 5 } });
            expect(singular).not.toBe(plural);
            expect(singular).not.toMatch(/\{\{|blockify\./);
            expect(plural).not.toMatch(/\{\{|blockify\./);
            if (language === 'en') {
                expect(singular).toBe('Raising 1 of 1 existing building.');
                expect(plural).toBe('Raising 1 of 5 existing buildings.');
            }
        });
    }
});
