// Location signals read from posting text: street mentions with inflection, numbers, pins, permits, parcels.
import { describe, expect, it } from 'vitest';
import { buildStreetIndex, findStreets, fold, hasLocationSignal, listingSignals } from '../floor-plans/site-signals.js';

const index = buildStreetIndex(['Jurišićeva ulica', 'Strojarska cesta', 'Avenija Marina Držića', 'Ilica', 'Ulica grada Vukovara', 'Ravna ulica', 'Trg Eugena Kvaternika']);

describe('street mentions', () => {
    it('folds diacritics and case', () => {
        expect(fold('Držića, Đurđevac  ŠKOLA')).toBe('drzica durdevac skola');
    });

    it('finds inflected street names and the house number that follows', () => {
        expect(findStreets('Stan se nalazi u Jurišićevoj ulici 26, prvi kat.', index)).toEqual([
            { street: 'Jurišićeva ulica', number: '26', quote: 'Jurišićevoj ulici 26' }]);
        expect(findStreets('Zagreb, Trnje, Avenija Marina Držića, moderan projekt', index).map(s => [s.street, s.number]))
            .toEqual([['Avenija Marina Držića', null]]);
        expect(findStreets('Projekt na Strojarskoj, kod Vukovarske', index).map(s => s.street)).toEqual(['Strojarska cesta']);
        expect(findStreets('Ilica 10/1', index)[0]).toMatchObject({ street: 'Ilica', number: '10/1' });
    });

    it('ignores common words and names outside street context, and years after a name', () => {
        const noisy = buildStreetIndex(['Glavna ulica', 'Davor', 'Hrastik', 'Ulica Viktora Kovačića']);
        expect(findStreets('Glavna dvorana je obnovljena. Arhitekt Davor radio je pod hrastom.', noisy)).toEqual([]);
        expect(findStreets('Projekt: Viktor Kovačić 2019.', noisy)).toEqual([]);
        expect(findStreets('Stan je u Glavnoj ulici 4.', noisy)).toMatchObject([{ street: 'Glavna ulica', number: '4' }]);
    });

    it('drops generic-only and very short single-word names from the index', () => {
        expect(buildStreetIndex(['Ulica', 'Put', 'Ravna ulica']).map(s => s.name)).toEqual(['Ravna ulica']);
        expect(buildStreetIndex(['Sava']).length).toBe(0);
        expect(buildStreetIndex(['Sv. Duh']).map(s => s.tokens)).toEqual([['sv', 'duh']]);
    });
});

describe('listing signals', () => {
    it('collects pin, permit KLASA, parcel numbers, units, storeys and new-build wording', () => {
        const signals = listingSignals({
            title: 'Zagreb, Trnje, novogradnja',
            text: 'Moderan stambeni projekt sa 20 stambenih jedinica, P+4. Građevinska dozvola KLASA: UP/I-361-03/24-01/000607, k.č. 381/1 i 381/4.',
            facts: { coordinates: { lat: 45.801, lng: 15.989 }, locality: 'Zagreb' }, streetIndex: index,
        });
        expect(signals).toMatchObject({ pin: { lat: 45.801, lng: 15.989 }, klasa: ['UP/I-361-03/24-01/000607'],
            parcels: ['381/1', '381/4'], units: 20, floors: 'P+4', newBuild: true, locality: 'Zagreb' });
        expect(hasLocationSignal(signals)).toBe(true);
    });

    it('puts the explicit address first and keeps a bare street separately', () => {
        const signals = listingSignals({
            facts: { explicitLocation: { schema: 'explicit-listing-location.v1', street: 'Ilica', houseNumber: '10/1', quote: 'Ilica 10/ 1' } },
            text: 'Projekt uz Ulicu grada Vukovara.', streetIndex: index,
        });
        expect(signals.addresses).toEqual([{ street: 'Ilica', number: '10/1', quote: 'Ilica 10/ 1', basis: 'explicit-location' }]);
        expect(signals.streets.map(s => s.street)).toEqual(['Ulica grada Vukovara']);
    });

    it('reads street names in the title location slot without further context', () => {
        const signals = listingSignals({ title: 'Zagreb, Strojarska - Vukovarska, AVENUE V - ekskluzivan projekt', text: 'Trosoban stan.',
            streetIndex: buildStreetIndex(['Strojarska cesta', 'Vukovarska ulica', 'Ulica grada Vukovara']) });
        expect(signals.streets.map(s => s.street)).toEqual(expect.arrayContaining(['Strojarska cesta']));
        expect(listingSignals({ title: 'Stan', text: 'Strojarska tvrtka gradi.', streetIndex: buildStreetIndex(['Strojarska cesta']) }).streets).toEqual([]);
    });

    it('treats a missing pin as absent, never 0,0, and a neighbourhood-only ad as having no signal', () => {
        const signals = listingSignals({ title: 'Stan, Zagreb, Trešnjevka', facts: { coordinates: { lat: null, lng: 15.9 } }, streetIndex: index });
        expect(signals.pin).toBeNull();
        expect(hasLocationSignal(signals)).toBe(false);
    });
});

describe('house-number variants for the official register', () => {
    it('keeps the exact form and offers the base number for letters and courtyard slashes', async () => {
        const { numberVariants } = await import('../floor-plans/site-candidates.js');
        expect(numberVariants('29A')).toEqual({ exact: ['29a'], loose: ['29'] });
        expect(numberVariants('10/1')).toEqual({ exact: ['10/1'], loose: ['10'] });
        expect(numberVariants('19')).toEqual({ exact: ['19'], loose: [] });
    });

    it('expands a short range and keeps only the ends of a long one', async () => {
        const { numberVariants } = await import('../floor-plans/site-candidates.js');
        expect(numberVariants('141-145').loose).toEqual(['141', '142', '143', '144', '145']);
        expect(numberVariants('1-99').loose).toEqual(['1', '99']);
        expect(numberVariants('')).toEqual({ exact: [], loose: [] });
    });
});
