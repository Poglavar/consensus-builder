// The Plan Stats dialog is built and filled in two different places — a table of rows declares the
// slots, and the render fills them by name. Nothing connects the two but a matching string, and a
// slot that is declared and never filled shows a dash forever without anything failing.
//
// So the dialog's own wiring is pinned here, from the source: every declared slot is filled, every
// filled slot is declared, every input the dialog draws is read back, and every i18n key it asks
// for exists in all four locales. This is a browser-free check of a browser file; it does not
// replace looking at the dialog, but it makes the silent half of it loud.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const source = read('../../frontend/js/proposals/plan-stats.js');

const LOCALES = ['en', 'hr', 'sr', 'es'];
const dictionaries = Object.fromEntries(
    LOCALES.map(locale => [locale, JSON.parse(read(`../../frontend/i18n/${locale}.json`))])
);

function lookup(dictionary, dottedKey) {
    return dottedKey.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dictionary);
}

const matchAll = (re) => [...source.matchAll(re)].map(match => match[1]);

// Slots the dialog DRAWS: `key: 'resulting-parcels'` in the row/summary tables.
const declaredSlots = new Set(matchAll(/\bkey: '([a-z-]+)'/g));
// Slots the dialog FILLS: set('resulting-parcels', …) plus the two it addresses directly.
const filledSlots = new Set(matchAll(/\bset\('([a-z-]+)'/g));
// …and the ones addressed directly rather than through a row table, in either of the two ways a
// slot can be stamped onto an element.
const addressedSlots = new Set([
    ...matchAll(/data-plan-stat="([a-z-]+)"/g),
    ...matchAll(/dataset\.planStat = '([a-z-]+)'/g)
]);

describe('every slot the dialog draws is a slot it fills', () => {
    it('declares at least the figures the plan is opened for', () => {
        ['resulting-parcels', 'buildings', 'floor-area', 'apartments', 'people'].forEach(slot => {
            expect(declaredSlots, `missing summary row ${slot}`).toContain(slot);
        });
    });

    it('fills every declared slot', () => {
        [...declaredSlots].forEach(slot => {
            expect(filledSlots, `${slot} is drawn but never filled — it would read "—" forever`).toContain(slot);
        });
    });

    it('declares or addresses every slot it fills', () => {
        [...filledSlots].forEach(slot => {
            const known = declaredSlots.has(slot) || addressedSlots.has(slot);
            expect(known, `${slot} is filled but nothing in the dialog carries that name`).toBe(true);
        });
    });
});

describe('every input the dialog draws is read back', () => {
    // An input the user can change that nothing reads is worse than no input: it looks like it
    // works. Each id must appear both as an element id and in a querySelector.
    const inputIds = new Set(matchAll(/\bid: '(plan-stats-[a-z-]+)'/g));

    it('draws the assumptions the figures depend on', () => {
        ['plan-stats-housing-share', 'plan-stats-apartment-size', 'plan-stats-persons', 'plan-stats-efficiency']
            .forEach(id => expect(inputIds, `missing input ${id}`).toContain(id));
    });

    it('reads each of them', () => {
        [...inputIds, 'plan-stats-price'].forEach(id => {
            expect(source, `#${id} is drawn but never read`).toContain(`'#${id}'`);
        });
    });
});

describe('every i18n key the dialog asks for exists', () => {
    const keys = [...new Set(matchAll(/'(sidebar\.proposals\.planStats\.[A-Za-z]+)'/g))];

    it('asks for a reasonable number of them', () => {
        expect(keys.length).toBeGreaterThan(15);
    });

    it.each(LOCALES)('%s has all of them', locale => {
        const missing = keys.filter(key => typeof lookup(dictionaries[locale], key) !== 'string');
        expect(missing, `${locale} is missing: ${missing.join(', ')}`).toEqual([]);
    });

    it('leaves no key behind that nothing asks for', () => {
        const declared = Object.keys(lookup(dictionaries.en, 'sidebar.proposals.planStats') || {});
        const asked = new Set(keys.map(key => key.split('.').pop()));
        // buttonLabel and calculating live on the sidebar button in index.html, not in this file.
        const onTheButton = new Set(['buttonLabel', 'calculating']);
        const orphans = declared.filter(name => !asked.has(name) && !onTheButton.has(name));
        expect(orphans, `unused planStats strings: ${orphans.join(', ')}`).toEqual([]);
    });

    it('interpolates in the project form, so no placeholder ships as text', () => {
        ['scope', 'noteUnmeasured', 'noteParcelArea'].forEach(name => {
            LOCALES.forEach(locale => {
                const text = lookup(dictionaries[locale], `sidebar.proposals.planStats.${name}`);
                expect(text, `${locale}.${name}`).toMatch(/\{\{\w+\}\}/);
            });
        });
    });
});

describe('the dialog does not do its own arithmetic', () => {
    it('gets its figures from plan-yield', () => {
        expect(source).toContain('window.__planYield');
        expect(source).toMatch(/api\.planYield\(/);
        expect(source).toMatch(/api\.resultingParcels\(/);
    });

    it('no longer counts parcels off the map layer', () => {
        // The bug this replaced: the count came from ParcelsState.getParcelLayer(), so it only ever
        // saw what the current view had fetched — four parcels for a plan of 272 proposals.
        expect(source).not.toMatch(/getParcelLayer\s*\(/);
    });
});
